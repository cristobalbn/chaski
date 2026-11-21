#!/usr/bin/env node
// Statusline de Claude Code que anota la cuota (#82).
//
// Claude Code le pasa a la statusline, por stdin, cuánto va gastado de las
// ventanas de 5 h y 7 días (`rate_limits`, solo en planes Pro/Max/Ultra). Es
// el único lugar donde ese dato existe, y chaski lo necesita: la narrativa se
// pide temprano porque escribirla consume cuota, y sabiendo cuánta queda se
// puede pedir justo antes de que se acabe en vez de adivinar por turnos.
//
// Así que esto hace dos cosas, en este orden:
//   1. Anota `rate_limits` en ~/.chaski/usage.json (capture.mjs y `chaski
//      next` lo leen).
//   2. Delega en la statusline que el usuario ya tenía (guardada por `init
//      --statusline` en ~/.chaski/config.json → statusLineCommand) y devuelve
//      su salida tal cual. Sin una, imprime una línea mínima.
//
// Reglas, las mismas de los hooks: nunca falla (una statusline que sale con
// código distinto de 0 o sin salida queda en blanco), nunca llama a un modelo
// y es barata: corre con cada mensaje del asistente.
//
// El nombre del archivo no cambia nunca: `init --statusline` escribe su ruta
// absoluta en ~/.claude/settings.json (invariante 8).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, globalDir, readOnlyGlobalDir, usagePath } from './lib/paths.mjs';
import { writeAtomic } from './lib/atomic.mjs';
import { withFileLock } from './lib/lock.mjs';

main();

function main() {
  let bruto = '';
  try { bruto = readFileSync(0, 'utf8'); } catch {}
  let ev = {};
  try { ev = JSON.parse(bruto) || {}; } catch {}

  try { recordUsage(ev); } catch {}

  let salida = '';
  try { salida = delegate(bruto, ev); } catch {}
  if (!salida) salida = defaultLine(ev);
  process.stdout.write(salida.endsWith('\n') ? salida : salida + '\n');
  process.exitCode = 0;
}

/**
 * Anota las ventanas de cuota. Se escribe solo si algo cambió o pasó un
 * minuto: la statusline corre con cada mensaje y el dato cambia de a poco.
 */
function recordUsage(ev) {
  const rl = ev?.rate_limits;
  if (!rl || typeof rl !== 'object') return;
  const next = { fiveHour: quotaWindow(rl.five_hour), sevenDay: quotaWindow(rl.seven_day) };
  if (!next.fiveHour && !next.sevenDay) return;

  const path = usagePath();
  const now = Date.now();
  const unchanged = (previous) => {
    const at = Date.parse(previous?.at ?? '');
    return at <= now && now - at < 60_000
      && sameWindow(previous.fiveHour, next.fiveHour)
      && sameWindow(previous.sevenDay, next.sevenDay);
  };
  const agent = 'claude code';
  if (unchanged(readJson(path, null)?.[agent])) return;
  globalDir();
  withFileLock(path, () => {
    const usage = readJson(path, {}) ?? {};
    const previous = usage[agent];
    const ahead = Date.parse(previous?.at ?? '') - now;
    if (unchanged(previous) || (ahead > 0 && ahead < 60_000)) return;
    writeAtomic(path, JSON.stringify({ ...usage, [agent]: { at: new Date(now).toISOString(), ...next } }, null, 2));
  }, 40);
}

function quotaNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quotaWindow(window) {
  const usedPercentage = quotaNumber(window?.used_percentage);
  return usedPercentage === null ? null : { usedPercentage, resetsAt: quotaNumber(window?.resets_at) };
}

function sameWindow(a, b) {
  return a?.usedPercentage === b?.usedPercentage && a?.resetsAt === b?.resetsAt;
}

/**
 * Corre la statusline que el usuario tenía antes de `init --statusline`, con
 * el mismo stdin, y devuelve su salida. Vacío si no hay o si falla: ahí se
 * muestra la línea mínima en vez de dejar la barra en blanco.
 */
function delegate(bruto, ev) {
  // Protección contra recursión: si la statusline guardada como «la del
  // usuario» resulta ser una de chaski (una instalación vieja, otra copia), se
  // llamaría a sí misma sin fin. La variable la pone esta misma función al
  // delegar; si ya viene puesta, no se delega otra vez.
  if (process.env.CHASKI_STATUSLINE_DELEGATED) return '';
  const config = readJson(join(readOnlyGlobalDir(), 'config.json'), {}) ?? {};
  const comando = config.statusLineCommand;
  if (typeof comando !== 'string' || !comando.trim()) return '';
  const r = spawnSync(comando, {
    input: bruto,
    cwd: dirOk(ev?.cwd) ?? process.cwd(),
    env: { ...process.env, CHASKI_STATUSLINE_DELEGATED: '1' },
    encoding: 'utf8',
    // Claude Code corre la statusline con sh (o Git Bash en Windows); la del
    // usuario se escribió para eso. Si no hay bash a mano, el shell del sistema.
    shell: shellFor(),
    timeout: 3000,
    windowsHide: true,
  });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
}

function dirOk(d) {
  return typeof d === 'string' && d && existsSync(d) ? d : null;
}

function shellFor() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidatos = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.SHELL && /bash(\.exe)?$/i.test(process.env.SHELL) ? process.env.SHELL : null,
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  return candidatos.find((c) => c && existsSync(c)) ?? true;
}

/** Sin statusline propia: modelo y cuota, en una línea. */
function defaultLine(ev) {
  const partes = [];
  const modelo = ev?.model?.display_name;
  if (typeof modelo === 'string' && modelo) partes.push(modelo);
  const pct = (w) => {
    const value = quotaNumber(w?.used_percentage);
    return value === null ? null : `${Math.round(value)} %`;
  };
  const cinco = pct(ev?.rate_limits?.five_hour);
  const siete = pct(ev?.rate_limits?.seven_day);
  if (cinco) partes.push(`cuota 5 h ${cinco}`);
  if (siete) partes.push(`7 d ${siete}`);
  return partes.length ? partes.join(' · ') : 'chaski';
}
