import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './paths.mjs';
import { MAX_CHARS, render } from './relay.mjs';
import { isValidSignature, relaySigner } from './signatures.mjs';
import { writeAtomic } from './atomic.mjs';

function readView(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * estado.json confirma la captura. relevo.md es una vista que puede quedar
 * pendiente si se interrumpe el proceso entre los dos renames.
 */
export function publishRelay(dir, state, config, previous = {}) {
  const path = join(dir, 'relevo.md');
  const markdown = render(state, config);
  const sign = relaySigner();
  let previousSignature = null;
  if (previous.signature) {
    let view = null;
    try { view = readView(path); }
    catch { previousSignature = previous.signature; }
    if (view !== null) {
      const signature = sign(view);
      if (signature === previous.signature || signature === previous.relay?.previousSignature) {
        previousSignature = signature;
      }
    }
  }

  const signature = sign(markdown);
  writeAtomic(join(dir, 'estado.json'), JSON.stringify({
    ...state, signature, relay: { markdown, previousSignature },
  }, null, 2));
  try { writeAtomic(path, markdown); }
  catch (error) {
    // El estado quedó confirmado. El historial y los pedidos aún se guardan.
    process.stderr.write('chaski: vista del relevo pendiente (' + error.message + ')\n');
  }
}

/** Lee primero la vista para que un escritor concurrente pueda adelantar el estado. */
export function readRelay(dir) {
  let view = null;
  try { view = readView(join(dir, 'relevo.md')); }
  catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'EISDIR'].includes(error.code)) throw error;
  }
  const state = readJson(join(dir, 'estado.json'), {}) ?? {};
  const snapshot = state.relay?.markdown;
  if (typeof snapshot === 'string' && snapshot.length <= MAX_CHARS && view !== snapshot
      && (view === null || (state.relay.previousSignature && isValidSignature(view, state.relay.previousSignature)))
      && isValidSignature(snapshot, state.signature)) {
    return { state, markdown: snapshot, recovered: true };
  }
  return view?.trim() ? { state, markdown: view, recovered: false } : null;
}
