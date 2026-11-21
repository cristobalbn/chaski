import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../lib/paths.mjs';

export const AQUI = fileURLToPath(new URL('..', import.meta.url));

export function backup(ruta) {
  if (!existsSync(ruta)) return;
  const bak = ruta + '.chaski-backup';
  if (!existsSync(bak)) copyFileSync(ruta, bak);
}

export function pkgVersion() {
  const pkg = readJson(resolve(AQUI, '..', 'package.json'), {}) ?? {};
  return pkg.version ?? '0.0.0';
}

export function pad(s) { return String(s).padEnd(15); }
