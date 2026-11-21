/**
 * Un registro del rollout de Codex.
 *
 * Formato verificado contra una sesión real: cada línea envuelve un payload
 * en {timestamp, ordinal, type, payload}. Los tipos que informan son
 * `response_item` (mensajes y llamadas a herramientas) y `event_msg`
 * (task_started, item_completed, task_complete).
 */
export function extractCodex(ev, res, { byId, redactCommand, recordCommand }) {
  const p = ev.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return;
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
  const item = kind === 'item_completed' ? p.item : p;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  const name = String(item.name ?? item.type ?? '');
  const execution = /^(CommandExecution|command_execution|local_shell_call)$/i.test(item.type ?? '');
  if (!execution && !/(?:^|\.)(exec_command|shell_command|shell|bash|run_command)$/i.test(name)) return;

  const line = rolloutCommand(item);
  if (!line) return;
  const texto = redactCommand(line);
  if (!texto) return;
  const id = item.call_id ?? item.id ?? ev.ordinal ?? null;
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
    recordCommand({ cmd: texto, id, exit });
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
