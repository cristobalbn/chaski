import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { globalDir, readJsonForWrite } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/relay.mjs';
import { pad } from './common.mjs';
import { MARCA_INI, MARCA_FIN, cmd, CLIS, isInstalled, isProbeHookGroup, removeBlock } from './hook-config.mjs';

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
        const lineas = [MARCA_INI];
        for (const ev of eventos.slice(0, 2)) {
          lineas.push(`[[hooks.${ev}]]`, `[[hooks.${ev}.hooks]]`, 'type = "command"',
            // JSON.stringify es obligatorio: en TOML, "C:\Program Files\nodejs"
            // interpreta \n como salto de línea y el comando queda destruido.
            'command = ' + JSON.stringify(probeCmd(ev, name, true)), '');
        }
        lineas.push(MARCA_FIN);
        writeAtomic(cli.config, removeBlock(previo).trimEnd() + '\n\n' + lineas.join('\n') + '\n');
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
  for (const [name, cli] of Object.entries(CLIS)) {
    const bak = cli.config + '.chaski-probe';
    try {
      if (existsSync(bak)) { copyFileSync(bak, cli.config); unlinkSync(bak); console.log(`  ${pad(name)} restaurado`); }
      else if (existsSync(cli.config)) {
        if (cli.formato === 'toml-codex') writeAtomic(cli.config, removeBlock(readFileSync(cli.config, 'utf8')).trimEnd() + '\n');
        else {
          const s = readJsonForWrite(cli.config);
          delete s.chaskiProbe;
          if (s.hooks) for (const ev of Object.keys(s.hooks)) {
            s.hooks[ev] = (s.hooks[ev] ?? []).filter((g) => !isProbeHookGroup(g));
            if (!s.hooks[ev].length) delete s.hooks[ev];
          }
          writeAtomic(cli.config, JSON.stringify(s, null, 2));
        }
        console.log(`  ${pad(name)} sonda removida`);
      }
    } catch (e) { console.log(`  ${pad(name)} FALLÓ: ${e?.message ?? e}`); }
  }
  try { unlinkSync(probePath()); } catch {}
  console.log(`\nEl log queda en ${probeLogPath()} por si lo quieres mandar como fixture.\n`);
}

function backupForProbe(ruta) {
  if (!existsSync(ruta)) return;
  const bak = ruta + '.chaski-probe';
  if (!existsSync(bak)) copyFileSync(ruta, bak);
}
