// Plugin de OpenCode. A diferencia de los otros tres CLIs, OpenCode no corre
// hooks de shell: carga módulos JS dentro de su propio proceso (Bun). Este
// módulo es ese plugin, y no tiene lógica de chaski: traduce los eventos de
// OpenCode a los mismos hooks que usan los demás y lanza `node` con
// capture.mjs e inject.mjs, igual que los wrappers de Codex y agy.
//
// `chaski init` escribe en `~/.config/opencode/plugins/chaski.js` un archivo
// de tres líneas que importa este módulo por su ruta absoluta (invariante 8:
// este nombre tampoco cambia nunca) y le pasa la ruta de `node`. Dentro de
// OpenCode `process.execPath` es el binario de OpenCode, no Node.
//
// Equivalencias (verificadas con OpenCode 1.19.6, ver AGENTS.md):
//   SessionStart      → primera llamada al modelo de la sesión: el relevo se
//                       agrega al system prompt con
//                       `experimental.chat.system.transform`
//   UserPromptSubmit  → `chat.message`
//   Stop              → evento `session.idle`
//   PreCompact        → `experimental.session.compacting`
//
// OpenCode guarda la conversación en SQLite y no hay archivo de transcript.
// En `session.idle` se piden los mensajes con la API del plugin, se reducen a
// un JSONL mínimo y viajan por stdin a capture.mjs, que lleva la marca de agua
// y redacta antes de escribir (invariante 6). El plugin no escribe nada a
// disco por su cuenta.
//
// Regla de los hooks (invariante 4): nada de aquí puede lanzar. Un error en
// un plugin de OpenCode le rompe la sesión al usuario.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CAPTURE = fileURLToPath(new URL('./capture.mjs', import.meta.url));
const INJECT = fileURLToPath(new URL('./inject.mjs', import.meta.url));

/** Más que esto y el hook se da por perdido: OpenCode espera al plugin. */
const HOOK_TIMEOUT_MS = 10_000;
/** Por parte de texto. El relevo usa ~700 caracteres de la última respuesta. */
const MAX_TEXT = 4000;

/**
 * Reduce los mensajes de una sesión a JSONL, una línea por mensaje.
 *
 * La salida tiene que ser DETERMINISTA: capture.mjs guarda un offset en bytes
 * sobre este texto, y la próxima vez el mismo mensaje tiene que producir los
 * mismos bytes. Por eso se eligen los campos a mano —nada de tiempos de
 * actualización, costos ni salidas de herramientas— y los mensajes del
 * asistente sin terminar se omiten: todavía pueden cambiar.
 */
export function reduceMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const lines = [];
  for (const m of messages) {
    const info = m?.info;
    if (!info || typeof info !== 'object') continue;
    if (info.role === 'assistant' && !info.time?.completed) break;
    const parts = [];
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      if (p?.type === 'text' && typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text.slice(0, MAX_TEXT), ...(p.synthetic ? { synthetic: true } : {}) });
      } else if (p?.type === 'tool' && typeof p.tool === 'string') {
        const input = p.state?.input ?? {};
        const exit = p.state?.metadata?.exit;
        parts.push({
          type: 'tool',
          tool: p.tool,
          callID: typeof p.callID === 'string' ? p.callID : null,
          status: typeof p.state?.status === 'string' ? p.state.status : null,
          input: {
            ...(typeof input.command === 'string' ? { command: input.command } : {}),
            ...(typeof input.filePath === 'string' ? { filePath: input.filePath } : {}),
          },
          exit: Number.isInteger(exit) ? exit : null,
        });
      }
    }
    lines.push(JSON.stringify({ info: { id: String(info.id ?? ''), role: String(info.role ?? '') }, parts }));
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Lanza un script de chaski con el payload por stdin y devuelve su stdout. */
function run(node, script, event, payload) {
  return new Promise((resolveRun) => {
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolveRun(out); } };
    try {
      const child = spawn(node, [script, event, 'opencode'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, HOOK_TIMEOUT_MS);
      // Decodificado por el stream: un carácter con tilde partido entre dos
      // trozos no se convierte en dos caracteres rotos.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      // stderr se descarta: OpenCode no tiene dónde mostrarlo sin ensuciar la TUI.
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); finish(); });
      child.on('close', () => { clearTimeout(timer); finish(); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      finish();
    }
  });
}

/** `additionalContext` de la salida JSON de inject.mjs en UserPromptSubmit. */
function contextFrom(stdout) {
  try {
    const v = JSON.parse(stdout);
    const t = v?.hookSpecificOutput?.additionalContext;
    return typeof t === 'string' && t.trim() ? t : null;
  } catch {
    return null;
  }
}

/**
 * La llamada al modelo que genera el título de la sesión también pasa por
 * `experimental.chat.system.transform`. Meterle el relevo gasta tokens y no
 * sirve de nada.
 */
function isTitleCall(system) {
  return Array.isArray(system) && system.some((s) => typeof s === 'string' && /^You are a title generator/.test(s));
}

export function chaskiPlugin({ node } = {}) {
  return async ({ client, directory } = {}) => {
    if (typeof node !== 'string' || !node) return {};
    /** Por sesión: relevo de arranque, petición pendiente, y si es un subagente. */
    const sessions = new Map();
    const session = (id) => {
      if (!sessions.has(id)) sessions.set(id, { relay: null, extra: null, child: null });
      return sessions.get(id);
    };
    const base = (id, event) => ({ hook_event_name: event, session_id: id, cwd: directory });

    // Un subagente (herramienta `task`) es una sesión hija. Como en Claude
    // Code, ni recibe el relevo ni lo escribe: su exploración contaminaría el
    // relevo del padre.
    const isChild = async (id, s) => {
      if (s.child === null) {
        try {
          const r = await client.session.get({ path: { id } });
          s.child = Boolean(r?.data?.parentID);
        } catch {
          s.child = false;
        }
      }
      return s.child;
    };

    const startRelay = (id, s) => {
      s.relay ??= run(node, INJECT, 'SessionStart', base(id, 'SessionStart')).then((t) => t.trim() || null);
      return s.relay;
    };

    const capture = async (id) => {
      const s = session(id);
      s.extra = null;
      if (await isChild(id, s)) return;
      let transcript = '';
      try {
        const r = await client.session.messages({ path: { id } });
        transcript = reduceMessages(r?.data);
      } catch {}
      // Síncrono a propósito. `opencode run` termina el proceso apenas la
      // sesión queda inactiva, sin esperar a los plugins: con un `spawn`
      // asíncrono la captura moría a medias y no quedaba relevo (visto con
      // OpenCode 1.19.6). Bloquea unos cientos de ms al final del turno, igual
      // que el hook Stop en los demás CLIs.
      try {
        spawnSync(node, [CAPTURE, 'Stop', 'opencode'], {
          input: JSON.stringify({ ...base(id, 'Stop'), transcript_inline: transcript }),
          stdio: ['pipe', 'ignore', 'ignore'], timeout: HOOK_TIMEOUT_MS, windowsHide: true,
        });
      } catch {}
    };

    return {
      event: async ({ event } = {}) => {
        try {
          const p = event?.properties ?? {};
          if (event?.type === 'session.created') {
            const id = p.info?.id ?? p.sessionID;
            if (typeof id !== 'string') return;
            const s = session(id);
            s.child = Boolean(p.info?.parentID);
            // Se lanza ya, para que esté listo antes de la primera llamada al modelo.
            if (!s.child) startRelay(id, s);
          } else if (event?.type === 'session.idle' && typeof p.sessionID === 'string') {
            await capture(p.sessionID);
          } else if (event?.type === 'session.deleted') {
            const id = p.info?.id ?? p.sessionID;
            if (typeof id === 'string') sessions.delete(id);
          }
        } catch {}
      },

      'chat.message': async (input) => {
        try {
          const id = input?.sessionID;
          if (typeof id !== 'string') return;
          const s = session(id);
          if (await isChild(id, s)) return;
          const out = await run(node, INJECT, 'UserPromptSubmit', base(id, 'UserPromptSubmit'));
          s.extra = contextFrom(out);
        } catch {}
      },

      // Corre antes de CADA llamada al modelo y no queda en el historial: por
      // eso el relevo se agrega en todas, no solo en la primera.
      //
      // Se pega al FINAL de `system[0]`, no como elemento nuevo. Un elemento
      // más se envía como un segundo mensaje `system`, y varios proveedores
      // compatibles con OpenAI lo rechazan («A 'system' message can only
      // appear at index 0»; anomalyco/opencode#34243, cerrado sin arreglo en
      // 1.x). Al final, y no al principio, para no romper el caché de prompt
      // por prefijo: el texto de OpenCode queda intacto delante. La mutación
      // tiene que ser en el lugar: reasignar `output.system` no tiene efecto.
      'experimental.chat.system.transform': async (input, output) => {
        try {
          const id = input?.sessionID;
          if (typeof id !== 'string' || !Array.isArray(output?.system) || isTitleCall(output.system)) return;
          const s = session(id);
          if (await isChild(id, s)) return;
          const relay = await startRelay(id, s);
          const extra = [relay, s.extra].filter(Boolean).join('\n\n');
          if (!extra) return;
          if (typeof output.system[0] === 'string') output.system[0] += '\n\n' + extra;
          else output.system.push(extra);
        } catch {}
      },

      'experimental.session.compacting': async (input, output) => {
        try {
          const id = input?.sessionID;
          if (typeof id !== 'string') return;
          const hint = (await run(node, CAPTURE, 'PreCompact', base(id, 'PreCompact'))).trim();
          if (hint && Array.isArray(output?.context)) output.context.push(hint);
        } catch {}
      },
    };
  };
}
