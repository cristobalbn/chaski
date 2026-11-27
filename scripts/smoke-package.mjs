#!/usr/bin/env node
// Prueba de humo del paquete tal como lo recibe quien lo instala de npm.
//
//   node scripts/smoke-package.mjs      (o npm run smoke)
//
// La suite prueba el árbol del repo; esto prueba el tarball. Atrapa lo que
// la suite no ve: un módulo nuevo que no entra en `files` de package.json, un
// `bin` roto, un import que solo resuelve dentro del repo. Pasos:
//
//   1. `npm pack` del repo.
//   2. `npm install` del tarball en un prefijo descartable (sin red: cero
//      dependencias).
//   3. Con un HOME descartable y un repo git nuevo: `chaski version`,
//      `chaski init`, `chaski doctor`, una captura `Stop` y un `SessionStart`
//      que tiene que devolver el relevo.
//
// Nunca toca el HOME real (AGENTS.md): HOME, USERPROFILE, CODEX_HOME y
// XDG_CONFIG_HOME van en el entorno de cada subproceso.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'chaski-smoke-'));
const home = join(tmp, 'home');
const prefix = join(tmp, 'prefix');
const repo = join(tmp, 'repo');
for (const d of [home, prefix, repo]) mkdirSync(d, { recursive: true });

const env = {
  ...process.env,
  HOME: home, USERPROFILE: home,
  CODEX_HOME: join(home, '.codex'),
  XDG_CONFIG_HOME: join(home, '.config'),
  npm_config_cache: join(tmp, 'npm-cache'),
};
for (const k of ['CLAUDECODE', 'CLAUDE_PLUGIN_ROOT', 'CODEX_SESSION', 'AGY_SESSION', 'ANTIGRAVITY_SESSION']) delete env[k];

/**
 * CLIs falsos al frente del PATH: `init` solo configura (e instala la skill
 * y el bloque de AGENTS.md) si detecta algún CLI. En una máquina con los CLIs
 * reales pasaba igual sin esto; en el CI, sin ninguno, no instalaba nada.
 */
function fakeClis(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['claude', 'codex', 'agy', 'opencode']) {
    if (process.platform === 'win32') writeFileSync(join(dir, name + '.cmd'), '@echo off\r\nexit /b 0\r\n');
    else writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}
const fakeBin = fakeClis(join(tmp, 'bin'));
const sep = win ? ';' : ':';
env.PATH = fakeBin + sep + process.env.PATH;
env.Path = fakeBin + sep + (process.env.Path ?? process.env.PATH);

let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `\n      ${String(detail).trim().split('\n').join('\n      ')}` : ''}`);
  if (!ok) failed = true;
};
// npm es npm.cmd en Windows: sin shell no se encuentra.
const npm = (args, cwd) => execFileSync(win ? 'npm.cmd' : 'npm', args, { cwd, env, encoding: 'utf8', shell: win });

try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp], ROOT));
  const tarball = join(tmp, packed[0].filename);
  check(existsSync(tarball), `npm pack → ${packed[0].filename}`);

  // Todo módulo de src/ que el código importa tiene que viajar en el paquete.
  const inPackage = new Set(packed[0].files.map((f) => f.path.replace(/\\/g, '/')));
  const walk = (dir, rel = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]);
  const missing = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`).filter((f) => !inPackage.has(f));
  check(!missing.length, 'todo src/*.mjs está en el paquete', missing.join(', '));
  check(inPackage.has('skill/SKILL.md'), 'skill/SKILL.md está en el paquete');

  npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--offline', tarball], tmp);
  const installed = join(prefix, 'node_modules', ...pkg.name.split('/'));
  const cli = join(installed, 'src', 'cli.mjs');
  check(existsSync(cli), 'instalado desde el tarball');
  const bin = join(prefix, 'node_modules', '.bin', win ? 'chaski.cmd' : 'chaski');
  check(existsSync(bin), 'el bin `chaski` quedó enlazado');

  const chaski = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8' });
  check(chaski('version').trim() === `chaski ${pkg.version}`, `chaski version = ${pkg.version}`);

  const g = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  g('config', 'user.email', 'smoke@example.invalid');
  g('config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'app.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'inicial');

  const init = spawnSync(process.execPath, [cli, 'init'], { cwd: repo, env, encoding: 'utf8' });
  check(init.status === 0, 'chaski init', init.stderr || init.stdout);
  check(existsSync(join(repo, '.agents', 'skills', 'relevo', 'SKILL.md')), 'init instaló la skill');
  const doctor = chaski('doctor');
  check(/skill y AGENTS\s+al día/.test(doctor), 'chaski doctor: archivos del proyecto al día', doctor);

  writeFileSync(join(repo, 'app.js'), 'export const a = 2;\n');
  const hook = (script, event, payload) => spawnSync(process.execPath, [join(installed, 'src', script), event, 'codex'], {
    cwd: repo, env, encoding: 'utf8', input: JSON.stringify(payload),
  });
  const stop = hook('capture.mjs', 'Stop', { session_id: 'smoke-1', cwd: repo, hook_event_name: 'Stop' });
  check(stop.status === 0 && stop.stderr === '', 'Stop captura sin errores', stop.stderr);
  const start = hook('inject.mjs', 'SessionStart', { session_id: 'smoke-2', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  check(start.status === 0 && /<<<RELEVO-CHASKI[\s\S]*app\.js[\s\S]*<<<FIN-RELEVO-CHASKI>>>/.test(start.stdout),
    'SessionStart devuelve el relevo con el archivo modificado', start.stderr || start.stdout);

  const uninstall = spawnSync(process.execPath, [cli, 'uninstall'], { cwd: repo, env, encoding: 'utf8' });
  check(uninstall.status === 0, 'chaski uninstall', uninstall.stderr);
} catch (e) {
  check(false, 'la prueba de humo terminó con una excepción', e?.stack ?? e);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log(failed ? '\nsmoke: FALLÓ' : '\nsmoke: ok');
process.exit(failed ? 1 : 0);
