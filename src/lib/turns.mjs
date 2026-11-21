// Turnos empezados y no terminados: `.tambo/turns-open.json`,
// `{ "<session>": { agent, at } }`.
//
// El hook de entrega (inicio de turno, inject.mjs) anota la sesión y
// capture.mjs la quita al cerrar el turno. Si la marca sobrevive, el turno se
// cortó —interrupción, ventana cerrada, cuelgue— o sigue en curso en otra
// ventana, y la sesión siguiente lo dice al arrancar. Vivía repartido entre
// los dos hooks; aquí está entero.
//
// Ninguna función lanza: las llaman los hooks (invariante 4).
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, openTurnsPath } from './paths.mjs';
import { writeAtomic } from './atomic.mjs';
import { ageText, MODEL_TEXT_TTL_MS } from './time.mjs';
import { withFileLock } from './lock.mjs';

/**
 * Anota que esta sesión empezó un turno. capture.mjs la quita al cerrarlo
 * (closeTurn); si sobrevive, el turno se cortó, y la sesión siguiente lo
 * avisa (interruptedTurns).
 *
 * Solo en un proyecto donde chaski ya escribió algo: este hook corre en cada
 * mensaje de cualquier proyecto, y crear `.tambo/` en uno que nunca capturó
 * sería ensuciarle el árbol a alguien. Una escritura por turno, no por
 * llamada: en agy el hook corre varias veces por turno.
 */
export function openTurn(cwd, session, agent) {
  if (!session) return;
  try {
    const ruta = openTurnsPath(cwd);
    if (!existsSync(dirname(ruta)) || alreadyOpen(readOpenTurns(ruta), session)) return;
    withFileLock(ruta, () => {
      const current = readOpenTurns(ruta);
      if (alreadyOpen(current, session)) return;
      const ahora = Date.now();
      for (const [s, t] of Object.entries(current)) {
        if (!(ahora - Date.parse(t?.at ?? '') < MODEL_TEXT_TTL_MS)) delete current[s];
      }
      current[session] = { agent, at: new Date(ahora).toISOString() };
      writeAtomic(ruta, JSON.stringify(current, null, 2));
    });
  } catch {}
}

/**
 * Turnos de otras sesiones que siguen abiertos en este árbol de trabajo.
 * Un Stop de otra ventana actualiza Git y deja este turno abierto.
 */
export function interruptedTurns(cwd, sesionActual) {
  try {
    const abiertos = readOpenTurns(openTurnsPath(cwd));
    const ahora = Date.now();
    const lineas = [];
    for (const [s, t] of Object.entries(abiertos)) {
      const at = Date.parse(t?.at ?? '');
      if (s === sesionActual || !Number.isFinite(at) || at > ahora || ahora - at > MODEL_TEXT_TTL_MS) continue;
      const hace = ageText(at, ahora);
      lineas.push(`- Un turno de ${String(t.agent ?? 'otro agente').replace(/[^\w .-]/g, '')} empezó hace ${hace} y no terminó: se interrumpió, se cerró la ventana o se cortó (o sigue en curso en otra ventana).`);
      if (lineas.length === 3) break;
    }
    if (!lineas.length) return null;
    return [
      '**ATENCIÓN: hay turnos abiertos de otras conversaciones.**',
      ...lineas,
      '',
      'Pueden faltar comandos y cambios posteriores a la captura. Revisa `git status` y `git diff` antes de seguir.',
    ].join('\n');
  } catch {
    return null;
  }
}
/** Quita la marca de turno abierto de esta sesión. Nunca lanza. */
export function closeTurn(cwd, session) {
  if (!session) return;
  try {
    const ruta = openTurnsPath(cwd);
    if (!readOpenTurns(ruta)[session]) return;
    withFileLock(ruta, () => {
      const abiertos = readOpenTurns(ruta);
      if (!abiertos[session]) return;
      delete abiertos[session];
      writeAtomic(ruta, JSON.stringify(abiertos, null, 2));
    });
  } catch {}
}

function readOpenTurns(path) {
  const turns = readJson(path, null);
  return Object.assign(Object.create(null), turns);
}

// agy llama varias veces por turno. Una marca vieja corresponde a un
// turno anterior que no cerró y se renueva.
function alreadyOpen(turns, session) {
  return Date.now() - Date.parse(turns[session]?.at ?? '') < 60_000;
}
