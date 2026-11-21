import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createPathFilter, createRedactor } from './secrets.mjs';

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Hechos del transcript desde la marca de agua anterior. */
export function transcriptFacts(path, offset = 0, config = null, budget = null, previousCommands = []) {
  const res = { commands: previousCommands.slice(-12).map((command) => ({ ...command })), filesRead: [], lastMessage: null, offset, turns: 0, redactions: 0 };
  if (!path) return res;
  if (budget?.expired()) return { ...res, trimmed: true };

  const chunk = readTranscriptChunk(path, offset);
  if (!chunk) return res;
  const { buffer, from, trimmed, reset } = chunk;
  if (reset) {
    res.commands = [];
    res.reset = true;
  }
  if (trimmed) res.trimmed = true;
  res.offset = from;
  if (!buffer.length) return res;

  const redact = createRedactor(config);
  const lookup = {
    redactCommand(command) {
      const { texto, redactions } = redact(meaningfulLine(command));
      res.redactions += redactions;
      return texto;
    },
    isExcluded: createPathFilter(config),
    pending: [],
    previousCount: res.commands.length,
    byId: new Map(res.commands.filter(({ id }) => id != null).map((command) => [command.id, command])),
  };
  let cursor = 0;
  for (let records = 0; cursor < buffer.length; records++) {
    // Un transcript con muchas llamadas puede gastar el presupuesto en
    // parseo. Se reanuda desde el siguiente registro completo.
    if (records % 64 === 0 && budget?.expired()) {
      res.trimmed = true;
      break;
    }
    const newline = buffer.indexOf(0x0a, cursor);
    const end = newline === -1 ? buffer.length : newline;
    const line = buffer.toString('utf8', cursor, end);
    let event;
    if (line.trim()) {
      try { event = JSON.parse(line); }
      catch {
        // Conserva la línea final si el productor aún la está escribiendo.
        if (newline === -1) break;
      }
    }
    if (event && typeof event === 'object' && !Array.isArray(event)) extract(event, res, lookup);
    cursor = newline === -1 ? end : end + 1;
  }
  res.offset = from + cursor;

  res.commands = res.commands.slice(-12);
  res.filesRead = [...new Set(res.filesRead)].slice(-15);
  return res;
}

function readTranscriptChunk(path, offset) {
  try {
    // Tamaño y lectura del mismo descriptor: si el transcript se reemplaza
    // entre ambas operaciones, no se mezclan versiones del archivo.
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const reset = offset > size;
      const start = Number.isSafeInteger(offset) && offset >= 0 && !reset ? offset : 0;
      const from = Math.max(start, size - MAX_TRANSCRIPT_BYTES);
      const buffer = Buffer.allocUnsafe(size - from);
      const read = buffer.length ? readSync(fd, buffer, 0, buffer.length, from) : 0;
      return { buffer: buffer.subarray(0, read), from, trimmed: from > start, reset };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Extrae de un event del transcript. Defensivo a propósito: cada CLI tiene
 * su propia forma y ninguno prometió mantenerla entre versiones. Ante un
 * formato desconocido se ignora el event en lugar de fallar.
 */
function extract(ev, res, lookup) {
  // Antigravity: pasos con step_index, type y content en texto plano.
  if (ev.step_index !== undefined || ev.stepIndex !== undefined) {
    return extractStep(ev, res, lookup);
  }
  // Codex: wrapper {timestamp, ordinal, type, payload}.
  if (ev.payload !== undefined && ev.ordinal !== undefined) {
    return extractRollout(ev, res, lookup);
  }

  const kind = ev.type ?? ev.role ?? ev.kind;
  // Un turno es un mensaje del usuario, no cualquier línea. Antes se contaba
  // toda línea `user` o `assistant`, y en Claude Code cada llamada a una
  // herramienta agrega dos (el uso y su resultado, que viaja como `user`):
  // una conversación real tenía 1.220 «turnos» y 34 mensajes del usuario. Con
  // eso, «van 8 turnos» eran dos o tres mensajes y la narrativa se pedía
  // mucho más seguido de lo diseñado. Codex (task_started) y agy (USER_INPUT)
  // ya contaban mensajes; ahora Claude Code también.
  if (kind === 'user' && isUserPrompt(ev)) res.turns++;

  const bloques = [];
  const msg = ev.message ?? ev;
  if (Array.isArray(msg?.content)) bloques.push(...msg.content);
  else if (Array.isArray(ev.content)) bloques.push(...ev.content);

  for (const b of bloques) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'tool_use' && b.name) {
      const inp = b.input ?? {};
      if (/^bash$|^shell$|^run/i.test(b.name) && inp.command) {
        const texto = lookup.redactCommand(String(inp.command));
        recordCommand(res, lookup.byId, { cmd: texto, id: b.id, exit: null });
      } else if (/^read$|^view$/i.test(b.name) && (inp.file_path ?? inp.path)) {
        const r = String(inp.file_path ?? inp.path);
        if (!lookup.isExcluded(r)) res.filesRead.push(r);
      }
    }

    // Resultado del comando: se busca el exit code, nunca el stdout.
    if (b.type === 'tool_result') {
      const c = lookup.byId.get(b.tool_use_id);
      if (c) c.exit = b.is_error ? 1 : exitFrom(b) ?? 0;
    }

    if (b.type === 'text' && typeof b.text === 'string' && kind === 'assistant') {
      res.lastMessage = b.text;
    }
  }

  if (typeof ev.last_assistant_message === 'string') res.lastMessage = ev.last_assistant_message;
}

/**
 * Un paso del transcript de Antigravity.
 *
 * Formato verificado contra sesiones reales: cada línea es un paso con
 * step_index, source, type, status, created_at y content. En el formato actual
 * las llamadas a herramientas viajan en `tool_calls` de `PLANNER_RESPONSE` y
 * sus salidas llegan en los pasos `GENERIC` siguientes, en el mismo orden.
 * También se conserva el formato anterior de pasos `RUN_COMMAND` / `VIEW_FILE`.
 */
function extractStep(ev, res, { pending, previousCount, redactCommand, isExcluded }) {
  const kind = String(ev.type ?? '').toUpperCase();
  const contenido = typeof ev.content === 'string' ? ev.content : '';
  const stepIndex = ev.step_index ?? ev.stepIndex ?? null;

  // Cada turno del usuario empieza en USER_INPUT; dentro de un mismo turno hay
  // un PLANNER_RESPONSE por cada ronda de herramientas más la respuesta final,
  // así que sumarlos infla el contador y adelanta la petición de narrativa.
  if (kind === 'USER_INPUT') {
    res.turns++;
    pending.length = 0;
  }

  if (kind === 'PLANNER_RESPONSE') {
    pending.length = 0;
    if (contenido) res.lastMessage = contenido;
    const calls = ev.tool_calls ?? ev.toolCalls;
    if (Array.isArray(calls)) {
      calls.forEach((call, index) => {
        const name = String(call?.name ?? '');
        const args = stepToolArgs(call);
        if (/^(run_command|bash|shell|exec_command)$/i.test(name)) {
          const rawCmd = unwrapJsonString(args.CommandLine ?? args.command ?? args.cmd ?? '');
          const texto = redactCommand(rawCmd);
          if (texto) {
            const id = call?.id ?? (stepIndex !== null ? `${stepIndex}:${index}` : null);
            const command = { cmd: texto, id, exit: null };
            res.commands.push(command);
            pending.push({ kind: 'command', command });
            return;
          }
        } else if (/^(read_file|view_file|read|view)$/i.test(name)) {
          const rawPath = unwrapJsonString(
            args.Path ?? args.AbsolutePath ?? args.file_path ?? args.path ?? args.file ?? '',
          ).trim();
          if (rawPath && !isExcluded(rawPath)) res.filesRead.push(rawPath);
        }
        pending.push({ kind: 'other' });
      });
    }
    return;
  }

  if (kind === 'GENERIC') {
    const next = pending.shift() ?? null;
    if (next) {
      if (next.kind !== 'command') return;
      const exit = stepCommandExit(ev, contenido);
      if (exit !== null) next.command.exit = exit;
      return;
    }
    // Si la lectura incremental arrancó después del PLANNER_RESPONSE, solo una
    // cabecera explícita de comando confirma el código de salida.
    const exit = stepHeaderExit(contenido);
    const unresolved = exit !== null ? res.commands.find((c, index) => index >= previousCount && c.exit === null) : null;
    if (unresolved) unresolved.exit = exit;
    return;
  }

  if (/RUN_COMMAND|COMMAND|TERMINAL/.test(kind)) {
    // El comando aparece como CommandLine en el contenido, o como primera
    // línea útil si viene en texto libre.
    const m = /"?CommandLine"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    const bruto = m ? m[1] : contenido;
    const texto = redactCommand(bruto);
    if (texto) {
      const fallo = /FAILED|ERROR/.test(String(ev.status ?? '')) || /exit (?:code )?[1-9]/i.test(contenido);
      res.commands.push({ cmd: texto, id: stepIndex, exit: fallo ? 1 : 0 });
    }
  }

  if (/VIEW_FILE|READ_FILE/.test(kind)) {
    const m = /"?(?:AbsolutePath|path|file)"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    if (m && !isExcluded(m[1])) res.filesRead.push(m[1].trim());
  }
}

function stepToolArgs(call) {
  let args = call?.args ?? call?.arguments ?? call?.input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return {}; }
  }
  return (args && typeof args === 'object') ? args : {};
}

function unwrapJsonString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

function stepHeaderExit(contenido) {
  // Solo la cabecera previa a "Command output:" pertenece al runner; el stdout
  // del proceso puede contener líneas con el mismo texto.
  const header = contenido.split(/\r?\n\r?\nCommand output:\r?\n/)[0];
  const match = /^Command exited with code (-?\d+)\.\s*$/m.exec(header);
  return match ? Number(match[1]) : null;
}

function stepCommandExit(ev, contenido) {
  const exit = stepHeaderExit(contenido);
  if (exit !== null) return exit;
  const header = contenido.split(/\r?\n\r?\nCommand output:\r?\n/)[0];
  if (/^(FAILED|ERROR)$/i.test(String(ev.status ?? ''))) return 1;
  if (/^Encountered error in (?:step|tool) execution:/m.test(header)) return 1;
  return null;
}

/**
 * Un registro del rollout de Codex.
 *
 * Formato verificado contra una sesión real: cada línea envuelve un payload
 * en {timestamp, ordinal, type, payload}. Los tipos que informan son
 * `response_item` (mensajes y llamadas a herramientas) y `event_msg`
 * (task_started, item_completed, task_complete).
 */
function extractRollout(ev, res, { byId, redactCommand }) {
  const p = ev.payload ?? {};
  const kind = String(p.type ?? '');

  if (ev.type === 'event_msg' && kind === 'task_started') res.turns++;

  if (ev.type === 'event_msg' && kind === 'task_complete' && p.last_agent_message) {
    res.lastMessage = String(p.last_agent_message);
  }

  if (ev.type === 'response_item' && kind === 'message') {
    // Un turno puede incluir usuario, comentarios y respuesta final. Su inicio
    // ya se contó con task_started; sumarlos adelanta la petición de narrativa.
    if (p.role === 'assistant') {
      const txt = textFrom(p.content);
      if (txt) res.lastMessage = txt;
    }
  }

  if (kind === 'function_call_output') {
    const command = byId.get(p.call_id);
    const exit = rolloutResultExit(p.output);
    if (command && exit !== null) command.exit = exit;
    return;
  }

  // Code mode usa una herramienta llamada exec que ejecuta JavaScript, no un
  // comando de shell. Sus procesos reales llegan como CommandExecution.
  const item = kind === 'item_completed' ? (p.item ?? {}) : p;
  const name = String(item.name ?? item.type ?? '');
  const execution = /^(CommandExecution|command_execution|local_shell_call)$/i.test(item.type ?? '');
  if (!execution && !/(?:^|\.)(exec_command|shell_command|shell|bash|run_command)$/i.test(name)) return;

  const line = rolloutCommand(item);
  if (!line) return;
  const texto = redactCommand(line);
  if (!texto) return;
  const id = item.call_id ?? item.id ?? ev.ordinal;
  const exit = Number.isInteger(item.exit_code) ? item.exit_code
    : execution && !('exit_code' in item)
      ? (/error|fail/i.test(item.status ?? '') ? 1 : item.status === 'completed' ? 0 : null)
      : null;
  const previous = byId.get(id);
  if (previous) {
    previous.cmd = texto;
    if (exit !== null) previous.exit = exit;
  } else {
    // Una llamada generada todavía no es un resultado: sin confirmación,
    // queda desconocido. Antes se escribía exit 0 por defecto.
    recordCommand(res, byId, { cmd: texto, id, exit });
  }
}

function recordCommand(res, byId, command) {
  res.commands.push(command);
  if (command.id != null) byId.set(command.id, command);
}

function rolloutCommand(item) {
  let args = item.arguments ?? item.input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  const command = args?.cmd ?? args?.command ?? item.command;
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || !command.every((arg) => typeof arg === 'string')) return null;

  // Windows registra el intérprete y sus flags como argv. El script es lo
  // que informa; serializar todo el array oculta el comando entre escapes.
  const executable = (command[0] ?? '').split(/[\\/]/).pop();
  const flag = /^(powershell|pwsh)(\.exe)?$/i.test(executable) ? /^-(command|c)$/i
    : /^cmd(\.exe)?$/i.test(executable) ? /^\/c$/i
      : /^(ba|da|z|k)?sh(\.exe)?$/i.test(executable) ? /^-[a-z]*c[a-z]*$/i : null;
  const at = flag ? command.findIndex((arg, i) => i > 0 && flag.test(arg)) : -1;
  return (at >= 0 ? command.slice(at + 1) : command).join(' ');
}

function rolloutResultExit(output) {
  let result = output;
  if (typeof output === 'string') {
    try { result = JSON.parse(output); } catch {}
  }
  if (result && typeof result === 'object') {
    return Number.isInteger(result.exit_code) ? result.exit_code : null;
  }
  if (typeof output !== 'string') return null;
  // El stdout puede contener ejemplos de códigos de salida. Solo la cabecera
  // generada por la herramienta confirma cómo terminó el proceso.
  const header = output.split(/^Output:\s*$/m)[0];
  const match = /^Process exited with code (-?\d+)\s*$/m.exec(header);
  return match ? Number(match[1]) : null;
}

function textFrom(contenido) {
  if (typeof contenido === 'string') return contenido;
  if (!Array.isArray(contenido)) return null;
  for (const b of contenido) {
    if (typeof b === 'string') return b;
    if (b && typeof b.text === 'string') return b.text;
  }
  return null;
}

function exitFrom(b) {
  const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
  const m = /exit (?:code|status)[: ]+(\d+)/i.exec(txt);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * De un comando de varias líneas, la que dice qué se hizo.
 * Tomar la primera línea a secas dejaba el relevo lleno de `cd ...` y
 * `set -e`, que no informan nada de lo que pasó en la sesión.
 */
function meaningfulLine(comando) {
  const RUIDO = /^\s*(cd\s|set\s+-|export\s|source\s|\.\s|#|echo\s+"?===|if\s|fi$|then$|else$|done$|do$)/i;
  const lineas = comando.split('\n').map((l) => l.trim()).filter(Boolean);
  const util = lineas.find((l) => !RUIDO.test(l));
  let elegida = util ?? lineas[0] ?? '';
  // `cd <ruta> && comando` es el patrón más común de todos: lo que informa
  // es el comando, no el directorio.
  elegida = elegida.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i, '');
  return elegida.slice(0, 160);
}

/**
 * ¿Esta línea `user` de un transcript de Claude Code es un mensaje escrito por
 * el usuario? No lo son los resultados de herramientas (`tool_result`, con
 * `toolUseResult`) ni las líneas de metadatos (`isMeta`).
 */
function isUserPrompt(ev) {
  if (ev?.isMeta || ev?.toolUseResult) return false;
  const c = ev?.message?.content ?? ev?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
}
