import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { globalDir, readJsonForWrite } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/atomic.mjs';
import { pad } from './common.mjs';
import { PROBE_START, PROBE_END, cmd, findBlock, CLIS, isInstalled, isProbeHookGroup, removeBlock } from './hook-config.mjs';

// --------------------------------------------------------------- probe
//
// Captura el payload crudo que cada CLI le pasa a sus hooks.
//
// Existe porque los payloads de Codex y agy no están documentados campo por
// campo, y porque NINGUNO de los tres dispara hooks en modo headless: hay que
// abrir una sesión interactiva de verdad. Verificado con `claude -p`,
// `codex exec` y `agy -p` — en los tres casos el hook no corre.
//
// Si usas esto para capturar un payload nuevo, envíalo como fixture:
// es la contribución más útil al proyecto ahora mismo.

function probePath() { return join(globalDir(), 'sonda.mjs'); }
function probeLogPath() { return join(globalDir(), 'sonda.log'); }

export function probe(sub) {
  if (sub === '--show' || sub === 'show') return probeShow();
  if (sub === '--clean' || sub === 'clean') return probeClean();

  console.log('\nchaski probe — captura de payloads\n');
  writeAtomic(probePath(), [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "let raw = ''; try { raw = readFileSync(0, 'utf8'); } catch {}",
    `appendFileSync(${JSON.stringify(probeLogPath())},`,
    "  '\\n===== ' + (process.argv[2] || '?') + ' | ' + (process.argv[3] || '?') +",
    "  ' | ' + new Date().toISOString() + '\\n' + raw.slice(0, 4000) + '\\n');",
  ].join('\n'));
  try { unlinkSync(probeLogPath()); } catch {}

  for (const [name, cli] of Object.entries(CLIS)) {
    if (!isInstalled(cli.bin)) continue;
    try {
      backupForProbe(cli.config);
      const eventos = cli.formato === 'json-agy'
        ? ['SessionStart', 'Stop', 'PostInvocation']
        : ['SessionStart', 'Stop', 'SessionEnd'];
      if (cli.formato === 'json-claude') {
        const s = readJsonForWrite(cli.config);
        s.hooks = s.hooks ?? {};
        for (const ev of eventos) {
          s.hooks[ev] = [...(s.hooks[ev] ?? []).filter((g) => !isProbeHookGroup(g)),
            { hooks: [{ type: 'command', command: probeCmd(ev, name), timeout: 15 }] }];
        }
        writeAtomic(cli.config, JSON.stringify(s, null, 2));
      } else if (cli.formato === 'json-agy') {
        mkdirSync(dirname(cli.config), { recursive: true });
        const h = readJsonForWrite(cli.config);
        h.chaskiProbe = Object.fromEntries(eventos.map((ev) =>
          [ev, [{ type: 'command', command: probeCmd(ev, name, true), timeout: 15 }]]));
        writeAtomic(cli.config, JSON.stringify(h, null, 2));
      } else {
        mkdirSync(dirname(cli.config), { recursive: true });
        const previo = existsSync(cli.config) ? readFileSync(cli.config, 'utf8') : '';
        const lineas = [PROBE_START];
        for (const ev of eventos.slice(0, 2)) {
          lineas.push(`[[hooks.${ev}]]`, `[[hooks.${ev}.hooks]]`, 'type = "command"',
            // JSON.stringify es obligatorio: en TOML, "C:\Program Files\nodejs"
            // interpreta \n como salto de línea y el comando queda destruido.
            'command = ' + JSON.stringify(probeCmd(ev, name, true)), '');
        }
        lineas.push(PROBE_END);
        writeAtomic(cli.config, withoutCodexProbe(previo, cli.config).trimEnd() + '\n\n' + lineas.join('\n') + '\n');
      }
      console.log(`  ${pad(name)} sonda instalada`);
    } catch (e) {
      console.log(`  ${pad(name)} FALLÓ: ${e?.message ?? e}`);
    }
  }

  console.log('\nAhora, por cada CLI que quieras validar:');
  console.log('  1. Abrilo en modo INTERACTIVO (no con -p ni exec: en headless');
  console.log('     ninguno de los tres dispara hooks).');
  console.log('  2. Escribile cualquier cosa y espera la respuesta.');
  console.log('  3. Ciérralo.');
  console.log('\nDespués:');
  console.log('  chaski probe --show       ver lo capturado');
  console.log('  chaski probe --clean      quitar la sonda\n');
}

function probeCmd(event, agent, viaEnvoltorio = false) {
  return cmd(probePath(), event, agent, viaEnvoltorio);
}

function probeShow() {
  if (!existsSync(probeLogPath())) {
    console.log('\nNo se capturó nada todavía.');
    console.log('Abre una sesión interactiva de algún CLI y vuelve a intentar.\n');
    return;
  }
  console.log('\n' + readFileSync(probeLogPath(), 'utf8'));
  console.log(`\n(archivo completo: ${probeLogPath()})`);
  console.log('Si tienes un payload de Codex o agy, envíalo como fixture al proyecto.\n');
}

function probeClean() {
  console.log('\nQuitando la sonda\n');
  let failed = false;
  for (const [name, cli] of Object.entries(CLIS)) {
    try {
      if (!existsSync(cli.config)) continue;
      const before = readFileSync(cli.config, 'utf8');
      let after;
      if (cli.formato === 'toml-codex') {
        after = withoutCodexProbe(before, cli.config);
      } else {
        const s = readJsonForWrite(cli.config);
        const original = JSON.stringify(s);
        if (cli.formato === 'json-agy') delete s.chaskiProbe;
        else {
          for (const [ev, groups] of Object.entries(s.hooks ?? {})) {
            if (!Array.isArray(groups)) continue;
            const remaining = groups.filter((g) => !isProbeHookGroup(g));
            if (remaining.length === groups.length) continue;
            if (remaining.length) s.hooks[ev] = remaining;
            else delete s.hooks[ev];
          }
        }
        after = JSON.stringify(s) === original ? before : JSON.stringify(s, null, 2);
      }
      if (after !== before) {
        writeAtomic(cli.config, after);
        console.log(`  ${pad(name)} sonda removida`);
      }
      const backup = cli.config + '.chaski-probe';
      if (existsSync(backup)) unlinkSync(backup);
    } catch (e) {
      failed = true;
      console.log(`  ${pad(name)} FALL\u00d3: ${e?.message ?? e}`);
    }
  }
  if (!failed && existsSync(probePath())) unlinkSync(probePath());
  console.log(`\nEl log queda en ${probeLogPath()} por si lo quieres mandar como fixture.\n`);
}

// Las sondas antiguas reemplazaban el bloque normal. Recupera solo ese
// bloque del respaldo, junto con las tablas de confianza que contenga.
function withoutCodexProbe(text, path) {
  const cleaned = removeBlock(text, PROBE_START, PROBE_END);
  const legacy = findBlock(cleaned);
  if (!legacy) return cleaned;
  const current = cleaned.slice(legacy.from, legacy.to);
  const legacyCommands = [...current.matchAll(/^command\s*=\s*(".*")\s*$/gm)];
  const isLegacyProbe = legacyCommands.some(([, encoded]) => {
    try { return isProbeHookGroup({ command: JSON.parse(encoded) }); }
    catch { return false; }
  });
  if (!isLegacyProbe) return cleaned;
  const backup = path + '.chaski-probe';
  const previous = existsSync(backup) ? readFileSync(backup, 'utf8') : '';
  const original = findBlock(previous);
  const recovered = original ? previous.slice(original.from, original.to) : '';
  return cleaned.slice(0, legacy.from) + recovered + cleaned.slice(legacy.to);
}

function backupForProbe(ruta) {
  if (!existsSync(ruta)) return;
  const bak = ruta + '.chaski-probe';
  if (!existsSync(bak)) copyFileSync(ruta, bak);
}
