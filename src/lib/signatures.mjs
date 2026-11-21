import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { globalDir, readOnlyGlobalDir } from './paths.mjs';
import { withFileLock } from './lock.mjs';
import { writeAtomic } from './atomic.mjs';

/** Clave local para firmar. Dos proyectos pueden arrancar a la vez. */
function signingKey() {
  const path = join(globalDir(), 'clave');
  const readKey = () => {
    try { return readFileSync(path, 'utf8').trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  };
  const existing = readKey();
  if (existing) return existing;
  const created = withFileLock(path, () => {
    const key = readKey();
    if (key) return key;
    const generated = randomBytes(32).toString('hex');
    writeAtomic(path, generated, { mode: 0o600 });
    return generated;
  });
  const key = created ?? readKey();
  if (!key) throw new Error('no se pudo inicializar la clave del relevo');
  return key;
}

function signatureOf(text, key) {
  return createHmac('sha256', key).update(text).digest('hex').slice(0, 16);
}

export function relaySigner() {
  const key = signingKey();
  return (text) => signatureOf(text, key);
}

export function sign(text) {
  return relaySigner()(text);
}

export function isValidSignature(text, signature) {
  if (typeof signature !== 'string' || !signature) return false;
  try {
    const key = readFileSync(join(readOnlyGlobalDir(), 'clave'), 'utf8').trim();
    return Boolean(key) && signature === signatureOf(text, key);
  } catch {
    return false;
  }
}
