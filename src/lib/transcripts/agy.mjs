/**
 * Un paso del transcript de Antigravity.
 *
 * Formato verificado contra sesiones reales: cada línea es un paso con
 * step_index, source, type, status, created_at y content. En el formato actual
 * las llamadas a herramientas viajan en `tool_calls` de `PLANNER_RESPONSE` y
 * sus salidas llegan en los pasos `GENERIC` siguientes, en el mismo orden.
 * También se conserva el formato anterior de pasos `RUN_COMMAND` / `VIEW_FILE`.
 */
export function extractAgy(ev, res, { byId, pending, recordCommand, redactCommand, isExcluded }) {
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
            recordCommand(command);
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
    const taskId = stepBackgroundTaskId(contenido);
    if (next) {
      if (next.kind !== 'command') return;
      if (taskId) {
        next.command.id = taskId;
        byId.set(taskId, next.command);
        return;
      }
      const exit = stepCommandExit(ev, contenido);
      if (exit !== null) next.command.exit = exit;
      return;
    }
    // Si la lectura incremental arrancó después del PLANNER_RESPONSE, asocia
    // el task id o la cabecera explícita de salida al comando pendiente más reciente.
    const unresolved = res.commands.findLast((c) => c.exit === null);
    if (!unresolved) return;
    if (taskId) {
      unresolved.id = taskId;
      byId.set(taskId, unresolved);
      return;
    }
    const exit = stepHeaderExit(contenido);
    if (exit !== null) unresolved.exit = exit;
    return;
  }

  if (kind === 'SYSTEM_MESSAGE') {
    const taskId = stepFinishedTaskId(contenido);
    const exit = taskId ? stepHeaderExit(contenido) : null;
    if (taskId && exit !== null) {
      const command = byId.get(taskId);
      if (command) command.exit = exit;
    }
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

function stepHeader(contenido) {
  return contenido.split(/\r?\n(?:\r?\nCommand output:|Log output:)\r?\n/)[0];
}

function stepBackgroundTaskId(contenido) {
  const match = /^Tool is running as a background task with task id:\s*(\S+)\s*$/m.exec(stepHeader(contenido));
  return match ? match[1] : null;
}

function stepFinishedTaskId(contenido) {
  const match = /Task id "([^"\r\n]+)" finished with result:/m.exec(stepHeader(contenido));
  return match ? match[1] : null;
}

function stepHeaderExit(contenido) {
  // Solo la cabecera previa a "Command output:" pertenece al runner; el stdout
  // del proceso puede contener líneas con el mismo texto.
  const header = stepHeader(contenido);
  const match = /^Command exited with code (-?\d+)\.\s*$/m.exec(header);
  return match ? Number(match[1]) : null;
}

function stepCommandExit(ev, contenido) {
  const exit = stepHeaderExit(contenido);
  if (exit !== null) return exit;
  const header = stepHeader(contenido);
  if (/^(FAILED|ERROR)$/i.test(String(ev.status ?? ''))) return 1;
  if (/^Encountered error in (?:step|tool) execution:/m.test(header)) return 1;
  return null;
}
