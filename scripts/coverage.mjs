#!/usr/bin/env node
// Corre la suite con cobertura de src/ y falla si baja de los umbrales.
//
//   node scripts/coverage.mjs        (o npm run test:coverage)
//
// Es la red para «una funcionalidad nueva sin su test»: el código que ningún
// test ejecuta baja el porcentaje y deja el CI en rojo. Los umbrales son un
// trinquete: cuando la cobertura sube, súbelos; no los bajes para que pase un
// PR, agrega el test que falta.
//
// Los archivos de test salen del script `test` de package.json, para no
// mantener dos listas. La cobertura incluye los subprocesos (los hooks se
// prueban lanzando `node src/capture.mjs`): Node la recoge por
// NODE_V8_COVERAGE.
//
// Necesita Node >= 22.8 (umbrales y --test-coverage-include). El CI lo corre
// en la LTS; la suite normal sigue corriendo desde Node 20.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const THRESHOLDS = { lines: 98, functions: 98, branches: 79 };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 8)) {
  console.error(`coverage: necesita Node >= 22.8 (este es ${process.versions.node}).`);
  process.exit(1);
}

const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test;
const files = script.split(/\s+/).filter((a) => a.startsWith('test/') && a.endsWith('.test.mjs'));
if (!files.length) {
  console.error('coverage: no encontré archivos de test en el script `test` de package.json.');
  process.exit(1);
}

const r = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**',
  `--test-coverage-lines=${THRESHOLDS.lines}`,
  `--test-coverage-functions=${THRESHOLDS.functions}`,
  `--test-coverage-branches=${THRESHOLDS.branches}`,
  ...files,
], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
