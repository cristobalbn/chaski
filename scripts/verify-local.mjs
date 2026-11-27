#!/usr/bin/env node
// Contrasta el contrato de transcript con los transcripts REALES de esta
// máquina: el más reciente de Claude Code, Codex y agy. Es el paso de
// verificación que pide el informe de scripts/upstream.mjs cuando un CLI
// publica versiones nuevas (AGENTS.md, «Versiones soportadas»).
//
// Solo imprime formas y conteos —versión, turnos, comandos con su código de
// salida, tipos de registro que los fixtures no tienen—, nunca contenido: un
// transcript real lleva la conversación completa de alguien.
//
//   node scripts/verify-local.mjs                 los tres, el más reciente de cada uno
//   node scripts/verify-local.mjs codex <ruta>    uno en particular
//
// OpenCode no está aquí: no escribe transcript. Se verifica con la sonda de
// plugin y un turno real (ver la sección de OpenCode en AGENTS.md).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { transcriptFacts } from '../src/lib/transcript.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = {
  claude: ['claude-code.transcript.jsonl'],
  codex: ['codex.transcript.jsonl', 'codex-code-mode.transcript.jsonl', 'codex-legacy.transcript.jsonl'],
  agy: ['agy.transcript.jsonl', 'agy-tool-calls.transcript.jsonl'],
};

/** Archivos que cumplen `filtro` bajo `dir`, hasta `prof` niveles. */
function buscar(dir, filtro, prof = 4, out = []) {
  if (prof < 0 || !existsSync(dir)) return out;
  for (const nombre of readdirSync(dir)) {
    const p = join(dir, nombre);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) buscar(p, filtro, prof - 1, out);
    else if (filtro(p)) out.push({ p, t: st.mtimeMs, size: st.size });
  }
  return out;
}

const lineas = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/** La última versión que figura en un transcript: una sesión retomada tras actualizar lleva las dos. */
const versionDe = (registros) => registros.map((e) => e.version ?? e.payload?.cli_version).filter(Boolean).at(-1) ?? null;

const comparar = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * El transcript que mejor prueba la versión actual: entre los 6 más recientes
 * (con al menos 3 registros: una conversación abortada no prueba nada), el de
 * versión más alta, y a igual versión el más reciente. Elegir solo el más
 * reciente tomaba la sesión que estaba corriendo la verificación, que puede
 * ser de una versión anterior (pasó el 2026-11-27).
 */
function elegir(cli) {
  const home = homedir();
  const candidatos = {
    claude: () => buscar(join(home, '.claude', 'projects'), (p) => p.endsWith('.jsonl'), 1),
    codex: () => buscar(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'), (p) => p.endsWith('.jsonl'), 3),
    agy: () => buscar(join(home, '.gemini', 'antigravity-cli', 'brain'), (p) => p.endsWith('transcript_full.jsonl'), 4),
  }[cli]().sort((a, b) => b.t - a.t).slice(0, 6)
    .map((f) => { const r = lineas(f.p); return { ...f, n: r.length, version: versionDe(r) }; })
    .filter((f) => f.n >= 3);
  candidatos.sort((a, b) => (a.version && b.version ? comparar(b.version, a.version) : 0) || b.t - a.t);
  return candidatos[0] ?? null;
}

/**
 * Versión del binario que está primero en el PATH. Si no coincide con la del
 * transcript, la sesión la corrió otro binario: pasó con la terminal de
 * VS Code, que antepone el Codex de su extensión al instalado con npm.
 */
function instalada(cli) {
  try {
    // Comando de texto fijo y con shell: en Windows `codex` y `agy` son shims
    // .cmd, y pasar argumentos aparte junto con `shell` está deprecado (DEP0190).
    const r = spawnSync(`${cli} --version`, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true });
    return /(\d+\.\d+\.\d+)/.exec(String(r.stdout ?? ''))?.[1] ?? null;
  } catch {
    return null;
  }
}

const tipo = (e) => (e.step_index !== undefined || e.stepIndex !== undefined ? `agy:${e.type ?? '?'}`
  : e.type === 'response_item' || e.type === 'event_msg' ? `${e.type}:${e.payload?.type}` : String(e.type ?? e.role ?? '?'));

function verificar(cli, archivo, fecha) {
  const real = lineas(archivo);
  const tiposFx = new Set(FIXTURES[cli].flatMap((f) => lineas(join(RAIZ, 'test', 'fixtures', f)).map(tipo)));
  const nuevos = [...new Set(real.map(tipo))].filter((x) => !tiposFx.has(x));
  const version = versionDe(real) ?? 'no figura en el transcript';
  const enPath = instalada(cli);
  const t = transcriptFacts(archivo, 0, {});
  const exits = { ok: 0, error: 0, desconocido: 0 };
  for (const c of t.commands) exits[c.exit === null ? 'desconocido' : c.exit === 0 ? 'ok' : 'error']++;
  const problemas = [];
  if (!t.turns) problemas.push('no contó ningún turno');
  if (!t.lastMessage) problemas.push('no encontró la última respuesta');
  if (!t.commands.length) problemas.push('no extrajo ningún comando (¿la sesión no corrió ninguno?)');
  if (exits.desconocido > 1) problemas.push(`${exits.desconocido} comandos sin código de salida (uno puede ser el que está corriendo)`);

  console.log(`\n${cli}  ·  versión del transcript: ${version}  ·  en el PATH: ${enPath ?? '?'}  ·  transcript del ${fecha}  ·  ${real.length} registros`);
  if (enPath && /^\d/.test(version) && comparar(version, enPath) !== 0) {
    console.log(`  ⚠ el transcript es de ${version} y el PATH tiene ${enPath}: esa sesión la corrió otro binario (¿la terminal de un IDE?). No verifica ${enPath}.`);
  }
  console.log(`  turnos ${t.turns} · comandos ${t.commands.length} (${exits.ok} ok, ${exits.error} error, ${exits.desconocido} sin código)`
    + ` · archivos leídos ${t.filesRead.length} · última respuesta ${t.lastMessage ? 'sí' : 'NO'}`);
  console.log(`  tipos que los fixtures no tienen: ${nuevos.join(', ') || '(ninguno)'}`);
  console.log(problemas.length ? `  ✖ ${problemas.join('; ')}` : '  ✔ el contrato se sostiene');
  return problemas.length === 0;
}

const [cliArg, rutaArg] = process.argv.slice(2);
let ok = true;
for (const cli of cliArg ? [cliArg] : Object.keys(FIXTURES)) {
  if (!FIXTURES[cli]) { console.error(`CLI desconocido: ${cli} (claude, codex, agy)`); process.exitCode = 2; break; }
  const f = rutaArg ? { p: rutaArg, t: statSync(rutaArg).mtimeMs } : elegir(cli);
  if (!f) { console.log(`\n${cli}  ·  sin transcripts en esta máquina, se omite`); continue; }
  ok = verificar(cli, f.p, new Date(f.t).toISOString().slice(0, 10)) && ok;
}
console.log('\nLos tipos nuevos no son un error: el extractor ignora lo que no conoce. Lo que importa es que'
  + ' turnos, comandos y última respuesta sigan saliendo. Si algo falla, captura la forma con `chaski probe`.');
if (!ok && !process.exitCode) process.exitCode = 1;
