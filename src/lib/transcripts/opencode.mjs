/**
 * Un mensaje de OpenCode, tal como lo reduce `reduceMessages()` en
 * src/opencode.mjs: `{ info: { id, role }, parts: [...] }`.
 *
 * OpenCode no escribe un transcript en disco (guarda en SQLite). El plugin
 * arma este JSONL a partir de `client.session.messages()` y lo pasa por stdin.
 * La forma de origen se verificó con OpenCode 1.19.6: los comandos de shell
 * son partes `tool` con `tool: "bash"`, `state.input.command` y
 * `state.metadata.exit`.
 */
export function extractOpencode(ev, res, lookup) {
  const role = ev.info?.role;
  const parts = Array.isArray(ev.parts) ? ev.parts : [];

  // Un turno es un mensaje escrito por el usuario. Las partes `synthetic` las
  // agrega OpenCode (resultados de archivos adjuntos, recordatorios).
  if (role === 'user' && parts.some((p) => p?.type === 'text' && !p.synthetic && String(p.text ?? '').trim())) {
    res.turns++;
  }

  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && role === 'assistant' && typeof p.text === 'string' && p.text.trim()) {
      res.lastMessage = p.text;
    }
    if (p.type !== 'tool') continue;
    const input = p.input ?? {};
    if (/^bash$|^shell$/i.test(p.tool) && typeof input.command === 'string') {
      const texto = lookup.redactCommand(input.command);
      if (!texto) continue;
      // Sin código de salida, un error de la herramienta cuenta como fallo y
      // cualquier otro estado queda desconocido: nunca se supone éxito.
      const exit = Number.isInteger(p.exit) ? p.exit : p.status === 'error' ? 1 : null;
      lookup.recordCommand({ cmd: texto, id: p.callID ?? null, exit });
    } else if (/^read$/i.test(p.tool) && typeof input.filePath === 'string') {
      if (!lookup.isExcluded(input.filePath)) res.filesRead.push(input.filePath);
    }
  }
}
