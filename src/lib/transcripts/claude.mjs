export function extractClaude(ev, res, lookup) {
  const kind = ev.type ?? ev.role ?? ev.kind;
  // Un turno es un mensaje del usuario, no cualquier línea. Antes se contaba
  // toda línea `user` o `assistant`, y en Claude Code cada llamada a una
  // herramienta agrega dos (el uso y su resultado, que viaja como `user`):
  // una conversación real tenía 1.220 «turnos» y 34 mensajes del usuario. Con
  // eso, «van 8 turnos» eran dos o tres mensajes y la narrativa se pedía
  // mucho más seguido de lo diseñado. Codex (task_started) y agy (USER_INPUT)
  // ya contaban mensajes; ahora Claude Code también.
  if (kind === 'user' && isUserPrompt(ev)) res.turns++;

  const msg = ev.message ?? ev;
  const bloques = Array.isArray(msg?.content) ? msg.content : Array.isArray(ev.content) ? ev.content : [];

  for (const b of bloques) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'tool_use' && b.name) {
      const inp = b.input ?? {};
      if (/^bash$|^shell$|^run/i.test(b.name) && inp.command) {
        const texto = lookup.redactCommand(String(inp.command));
        lookup.recordCommand({ cmd: texto, id: b.id, exit: null });
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

function exitFrom(b) {
  const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
  const m = /exit (?:code|status)[: ]+(\d+)/i.exec(txt);
  return m ? parseInt(m[1], 10) : null;
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
