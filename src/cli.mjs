#!/usr/bin/env node
// Cada invocación carga solo el módulo del subcomando que va a ejecutar.
const commands = new Map([
  ['init', async (args) => (await import('./commands/install.mjs')).init(args)],
  ['doctor', async () => (await import('./commands/doctor.mjs')).doctor()],
  ['uninstall', async () => (await import('./commands/install.mjs')).uninstall()],
  ['probe', async ([action]) => (await import('./commands/probe.mjs')).probe(action)],
  ['next', async () => (await import('./commands/reports.mjs')).next()],
  ['cost', async () => (await import('./commands/reports.mjs')).cost()],
  ['why', async (args) => (await import('./commands/reports.mjs')).why(args)],
  ['share', async (args) => (await import('./commands/reports.mjs')).share(args)],
  ['version', async () => console.log(`chaski ${(await import('./commands/common.mjs')).pkgVersion()}`)],
]);

const [requested = 'doctor', ...args] = process.argv.slice(2);
const action = requested.toLowerCase();
const command = commands.get(['--version', '-v'].includes(action) ? 'version' : action);

try {
  if (command) {
    await command(args);
  } else {
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
    process.exitCode = ['help', '--help', '-h'].includes(action) ? 0 : 1;
  }
} catch (e) {
  console.error(`\nchaski: ${e?.message ?? e}`);
  process.exitCode = 1;
}
