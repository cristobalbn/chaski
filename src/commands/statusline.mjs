import { join } from 'node:path';
import { globalDir, readJsonForWrite } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/relay.mjs';
import { pad, backup } from './common.mjs';
import { STATUSLINE, CLIS, isInstalled } from './hook-config.mjs';

/** ¿Este comando de statusline es el de chaski? */
export function isChaskiStatusLine(comando) {
  // Por la ruta `chaski/src/statusline.mjs` (o `@cristobalbn/chaski/src/...`
  // en una instalación de npm), no solo por el nombre del archivo: un usuario
  // con su propio `~/.claude/statusline.mjs` se tomaba por chaski, init no lo
  // envolvía y uninstall le borraba la statusline.
  if (typeof comando !== 'string') return false;
  // Y la ruta exacta de esta instalación, por si el repo se clonó en una
  // carpeta con otro nombre.
  const norm = (t) => t.replace(/\\/g, '/').toLowerCase();
  return /[\\/]chaski[\\/]src[\\/]statusline\.mjs"?\s*$/i.test(comando)
    || norm(comando).includes(norm(STATUSLINE));
}

/** El comando de statusline que init escribiría hoy, con las rutas de hoy. */
function statusLineCommandNow() {
  const q = (p) => `"${p.replace(/\//g, process.platform === 'win32' ? '\\' : '/')}"`;
  return `${q(process.execPath)} ${q(STATUSLINE)}`;
}

/**
 * Pone statusline.mjs como statusline de Claude Code, envolviendo la que el
 * usuario tenía: su comando queda en ~/.chaski/config.json → statusLineCommand
 * y statusline.mjs lo corre con el mismo stdin. `padding` y demás claves se
 * conservan. Idempotente.
 */
export function installStatusLine() {
  const cli = CLIS['claude code'];
  if (!isInstalled(cli.bin)) {
    console.log(`  ${pad('statusline')} Claude Code no instalado, se omite`);
    return;
  }
  try {
    const s = readJsonForWrite(cli.config);
    const actual = s.statusLine && typeof s.statusLine === 'object' ? s.statusLine : null;
    if (isChaskiStatusLine(actual?.command)) {
      // Ya es la de chaski, pero el comando lleva rutas absolutas (node y el
      // script): tras actualizar Node o mover chaski queda apuntando a la nada,
      // la barra se apaga y la cuota deja de anotarse sin aviso. Se reescribe
      // si cambió, igual que init reescribe los hooks.
      const ahora = statusLineCommandNow();
      if (actual.command === ahora) {
        console.log(`  ${pad('statusline')} ya instalada`);
        return;
      }
      s.statusLine = { ...actual, command: ahora };
      backup(cli.config);
      writeAtomic(cli.config, JSON.stringify(s, null, 2));
      console.log(`  ${pad('statusline')} actualizada a las rutas de esta instalación`);
      return;
    }
    const gRuta = join(globalDir(), 'config.json');
    const g = readJsonForWrite(gRuta);
    const previous = g.statusLineCommand;
    if (actual?.command) g.statusLineCommand = actual.command;
    else delete g.statusLineCommand;
    if (g.statusLineCommand !== previous) writeAtomic(gRuta, JSON.stringify(g, null, 2));
    s.statusLine = { ...(actual ?? {}), type: 'command', command: statusLineCommandNow() };
    backup(cli.config);
    writeAtomic(cli.config, JSON.stringify(s, null, 2));
    console.log(`  ${pad('statusline')} instalada${actual?.command ? `; envuelve la tuya: ${actual.command}` : ''}`);
  } catch (e) {
    console.log(`  ${pad('statusline')} FALLÓ: ${e?.message ?? e}`);
  }
}

/**
 * Deshace installStatusLine() sobre un settings.json ya leído: devuelve la
 * statusline del usuario a su lugar, o la quita si no había. Modifica `s`.
 */
export function restoreStatusLine(s) {
  if (!isChaskiStatusLine(s?.statusLine?.command)) return null;
  const gRuta = join(globalDir(), 'config.json');
  const g = readJsonForWrite(gRuta);
  if (typeof g.statusLineCommand === 'string' && g.statusLineCommand) {
    s.statusLine = { ...s.statusLine, command: g.statusLineCommand };
  } else {
    delete s.statusLine;
  }
  // Solo descarta el respaldo despu\u00e9s de persistir la restauraci\u00f3n.
  return () => {
    if (!('statusLineCommand' in g)) return;
    const current = readJsonForWrite(gRuta);
    if (current.statusLineCommand !== g.statusLineCommand) return;
    delete current.statusLineCommand;
    writeAtomic(gRuta, JSON.stringify(current, null, 2));
  };
}
