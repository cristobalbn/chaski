// Plugin de OpenCode. A diferencia de los otros tres CLIs, OpenCode no corre
// hooks de shell: carga módulos JS dentro de su propio proceso (Bun). Este
// módulo es ese plugin, y no tiene lógica de chaski: traduce los eventos de
// OpenCode a los mismos hooks que usan los demás y lanza `node` con
// capture.mjs e inject.mjs, igual que los wrappers de Codex y agy.
//
// `chaski init` escribe en `~/.config/opencode/plugins/chaski.js` un archivo
// de pocas líneas que importa este módulo por su ruta absoluta (invariante 8:
// este nombre tampoco cambia nunca) y le pasa la ruta de `node`. Dentro de
// OpenCode `process.execPath` es el binario de OpenCode, no Node.
//
// OpenCode tiene dos APIs de plugins incompatibles entre sí, y este módulo
// sirve las dos desde el mismo `export default` (el patrón de la guía oficial
// de migración): 1.x llama a `server()` y 2.x a `setup()`.
//
//   chaski            1.x (verificado con 1.19.6)               2.x (verificado con 2.4.2)
//   SessionStart      `experimental.chat.system.transform`      hook `context`
//   UserPromptSubmit  `chat.message`                            hook `prompt`
//   Stop              evento `session.idle`                     eventos `session.execution.{succeeded,failed,interrupted}`
//   PreCompact        `experimental.session.compacting`         hook `compaction`
//   mensajes          `client.session.messages()`               `ctx.session.context()`
//
// OpenCode guarda la conversación en SQLite y no hay archivo de transcript.
// Al terminar el turno se piden los mensajes, se reducen a un JSONL mínimo
// —el mismo en las dos versiones— y viajan por stdin a capture.mjs, que lleva
// la marca de agua y redacta antes de escribir (invariante 6). El plugin no
// escribe nada a disco por su cuenta.
//
// Regla de los hooks (invariante 4): nada de aquí puede lanzar. Un error en
// un plugin de OpenCode le rompe la sesión al usuario.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CAPTURE = fileURLToPath(new URL('./capture.mjs', import.meta.url));
const INJECT = fileURLToPath(new URL('./inject.mjs', import.meta.url));

/** Más que esto y el hook se da por perdido: OpenCode espera al plugin. */
const HOOK_TIMEOUT_MS = 10_000;
/** Dos fines de turno más juntos que esto, sin mensaje del usuario en medio, son el mismo turno. */
const DUPLICATE_IDLE_MS = 5_000;
/** Por parte de texto. El relevo usa ~700 caracteres de la última respuesta. */
const MAX_TEXT = 4000;

/**
 * La ruta de Node que escribió `init`, o `node` del PATH si ya no existe.
 *
 * `init` fija `process.execPath` en el plugin porque dentro de OpenCode el
 * ejecutable es OpenCode. Esa ruta se rompe con nvm, fnm o volta al cambiar
 * de versión, o al reinstalar Node en otra carpeta, y entonces cada hook
 * fallaba en silencio hasta volver a correr `init` (doctor lo marcaba, pero
 * nadie lo corre a diario). Con el respaldo sigue funcionando; doctor
 * igual pide `init` para dejar la ruta fija.
 */
export function resolveNode(node) {
  if (typeof node !== 'string' || !node) return node;
  try { return existsSync(node) ? node : 'node'; } catch { return node; }
}

/**
 * Error con el que terminó un turno, en los campos que capture.mjs ya sabe
 * leer (`error_type`, `error_message`, como el `StopFailure` de Claude
 * Code). Un corte por cuota sale como `rate_limit`: capture sella el relevo
 * y lo anota en ~/.chaski/quota.json, que es lo que `chaski next` usa para
 * sugerir otro CLI.
 *
 *   1.x  evento `session.error`: `properties.error = { name, data: { message, statusCode } }`
 *        (EventSessionError / ApiError en @opencode-ai/sdk 1.19.6)
 *   2.x  evento `session.execution.failed`: `data.error = { type, message, status }`
 *        (@opencode/protocol 2.4.2)
 *
 * Los proveedores no se ponen de acuerdo en cómo dicen «sin cuota»: HTTP 429,
 * «rate limit», «insufficient_quota», «credit balance». Se acepta cualquiera.
 */
export function turnError(error) {
  if (!error || typeof error !== 'object') return null;
  const type = String(error.name ?? error.type ?? '').slice(0, 80);
  const message = String(error.data?.message ?? error.message ?? '').slice(0, 500);
  if (!type && !message) return null;
  const status = Number(error.data?.statusCode ?? error.status);
  const limit = status === 429
    || /rate.?limit|too many requests|quota|usage.?limit|insufficient.?(quota|credits?|balance)|credit.?balance/i.test(`${type} ${message}`);
  return { error_type: limit ? 'rate_limit' : (type || 'error'), error_message: message };
}

/** Línea del JSONL común: `{ info: { id, role }, parts }`. */
function line(id, role, parts) {
  return JSON.stringify({ info: { id: String(id ?? ''), role: String(role ?? '') }, parts });
}

function textPart(text, synthetic = false) {
  return { type: 'text', text: text.slice(0, MAX_TEXT), ...(synthetic ? { synthetic: true } : {}) };
}

function toolPart({ tool, callID, status, input, exit }) {
  const i = input && typeof input === 'object' ? input : {};
  const filePath = typeof i.filePath === 'string' ? i.filePath : typeof i.path === 'string' ? i.path : null;
  return {
    type: 'tool',
    tool,
    callID: typeof callID === 'string' ? callID : null,
    status: typeof status === 'string' ? status : null,
    input: {
      ...(typeof i.command === 'string' ? { command: i.command } : {}),
      ...(filePath ? { filePath } : {}),
    },
    exit: Number.isInteger(exit) ? exit : null,
  };
}

/**
 * Reduce los mensajes de OpenCode 1.x (`client.session.messages()`) a JSONL,
 * una línea por mensaje.
 *
 * La salida tiene que ser DETERMINISTA: capture.mjs guarda un offset en bytes
 * sobre este texto, y la próxima vez el mismo mensaje tiene que producir los
 * mismos bytes. Por eso se eligen los campos a mano —nada de tiempos de
 * actualización, costos ni salidas de herramientas— y los mensajes del
 * asistente sin terminar cortan la lectura: todavía pueden cambiar.
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
        parts.push(textPart(p.text, Boolean(p.synthetic)));
      } else if (p?.type === 'tool' && typeof p.tool === 'string') {
        parts.push(toolPart({
          tool: p.tool, callID: p.callID, status: p.state?.status,
          input: p.state?.input, exit: p.state?.metadata?.exit,
        }));
      }
    }
    lines.push(line(info.id, info.role, parts));
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Lo mismo para OpenCode 2.x (`ctx.session.context()`), que devuelve otra
 * forma: `{ type: "user", text }` y `{ type: "assistant", content: [...] }`,
 * con herramientas `{ type: "tool", id, name, state }` (la de shell se llama
 * `shell`, y `read` usa `input.path`). Produce el mismo JSONL que 1.x, así que
 * el adaptador de transcript no distingue versiones.
 */
export function reduceMessagesV2(messages) {
  if (!Array.isArray(messages)) return '';
  const lines = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'user') {
      if (typeof m.text === 'string') lines.push(line(m.id, 'user', [textPart(m.text)]));
    } else if (m.type === 'assistant') {
      if (!m.time?.completed) break;
      const parts = [];
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type === 'text' && typeof p.text === 'string') {
          parts.push(textPart(p.text));
        } else if (p?.type === 'tool' && typeof p.name === 'string') {
          parts.push(toolPart({
            tool: p.name, callID: p.id, status: p.state?.status,
            input: p.state?.input, exit: p.state?.metadata?.exit,
          }));
        }
      }
      lines.push(line(m.id, 'assistant', parts));
    }
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
 * `experimental.chat.system.transform` en 1.x. Meterle el relevo gasta tokens
 * y no sirve de nada.
 */
function isTitleCall(system) {
  return Array.isArray(system) && system.some((s) => typeof s === 'string' && /^You are a title generator/.test(s));
}

/**
 * Lo que no depende de la versión: estado por sesión y las llamadas a los
 * scripts de chaski. Cada versión aporta cómo leer los mensajes y cómo saber
 * si una sesión es hija.
 */
function bridge({ node, directory, readTranscript, parentOf }) {
  /** Por sesión: relevo de arranque, petición pendiente, y si es un subagente. */
  const sessions = new Map();
  const session = (id) => {
    if (!sessions.has(id)) sessions.set(id, { relay: null, extra: null, child: null, error: null, capturedAt: 0 });
    return sessions.get(id);
  };
  const base = (id, event) => ({ hook_event_name: event, session_id: id, cwd: directory });

  // Un subagente (herramienta `task`) es una sesión hija. Como en Claude
  // Code, ni recibe el relevo ni lo escribe: su exploración contaminaría el
  // relevo del padre.
  const isChild = async (id) => {
    const s = session(id);
    if (s.child === null) {
      try { s.child = Boolean(await parentOf(id)); } catch { s.child = false; }
    }
    return s.child;
  };

  return {
    session,
    forget: (id) => sessions.delete(id),
    /** Anota el error del turno; viaja con la captura siguiente. */
    noteError(id, error) { session(id).error = turnError(error); },
    isChild,

    startRelay(id) {
      const s = session(id);
      s.relay ??= run(node, INJECT, 'SessionStart', base(id, 'SessionStart')).then((t) => t.trim() || null);
      return s.relay;
    },

    /** Relevo de arranque más la petición pendiente, o null si no hay nada. */
    async injection(id) {
      if (await isChild(id)) return null;
      const s = session(id);
      const relay = await this.startRelay(id);
      return [relay, s.extra].filter(Boolean).join('\n\n') || null;
    },

    async prompt(id) {
      if (await isChild(id)) return;
      // Turno nuevo: el error y la marca de captura eran del anterior.
      const s = session(id);
      s.error = null;
      s.capturedAt = 0;
      session(id).extra = contextFrom(await run(node, INJECT, 'UserPromptSubmit', base(id, 'UserPromptSubmit')));
    },

    async compactHint(id) {
      return (await run(node, CAPTURE, 'PreCompact', base(id, 'PreCompact'))).trim() || null;
    },

    async capture(id) {
      const s = session(id);
      // OpenCode 1.19.6 emite `session.idle` dos veces al terminar un turno
      // (verificado con un turno real). La segunda captura repetía el trabajo
      // —unos cientos de ms con OpenCode esperando— y, tras un corte por
      // cuota, sobrescribía el relevo sellado con uno sin el error. Una
      // segunda captura sin mensaje nuevo del usuario en medio se ignora.
      if (s.capturedAt && Date.now() - s.capturedAt < DUPLICATE_IDLE_MS) return;
      s.extra = null;
      // El error se conserva hasta el mensaje siguiente (prompt): si una
      // captura posterior del mismo turno no lo llevara, borraría el sello.
      const error = s.error;
      if (await isChild(id)) return;
      let transcript = '';
      try { transcript = await readTranscript(id); } catch {}
      // Síncrono a propósito. `opencode run` termina el proceso apenas la
      // sesión queda inactiva, sin esperar a los plugins
      // (anomalyco/opencode#23380): con un `spawn` asíncrono la captura moría
      // a medias y no quedaba relevo (visto con 1.19.6). Bloquea unos cientos
      // de ms al final del turno, igual que el hook Stop en los demás CLIs.
      try {
        spawnSync(node, [CAPTURE, 'Stop', 'opencode'], {
          input: JSON.stringify({ ...base(id, 'Stop'), ...(error ?? {}), transcript_inline: transcript }),
          stdio: ['pipe', 'ignore', 'ignore'], timeout: HOOK_TIMEOUT_MS, windowsHide: true,
        });
      } catch {}
      s.capturedAt = Date.now();
    },
  };
}

/** Plugin para OpenCode 1.x: función que recibe el contexto y devuelve hooks. */
export function chaskiPlugin({ node } = {}) {
  return async ({ client, directory } = {}) => {
    if (typeof node !== 'string' || !node) return {};
    const b = bridge({
      node,
      directory,
      readTranscript: async (id) => reduceMessages((await client.session.messages({ path: { id } }))?.data),
      parentOf: async (id) => (await client.session.get({ path: { id } }))?.data?.parentID,
    });

    return {
      event: async ({ event } = {}) => {
        try {
          const p = event?.properties ?? {};
          if (event?.type === 'session.created') {
            const id = p.info?.id ?? p.sessionID;
            if (typeof id !== 'string') return;
            b.session(id).child = Boolean(p.info?.parentID);
            // Se lanza ya, para que esté listo antes de la primera llamada al modelo.
            if (!b.session(id).child) b.startRelay(id);
          } else if (event?.type === 'session.error' && typeof p.sessionID === 'string') {
            b.noteError(p.sessionID, p.error);
          } else if (event?.type === 'session.idle' && typeof p.sessionID === 'string') {
            await b.capture(p.sessionID);
          } else if (event?.type === 'session.deleted') {
            const id = p.info?.id ?? p.sessionID;
            if (typeof id === 'string') b.forget(id);
          }
        } catch {}
      },

      'chat.message': async (input) => {
        try {
          if (typeof input?.sessionID === 'string') await b.prompt(input.sessionID);
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
          const extra = await b.injection(id);
          if (!extra) return;
          if (typeof output.system[0] === 'string') output.system[0] += '\n\n' + extra;
          else output.system.push(extra);
        } catch {}
      },

      'experimental.session.compacting': async (input, output) => {
        try {
          if (typeof input?.sessionID !== 'string') return;
          const hint = await b.compactHint(input.sessionID);
          if (hint && Array.isArray(output?.context)) output.context.push(hint);
        } catch {}
      },
    };
  };
}

/** Eventos de 2.x con los que termina un turno: éxito, error o interrupción. */
const V2_TURN_END = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

/**
 * Plugin para OpenCode 2.x: `setup(ctx)` registra hooks con
 * `ctx.session.hook()` y escucha el bus de eventos. En 2.x el system prompt
 * es una lista de partes `{ type: "text", text }` que OpenCode ya arma en
 * varias: agregar una parte al final es la forma nativa, y deja intacto el
 * prefijo que aprovecha el caché de prompt.
 */
export function chaskiPluginV2({ node } = {}) {
  return async (ctx) => {
    if (typeof node !== 'string' || !node || !ctx?.session?.hook) return;
    const b = bridge({
      node,
      directory: ctx.location?.directory,
      readTranscript: async (id) => reduceMessagesV2(await ctx.session.context({ sessionID: id })),
      parentOf: async (id) => (await ctx.session.get({ sessionID: id }))?.parentID,
    });

    const agregar = (ev, text) => {
      if (text && Array.isArray(ev?.system)) ev.system.push({ type: 'text', text });
    };

    // En 2.x no hace falta el filtro de la llamada del título que tiene 1.x
    // (isTitleCall): verificado con 2.4.2 (2026-11-27), solo la llamada del
    // agente (`agent: "build"`) pasa por `context`; la del título no.
    try {
      await ctx.session.hook('context', async (ev) => {
        try {
          if (typeof ev?.sessionID === 'string') agregar(ev, await b.injection(ev.sessionID));
        } catch {}
      });
      await ctx.session.hook('prompt', async (ev) => {
        try {
          if (typeof ev?.sessionID === 'string') await b.prompt(ev.sessionID);
        } catch {}
      });
      await ctx.session.hook('compaction', async (ev) => {
        try {
          if (typeof ev?.sessionID === 'string') agregar(ev, await b.compactHint(ev.sessionID));
        } catch {}
      });
    } catch {}

    // El bus es del proceso entero: los eventos traen su sessionID en `data`.
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({})) {
          try {
            const id = ev?.data?.sessionID;
            if (typeof id !== 'string') continue;
            if (ev.type === 'session.execution.failed') b.noteError(id, ev.data?.error);
            if (V2_TURN_END.has(ev.type)) await b.capture(id);
            else if (ev.type === 'session.created' && !(await b.isChild(id))) b.startRelay(id);
            else if (ev.type === 'session.deleted') b.forget(id);
          } catch {}
        }
      } catch {}
    })();
  };
}

/**
 * Definición única para las dos APIs (patrón de la guía de migración de
 * OpenCode): 1.x —desde 1.18.29— lee `server()`, 2.x lee `id` y `setup()`.
 * Las APIs no se traducen solas: cada una tiene su adaptador arriba.
 */
export function chaskiDefinition({ node } = {}) {
  node = resolveNode(node);
  const v1 = chaskiPlugin({ node });
  const v2 = chaskiPluginV2({ node });
  return {
    id: 'chaski',
    server: (input) => v1(input),
    setup: (ctx) => v2(ctx),
  };
}
