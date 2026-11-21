// El payload que cada CLI le pasa a los hooks por stdin, normalizado.
//
// Los tres nombran sus campos distinto y ninguno prometió estabilidad entre
// versiones: Claude Code y Codex en snake_case, Antigravity en camelCase y con
// un arreglo de rutas en vez de `cwd`. Esta normalización vivía repetida en
// capture.mjs e inject.mjs, y las copias ya habían divergido (una aceptaba
// `conversationId`, la otra no). Un solo lugar, entonces.
//
// Regla: ante un campo raro, un valor neutro. Nunca lanzar (invariante 4).
import { readFileSync } from 'node:fs';
import { resolveTranscript } from './paths.mjs';

/** Lee stdin como objeto JSON. Cualquier otra cosa (vacío, roto, arreglo) es `{}`. */
export function readStdinJson() {
  let bruto = '';
  try { bruto = readFileSync(0, 'utf8'); } catch {}
  try {
    const v = JSON.parse(bruto);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Grafía única para un CLI. Los nombres con espacio viajan con guión en la
 * línea de comando (`claude-code`, ver `cmd()` en cli.mjs); aquí vuelven a su
 * forma legible, que es la que encabeza el relevo.
 */
export function canonicalAgent(agent) {
  const n = String(agent ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return n === 'claude' ? 'claude code' : (n || 'desconocido');
}

/** Id de la conversación, con el nombre que use cada CLI. */
export function sessionOf(ev) {
  const s = ev?.session_id ?? ev?.sessionId ?? ev?.conversationId ?? ev?.conversation_id ?? null;
  return typeof s === 'string' && s ? s : null;
}

/**
 * Directorio de trabajo de la sesión. Antigravity manda `workspacePaths`
 * (arreglo) en vez de `cwd`. Si lo que llega no es una ruta de texto, el del
 * proceso: un `cwd` raro tumbaba el hook (auditoría del 2026-11-20).
 */
export function cwdOf(ev) {
  const ws = Array.isArray(ev?.workspacePaths) ? ev.workspacePaths[0] : null;
  const c = ev?.cwd ?? ws ?? ev?.workspace ?? ev?.project_dir;
  return typeof c === 'string' && c ? c : process.cwd();
}

/**
 * Ruta del transcript TAL COMO LLEGA, sin resolver. Para la ruta que de
 * verdad se está escribiendo usa `transcriptOf()`.
 */
export function rawTranscriptOf(ev) {
  const t = ev?.transcript_path ?? ev?.transcriptPath ?? ev?.transcript;
  return typeof t === 'string' && t ? t : null;
}

/**
 * Ruta del transcript que se está escribiendo: tras un resume, Claude Code
 * manda la de un archivo que no existe (ver resolveTranscript en paths.mjs).
 * Lee la carpeta solo si la ruta no existe, así que en el caso normal no
 * cuesta nada; aun así, llámalo solo cuando haga falta.
 */
export function transcriptOf(ev) {
  return resolveTranscript(rawTranscriptOf(ev));
}

/** Nombre del evento: del payload, o del argumento con que se registró el hook. */
export function eventOf(ev, argv = process.argv) {
  const e = ev?.hook_event_name ?? ev?.hookEventName ?? ev?.event ?? argv[2];
  return typeof e === 'string' && e ? e : null;
}
