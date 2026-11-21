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
import { writeAtomic } from './relay.mjs';
import { ageText, MODEL_TEXT_TTL_MS } from './time.mjs';

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
    if (!existsSync(dirname(ruta))) return;
    const abiertos = readJson(ruta, {}) ?? {};
    // Una marca de esta sesión de hace menos de un minuto es este mismo turno
    // (agy llama varias veces por turno). Una más vieja es de un turno anterior
    // que no cerró: se renueva, porque la sesión sigue viva y trabajando.
    if (abiertos[session] && Date.now() - Date.parse(abiertos[session].at ?? '') < 60_000) return;
    const ahora = Date.now();
    for (const [s, t] of Object.entries(abiertos)) {
      if (!(ahora - Date.parse(t?.at ?? '') < MODEL_TEXT_TTL_MS)) delete abiertos[s];
    }
    abiertos[session] = { agent, at: new Date(ahora).toISOString() };
    writeAtomic(ruta, JSON.stringify(abiertos, null, 2));
  } catch {}
}

/**
 * Turnos de OTRAS sesiones que empezaron después del relevo y no terminaron.
 *
 * «Después del relevo» es la condición que importa: si hubo una captura
 * posterior, el relevo ya refleja el estado de después del corte. Si no, lo
 * que el agente nuevo lee es de antes de un turno que hizo algo y no llegó a
 * cerrar: puede haber archivos a medio editar o un comando a medio correr.
 * Los hechos de git se recalculan igual al arrancar; lo que puede faltar son
 * los comandos y el porqué.
 */
export function interruptedTurns(cwd, estado, sesionActual) {
  try {
    const abiertos = readJson(openTurnsPath(cwd), {}) ?? {};
    const desde = Date.parse(estado?.writtenAt ?? '') || 0;
    const ahora = Date.now();
    const lineas = [];
    for (const [s, t] of Object.entries(abiertos)) {
      const at = Date.parse(t?.at ?? '');
      if (s === sesionActual || !Number.isFinite(at) || at <= desde || ahora - at > MODEL_TEXT_TTL_MS) continue;
      const hace = ageText(at, ahora);
      lineas.push(`- Un turno de ${String(t.agent ?? 'otro agente').replace(/[^\w .-]/g, '')} empezó hace ${hace} y no terminó: se interrumpió, se cerró la ventana o se cortó (o sigue en curso en otra ventana).`);
    }
    if (!lineas.length) return null;
    return [
      '**ATENCIÓN: hubo un turno cortado después de este relevo.**',
      ...lineas,
      '',
      'Lo que ese turno hizo no está en el relevo. Revisa `git status` y `git diff` antes de seguir: puede haber archivos a medio editar.',
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
    if (!existsSync(ruta)) return;
    const abiertos = readJson(ruta, {}) ?? {};
    if (!(session in abiertos)) return;
    delete abiertos[session];
    writeAtomic(ruta, JSON.stringify(abiertos, null, 2));
  } catch {}
}
