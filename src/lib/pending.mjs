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
import { writeAtomic } from './atomic.mjs';
import { withFileLock } from './lock.mjs';
import { shouldDeliverPending, samePendingConversation, PENDING_TTL_MS } from './ask.mjs';
import { isFresh } from './time.mjs';

/** Todos los pedidos anotados, por sesión. Lee el formato viejo de uno solo. */
function readPendingAsks(path) {
  const crudo = readJson(path, null);
  const out = Object.create(null);
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return out;
  if (typeof crudo.reason === 'string') {
    if (crudo.session) out[crudo.session] = crudo;
    return out;
  }
  for (const [s, p] of Object.entries(crudo)) {
    if (p && typeof p === 'object' && typeof p.reason === 'string') out[s] = p;
  }
  return out;
}

/** Escribe los pedidos; sin ninguno, borra el archivo. Los vencidos se descartan. */
function writePendingAsks(ruta, pedidos, now = Date.now()) {
  const vivos = Object.fromEntries(Object.entries(pedidos)
    .filter(([, p]) => isFresh(p?.at, PENDING_TTL_MS, now)));
  if (!Object.keys(vivos).length) {
    rmSync(ruta, { force: true });
    return;
  }
  writeAtomic(ruta, JSON.stringify(vivos, null, 2));
}

/** Anota el pedido de una sesión, sin tocar los de las demás. */
export function notePendingAsk(cwd, pedido) {
  try {
    if (!pedido?.session) return;
    const path = pendingAskPath(cwd);
    return withFileLock(path, () => {
      const todos = readPendingAsks(path);
      todos[pedido.session] = pedido;
      writePendingAsks(path, todos);
      return true;
    });
  } catch {}
}

/**
 * Marca que la sesión que anotó un pedido terminó (SessionEnd). Desde ahí el
 * pedido puede entregarse a la conversación retomada, que llega con otro id y
 * el mismo transcript. Ver samePendingConversation() en ask.mjs.
 */
export function markPendingSessionEnded(cwd, session) {
  try {
    const path = pendingAskPath(cwd);
    if (!session || !existsSync(path)) return;
    withFileLock(path, () => {
      const todos = readPendingAsks(path);
      if (!todos[session] || todos[session].sessionEnded) return;
      todos[session] = { ...todos[session], sessionEnded: true };
      writePendingAsks(path, todos);
    });
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
    const path = pendingAskPath(cwd);
    if (!existsSync(path)) return null;
    return withFileLock(path, () => {
      const todos = readPendingAsks(path);
      // Resolver el transcript puede recorrer una carpeta. Solo hace falta
      // al buscar un pedido de una sesión anterior que ya terminó.
      const transcript = !todos[session] && Object.values(todos).some((p) => p.sessionEnded)
        ? transcriptDe() : null;
      let changed = false;
      let deliver = null;
      for (const [key, pending] of Object.entries(todos)) {
        if (samePendingConversation(pending, session, transcript)) {
          const state = pending.statePath ? readJson(pending.statePath, {}) ?? {} : {};
          if (!deliver && shouldDeliverPending(pending, session, state, ahora, transcript)) deliver = pending;
        } else if (isFresh(pending.at, PENDING_TTL_MS, ahora)) {
          continue;
        }
        delete todos[key];
        changed = true;
      }
      if (changed) writePendingAsks(path, todos, ahora);
      return deliver;
    }) ?? null;
  } catch {
    return null;
  }
}
