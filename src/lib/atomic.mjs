import { closeSync, fchmodSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const WINDOWS = process.platform === 'win32';
const RENAME_DELAYS_MS = [20, 40, 60, 80];

function retryable(error) {
  return error.code === 'EBUSY' || (WINDOWS && (error.code === 'EPERM' || error.code === 'EACCES'));
}

function replaceFile(temp, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, target);
      return;
    } catch (error) {
      const delay = RENAME_DELAYS_MS[attempt];
      if (delay === undefined || !retryable(error)) {
        throw new Error('no se pudo reemplazar ' + target + ': ' + (error.code ?? error.message), { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** Publica un archivo completo con un temporal exclusivo en el mismo directorio. */
export function writeAtomic(path, text, { mode } = {}) {
  if (!WINDOWS && mode === undefined) {
    const existing = statSync(path, { throwIfNoEntry: false });
    if (existing) mode = existing.mode & 0o777;
  }

  const temp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temp, 'wx', mode);
  let replaced = false;
  try {
    try {
      writeFileSync(fd, text, 'utf8');
      if (!WINDOWS && mode !== undefined && (mode & process.umask()) !== 0) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    replaceFile(temp, path);
    replaced = true;
  } finally {
    if (!replaced) {
      try { unlinkSync(temp); } catch {}
    }
  }
}
