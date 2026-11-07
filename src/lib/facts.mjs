// Capa de facts: todo lo que se puede derivar de git y del transcript sin
// llamar a ningún modelo. Cero tokens, milisegundos, y exacto por construcción.
//
// Invariante del proyecto: el modelo NO puede escribir en estos campos.
// El estado de los tests sale del exit code y de ningún otro lado.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { git, currentBranch } from './paths.mjs';
import { isExcludedPath, redact } from './secrets.mjs';
import { hasTime } from './budget.mjs';

// Costo de `diff --numstat` por archivo modificado, calibrado contra git
// real: 1.000/5.000/10.000 archivos sin commitear tardaron ~0,45 ms/archivo
// de forma consistente en el caso de prueba (ver docs/auditoria-2026-11.md).
// Se usa 0,6 con un piso fijo para quedar con margen sin ser tan conservador
// que un turno de 1.000 archivos —un `prettier --write` normal— pierda el
// detalle que sí le cabe en el presupuesto.
const MS_BASE_NUMSTAT = 30;
const MS_POR_ARCHIVO_NUMSTAT = 0.6;
// Lo que se reserva después de numstat para upstream, render, sign y las dos
// escrituras atómicas. Medido: ese resto cuesta decenas de ms, no cientos;
// 200 ms es margen generoso, no ajustado al límite.
const RESERVA_DESPUES_DE_NUMSTAT_MS = 200;

/** Hechos de git: rama, archivos sin commitear, diff y divergencia con upstream. */
export function gitFacts(cwd, config, budget = null) {
  const h = {
    branch: currentBranch(cwd, budget), isRepo: false, dirty: [], commits: [], upstream: null,
    trimmed: [],
  };
  if (h.branch === null) return h;
  h.isRepo = true;

  // status --porcelain es la fuente PRIMARIA, no numstat. Antes era al
  // revés, y eso es justo el defecto: numstat calcula diff real por archivo
  // y con miles de archivos sin commitear tarda segundos (medido: ~4,5 s con
  // 10.000, contra ~0,1 s de status --porcelain sobre el mismo árbol), más
  // que el presupuesto entero del hook. status ya trae todo lo que el relevo
  // necesita para la lista y el total — rama, ruta, si es nuevo, incluso
  // renombres (`viejo -> nuevo`) — y numstat solo agrega el detalle de
  // líneas +/-, que es justamente lo que un relevo con miles de archivos no
  // necesita mostrar.
  //
  // El parseo NO usa columnas fijas: el stdout llega sin el espacio inicial de
  // la primera línea, así que un slice(3) cortaría un carácter del name.
  //
  // Si no queda presupuesto ni para ESTE llamado, no hay que confundir "no lo
  // sabemos" con "está limpio": sin status no hay con qué decir que el árbol
  // está limpio, y afirmarlo sería mentir. Por eso se distingue null (no se
  // pudo pedir) de '' (se pidió y no hay nada sucio) en vez de usar `?? ''`
  // como hacían todas las llamadas de esta función en la versión anterior.
  const status = hasTime(budget, 100) ? git(cwd, ['status', '--porcelain'], { budget }) : null;
  const porArchivo = new Map();
  if (status !== null) {
    for (const linea of status.split('\n')) {
      const m = /^\s*(\S{1,2})\s+(.+?)\s*$/.exec(linea);
      if (!m) continue;
      const ruta = m[2].replace(/^"|"$/g, '').split(' -> ').pop();
      if (!ruta || isExcludedPath(ruta, config)) continue;
      porArchivo.set(ruta, { ruta, mas: null, menos: null, nuevo: m[1].includes('?') });
    }
  } else {
    h.dirtyUnknown = true;
    h.trimmed.push(
      'lista de archivos sin commitear: se omitió "git status --porcelain" por presupuesto de tiempo '
      + '-- no se puede afirmar que el árbol está limpio, solo que no se comprobó',
    );
  }

  // Últimos commits: barato (cinco líneas fijas) y de alto valor — el relevo
  // nuevo necesita saber qué ya quedó cerrado. Va antes de numstat a
  // propósito: es justo el tipo de paso que SÍ debe sobrevivir un recorte.
  if (hasTime(budget)) {
    const log = git(cwd, ['log', '-5', '--format=%h %s'], { budget }) ?? '';
    h.commits = log.split('\n').filter(Boolean);
  } else {
    h.trimmed.push('últimos commits: se omitió, no quedaba presupuesto de tiempo');
  }

  // El detalle +/- por archivo (numstat) es el paso caro y de bajo valor
  // informativo cuando hay miles de archivos: el relevo solo lista 20 y el
  // total aparte, así que el detalle de los otros 9.980 no aporta nada. Se
  // omite si no cabe en lo que queda del presupuesto — y si se omite, el
  // archivo no desaparece del relevo: sigue viniendo de status, solo que sin
  // el "+X -Y".
  const estimadoNumstat = MS_BASE_NUMSTAT + porArchivo.size * MS_POR_ARCHIVO_NUMSTAT;
  const alcanza = porArchivo.size > 0
    && hasTime(budget, estimadoNumstat + RESERVA_DESPUES_DE_NUMSTAT_MS);

  let numstatOk = porArchivo.size === 0; // nada que enriquecer: no es un recorte
  if (alcanza) {
    const numstat = git(cwd, ['diff', 'HEAD', '--numstat'], { budget });
    // `null` es "no corrió" (timeout, presupuesto, repo sin HEAD); `''` es
    // "corrió y no hay nada que informar", que es el caso NORMAL cuando todo
    // lo sucio está sin seguimiento: numstat no lista archivos untracked.
    // Tratar los dos igual hacía que el relevo declarara un recorte que nunca
    // ocurrió — la misma clase de mentira que el recorte vino a evitar, en la
    // dirección contraria.
    if (numstat !== null) {
      numstatOk = true;
      for (const linea of numstat.split('\n').filter(Boolean)) {
        const [mas, menos, bruto] = linea.split('\t');
        const ruta = renameTarget(bruto);
        if (!ruta || isExcludedPath(ruta, config)) continue;
        const previo = porArchivo.get(ruta);
        porArchivo.set(ruta, { ruta, mas: num(mas), menos: num(menos), nuevo: previo?.nuevo ?? false });
      }
    }
  }
  if (!numstatOk) {
    h.trimmed.push(
      `detalle de líneas +/- de los ${porArchivo.size} archivo(s) sin commitear: se omitió, no quedaba `
      + 'presupuesto de tiempo para "git diff --numstat" (la lista de archivos y el total siguen completos)',
    );
  }

  // Tope deliberado. El relevo muestra 20, pero el estado guardaba todos: en
  // un repo con miles de archivos dirty —tras un `npm install` sin
  // gitignore, o al generar código— el estado.json pasaba del megabyte y se
  // reescribía completo en cada turno. Se guarda un margen sobre lo que se
  // muestra y el total aparte, que es lo único que el relevo necesita.
  const todos = [...porArchivo.values()];
  h.dirty = todos.slice(0, 50);
  h.dirtyTotal = todos.length;

  // Divergencia con upstream: la más cara de las tres cadenas (hasta 3
  // subprocesos) y la de menor prioridad de las cuatro — va último.
  if (hasTime(budget, 150)) {
    h.upstream = upstreamDivergence(cwd, h.dirty.map((s) => s.ruta), budget);
  } else {
    h.trimmed.push('divergencia con upstream: se omitió, no quedaba presupuesto de tiempo');
  }

  return h;
}

/**
 * Qué hicieron los demás en los archivos que estás tocando.
 * Sale de la información que git ya tiene local: no hace fetch, no usa red.
 */
function upstreamDivergence(cwd, misArchivos, budget = null) {
  const up = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { budget });
  if (!up) return null;
  if (!hasTime(budget)) return null;

  const cuenta = git(cwd, ['rev-list', '--count', `HEAD..${up}`], { budget });
  const ahead = parseInt(cuenta ?? '0', 10) || 0;
  if (ahead === 0) return { ref: up, ahead: 0, collisions: [] };
  if (!hasTime(budget)) return { ref: up, ahead, collisions: [] };

  const tocados = git(cwd, ['diff', '--name-only', `HEAD..${up}`], { budget }) ?? '';
  const suyos = new Set(tocados.split('\n').filter(Boolean));
  const collisions = misArchivos.filter((r) => suyos.has(r));
  return { ref: up, ahead, collisions };
}

/**
 * Comandos ejecutados y su resultado, leídos del transcript desde la marca de
 * agua anterior. Solo se lee el delta: el costo no crece con la sesión.
 */
export function transcriptFacts(rutaTranscript, desdeOffset = 0, config = null, budget = null) {
  const res = { commands: [], filesRead: [], lastMessage: null, offset: desdeOffset, turns: 0 };
  if (!rutaTranscript) return res;
  // Medido: hasta 8 MB (el techo de MAX más abajo) tarda ~35-40 ms, muy por
  // debajo de cualquier presupuesto razonable. No necesita cortes internos;
  // esta única guarda es para el caso en que algo ANTES ya agotó el reloj.
  if (budget?.expired()) return res;

  let bruto;
  try {
    const st = statSync(rutaTranscript);
    // Si el archivo se truncó o rotó, se relee desde el principio.
    const inicio = desdeOffset > st.size ? 0 : desdeOffset;
    const largo = st.size - inicio;
    res.offset = st.size;
    if (largo <= 0) return res;

    // Techo de lectura: un transcript enorme no puede hacernos pasar el
    // presupuesto de 1,5 s del hook Stop.
    const MAX = 8 * 1024 * 1024;
    const desde = largo > MAX ? st.size - MAX : inicio;
    const buf = Buffer.alloc(st.size - desde);
    const fd = openSync(rutaTranscript, 'r');
    try { readSync(fd, buf, 0, buf.length, desde); } finally { closeSync(fd); }
    bruto = buf.toString('utf8');
  } catch {
    return res;
  }

  const pending = [];
  for (const linea of bruto.split('\n')) {
    if (!linea.trim()) continue;
    let ev;
    try { ev = JSON.parse(linea); } catch { continue; }
    extract(ev, res, config, pending);
  }

  // Solo los últimos, para no inflar el relevo.
  res.commands = res.commands.slice(-12);
  res.filesRead = [...new Set(res.filesRead)].slice(-15);
  return res;
}

/**
 * Extrae de un event del transcript. Defensivo a propósito: cada CLI tiene
 * su propia forma y ninguno prometió mantenerla entre versiones. Ante un
 * formato desconocido se ignora el event en lugar de fallar.
 */
function extract(ev, res, config, pending) {
  // Antigravity: pasos con step_index, type y content en texto plano.
  if (ev.step_index !== undefined || ev.stepIndex !== undefined) {
    return extractStep(ev, res, config, pending);
  }
  // Codex: wrapper {timestamp, ordinal, type, payload}.
  if (ev.payload !== undefined && ev.ordinal !== undefined) {
    return extractRollout(ev, res, config);
  }

  const kind = ev.type ?? ev.role ?? ev.kind;
  if (kind === 'assistant' || kind === 'user') res.turns++;

  const bloques = [];
  const msg = ev.message ?? ev;
  if (Array.isArray(msg?.content)) bloques.push(...msg.content);
  else if (Array.isArray(ev.content)) bloques.push(...ev.content);

  for (const b of bloques) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'tool_use' && b.name) {
      const inp = b.input ?? {};
      if (/^bash$|^shell$|^run/i.test(b.name) && inp.command) {
        const { texto } = redact(meaningfulLine(String(inp.command)), config);
        res.commands.push({ cmd: texto, id: b.id, exit: null });
      } else if (/^read$|^view$/i.test(b.name) && (inp.file_path ?? inp.path)) {
        const r = String(inp.file_path ?? inp.path);
        if (!isExcludedPath(r, config)) res.filesRead.push(r);
      }
    }

    // Resultado del comando: se busca el exit code, nunca el stdout.
    if (b.type === 'tool_result') {
      const c = res.commands.find((x) => x.id === b.tool_use_id);
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
function extractStep(ev, res, config, pending = []) {
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
          const { texto } = redact(meaningfulLine(rawCmd), config);
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
          if (rawPath && !isExcludedPath(rawPath, config)) res.filesRead.push(rawPath);
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
    const unresolved = exit !== null ? res.commands.find((c) => c.exit === null) : null;
    if (unresolved) unresolved.exit = exit;
    return;
  }

  if (/RUN_COMMAND|COMMAND|TERMINAL/.test(kind)) {
    // El comando aparece como CommandLine en el contenido, o como primera
    // línea útil si viene en texto libre.
    const m = /"?CommandLine"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    const bruto = m ? m[1] : contenido;
    const { texto } = redact(meaningfulLine(bruto), config);
    if (texto) {
      const fallo = /FAILED|ERROR/.test(String(ev.status ?? '')) || /exit (?:code )?[1-9]/i.test(contenido);
      res.commands.push({ cmd: texto, id: stepIndex, exit: fallo ? 1 : 0 });
    }
  }

  if (/VIEW_FILE|READ_FILE/.test(kind)) {
    const m = /"?(?:AbsolutePath|path|file)"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    if (m && !isExcludedPath(m[1], config)) res.filesRead.push(m[1].trim());
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
function extractRollout(ev, res, config) {
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
    const command = res.commands.find((c) => c.id === p.call_id);
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
  const { texto } = redact(meaningfulLine(line), config);
  if (!texto) return;
  const id = item.call_id ?? item.id ?? ev.ordinal;
  const exit = Number.isInteger(item.exit_code) ? item.exit_code
    : execution && !('exit_code' in item)
      ? (/error|fail/i.test(item.status ?? '') ? 1 : item.status === 'completed' ? 0 : null)
      : null;
  const previous = res.commands.find((c) => c.id === id);
  if (previous) {
    previous.cmd = texto;
    if (exit !== null) previous.exit = exit;
  } else {
    // Una llamada generada todavía no es un resultado: sin confirmación,
    // queda desconocido. Antes se escribía exit 0 por defecto.
    res.commands.push({ cmd: texto, id, exit });
  }
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
 * El archivo de destino, at git informa un renombre.
 *
 * `--numstat` usa `viejo.txt => nuevo.txt`, y con prefijo común
 * `src/{viejo.txt => nuevo.txt}`. Sin desarmarlo, el relevo mostraba el
 * renombre como un archivo llamado "viejo.txt => nuevo.txt" **y además**
 * el destino por separado: dos entradas para un solo archivo, una con un
 * name que no existe.
 */
function renameTarget(bruto) {
  if (!bruto) return null;
  const s = bruto.trim();
  if (!s.includes('=>')) return s;

  // Forma con llaves: prefijo{antes => después}sufijo
  const conLlaves = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(s);
  if (conLlaves) {
    const [, pre, , despues, post] = conLlaves;
    return (pre + despues + post).replace(/\/{2,}/g, '/');
  }
  // Forma simple: antes => después
  return s.split('=>').pop().trim();
}

function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
