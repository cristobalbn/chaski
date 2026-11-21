import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const STALE_MS = 30_000;

// Para archivos con varios escritores, el rename atómico protege la lectura
// y este lock corto protege todo el ciclo de leer, modificar y escribir.
// El lock no se comparte con las operaciones lentas de la captura.
export function withFileLock(file, update, timeout = 250) {
  const lock = file + '.lock';
  const deadline = performance.now() + timeout;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!['EEXIST', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmdirSync(lock);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return undefined;
      pause(Math.min(5, remaining));
    }
  }
  try {
    return update();
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmdirSync(lock); break; }
      catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) break;
        pause(5);
      }
    }
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
