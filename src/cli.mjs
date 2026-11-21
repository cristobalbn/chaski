#!/usr/bin/env node
import { pkgVersion } from './commands/common.mjs';
import { init, uninstall } from './commands/install.mjs';
import { doctor } from './commands/doctor.mjs';
import { probe } from './commands/probe.mjs';
import { next, cost, why, share } from './commands/reports.mjs';

const accion = (process.argv[2] ?? 'doctor').toLowerCase();

try {
  if (accion === 'init') init(process.argv.slice(3));
  else if (accion === 'doctor') doctor();
  else if (accion === 'uninstall') uninstall();
  else if (accion === 'probe') probe(process.argv[3]);
  else if (accion === 'next') next();
  else if (accion === 'cost') cost();
  else if (accion === 'why') why(process.argv.slice(3));
  else if (accion === 'share') share(process.argv.slice(3));
  else if (accion === 'version' || accion === '--version' || accion === '-v') console.log(`chaski ${pkgVersion()}`);
  else {
    console.log('uso: chaski [init|doctor|uninstall|probe|next|cost|why|share|version|help]  (--version, -v, --help, -h)');
    console.log('  init      registra los hooks en los CLIs instalados, ignora .tambo/ en git e instala la skill');
    console.log('            --statusline: además envuelve tu statusline de Claude Code para anotar la cuota');
    console.log('  doctor    verifica qué quedó instalado y si los hooks están corriendo');
    console.log('  uninstall quita los hooks de chaski de la configuración de cada CLI (conserva .tambo/)');
    console.log('  next     muestra qué CLI está disponible y qué quedó pendiente');
    console.log('  cost     muestra el gasto externo ($0) y los turnos extra de chaski');
    console.log('  why      busca decisiones pasadas en .tambo/historia/ y decisiones/');
    console.log('  share    publica una decisión del relevo en decisiones/ (con confirmación)');
    console.log('  probe    captura el payload real de los hooks de cada CLI');
    console.log('  version  imprime la versión instalada de chaski');
    // Pedir ayuda no es un error; un subcomando que no existe sí.
    process.exitCode = ['help', '--help', '-h'].includes(accion) ? 0 : 1;
  }
} catch (e) {
  console.error(`\nchaski: ${e?.message ?? e}`);
  process.exitCode = 1;
}
