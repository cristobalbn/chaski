// Pedidos de narrativa anotados por `Stop` y entregados en el mensaje
// siguiente (#73): `.tambo/pending-ask.json`.
//
// Un pedido POR SESIÓN, no uno por proyecto. Con un solo espacio, dos
// ventanas en el mismo proyecto se pisaban: el `Stop` de la segunda borraba
// el pedido de la primera, que no se entregaba nunca. Formato:
//
//   { "<session>": { session, transcript, at, reason, statePath, hasSkill, sessionEnded? } }
//
// Se lee también el formato anterior (un solo pedido en la raíz), para no
// perder el que haya quedado anotado al actualizar.
//
// Escritura atómica siempre (invariante 7): lo leen los hooks de varias
// sesiones a la vez. Ninguna función lanza: son llamadas desde hooks.
import { existsSync, rmSync } from 'node:fs';
import { readJson, pendingAskPath } from './paths.mjs';
import { writeAtomic } from './relay.mjs';
import { shouldDeliverPending, samePendingConversation, PENDING_TTL_MS } from './ask.mjs';
import { isFresh } from './time.mjs';

/** Todos los pedidos anotados, por sesión. Lee el formato viejo de uno solo. */
export function readPendingAsks(cwd) {
  const crudo = readJson(pendingAskPath(cwd), null);
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return {};
  if (typeof crudo.reason === 'string') {
    return crudo.session ? { [crudo.session]: crudo } : {};
  }
  const out = {};
  for (const [s, p] of Object.entries(crudo)) {
    if (p && typeof p === 'object' && typeof p.reason === 'string') out[s] = p;
  }
  return out;
}

/** Escribe los pedidos; sin ninguno, borra el archivo. Los vencidos se descartan. */
function writePendingAsks(cwd, pedidos) {
  const ruta = pendingAskPath(cwd);
  const vivos = Object.fromEntries(Object.entries(pedidos)
    .filter(([, p]) => isFresh(p?.at, PENDING_TTL_MS)));
  if (!Object.keys(vivos).length) {
    try { rmSync(ruta, { force: true }); } catch {}
    return;
  }
  writeAtomic(ruta, JSON.stringify(vivos, null, 2));
}

/** Anota el pedido de una sesión, sin tocar los de las demás. */
export function notePendingAsk(cwd, pedido) {
  try {
    if (!pedido?.session) return;
    const todos = readPendingAsks(cwd);
    todos[pedido.session] = pedido;
    writePendingAsks(cwd, todos);
  } catch {}
}

/**
 * Marca que la sesión que anotó un pedido terminó (SessionEnd). Desde ahí el
 * pedido puede entregarse a la conversación retomada, que llega con otro id y
 * el mismo transcript. Ver samePendingConversation() en ask.mjs.
 */
export function markPendingSessionEnded(cwd, session) {
  try {
    if (!session || !existsSync(pendingAskPath(cwd))) return;
    const todos = readPendingAsks(cwd);
    if (!todos[session] || todos[session].sessionEnded) return;
    todos[session] = { ...todos[session], sessionEnded: true };
    writePendingAsks(cwd, todos);
  } catch {}
}

/**
 * El pedido que corresponde entregar a esta sesión, o null; y lo saca del
 * archivo. También saca los que ya no hace falta entregar: el de esta
 * conversación cubierto por una narrativa posterior, y los vencidos. Los de
 * otras sesiones vivas quedan: son suyos.
 *
 * `transcriptDe` se llama solo si ningún pedido es de esta sesión por id,
 * porque tras un resume resolver el transcript lee la carpeta.
 */
export function takePendingAsk(cwd, session, transcriptDe, ahora = Date.now()) {
  try {
    if (!existsSync(pendingAskPath(cwd))) return null;
    const todos = readPendingAsks(cwd);
    const claves = Object.keys(todos);
    if (!claves.length) return null;

    let transcript = null;
    if (!todos[session]) transcript = transcriptDe();

    let entregar = null;
    for (const clave of claves) {
      const p = todos[clave];
      if (!samePendingConversation(p, session, transcript)) continue;
      const estado = p.statePath ? readJson(p.statePath, {}) ?? {} : {};
      if (!entregar && shouldDeliverPending(p, session, estado, ahora, transcript)) entregar = p;
      // Entregado o ya cubierto: en los dos casos deja de estar pendiente.
      delete todos[clave];
    }
    writePendingAsks(cwd, todos);
    return entregar;
  } catch {
    return null;
  }
}
