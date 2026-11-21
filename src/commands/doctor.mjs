import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalDir, readJson, syncedFolder, tamboIsIgnored, orphanRelays, effectivePruneDays, loadConfig, promptHookPath, claudePluginEnabled, CLAUDE_PLUGIN_ID, usagePath, readOnlyRelayPath, readOnlyStatePath, stripBom } from '../lib/paths.mjs';
import { PROMPT_HOOK_EVENTS, promptHookAlive, usageSummary } from '../lib/ask.mjs';
import { isValidSignature } from '../lib/relay.mjs';
import { pkgVersion, pad } from './common.mjs';
import { CAPTURE, INJECT, CLIS, isInstalled } from './hook-config.mjs';
import { projectContext, projectRootNote } from './project.mjs';
import { isChaskiStatusLine } from './statusline.mjs';

export function doctor() {
  const { cwd, workspace } = projectContext();
  console.log(`\nchaski doctor (v${pkgVersion()})\n`);

  const plugin = claudePluginEnabled(cwd);
  const cliStatus = Object.entries(CLIS).map(([name, cli]) => {
    const installed = isInstalled(cli.bin);
    const hasConfig = installed && existsSync(cli.config);
    const events = hasConfig ? registeredEvents(cli) : null;
    return { name, cli, installed, hasConfig, events };
  });

  console.log('CLIs y hooks');
  for (const status of cliStatus) {
    console.log(`  ${pad(status.name)} ${describeHooks(status, plugin)}`);
  }

  console.log('\nEjecutables del hook');
  for (const [etiqueta, script] of [['capture', CAPTURE], ['inject', INJECT]]) {
    console.log(`  ${pad(etiqueta)} ${existsSync(script) ? 'ok' : 'FALTA'}  ${script}`);
  }

  console.log('\nLatidos (última vez que cada CLI ejecutó el hook)');
  const lat = readJson(join(globalDir(), 'latidos.json'), {}) ?? {};
  if (!Object.keys(lat).length) console.log('  ninguno todavía — abre una sesión y vuelve a revisar');
  for (const [a, iso] of Object.entries(lat)) {
    const days = (Date.now() - new Date(iso).getTime()) / 86400000;
    console.log(`  ${pad(a)} ${iso.slice(0, 16).replace('T', ' ')}${days > 1 ? `  ← hace ${Math.round(days)} día(s)` : ''}`);
  }

  // Un CLI con hooks registrados que nunca estampó heartbeat es el síntoma de un
  // paso pendiente, no de un bug. Se diagnostica aquí en lugar de dejar al
  // usuario adivinando por qué .tambo/ sigue vacío.
  const sinLatido = cliStatus.filter(({ name, events }) => events?.length
    && !Object.keys(lat).some((key) => key.replace(/-/g, ' ') === name));
  for (const { name } of sinLatido) {
    console.log(`\n  ⚠ ${name}: hooks registrados pero nunca ejecutados.`);
    if (name === 'codex') {
      console.log('    Codex pide confiar en los hooks la primera vez que lo abres.');
      console.log('    Acepta ("trust all") y vuelve a abrirlo: el permiso se aplica');
      console.log('    desde la sesión siguiente.');
    } else {
      console.log('    Abre una sesión interactiva y escribe algo. Si sigue sin');
      console.log('    aparecer, revisa el log del CLI: suele decir por qué falló.');
    }
  }

  // #73: la petición de narrativa solo se difiere al turno siguiente si el
  // hook de entrega de ese CLI corre. Mientras no, llega debajo de la
  // respuesta, y sin esta línea el usuario no tendría cómo saber por qué.
  console.log('\nPetición de narrativa (antes de la respuesta o después)');
  const vivos = readJson(promptHookPath(), {}) ?? {};
  for (const { name, hasConfig, events } of cliStatus) {
    if (!hasConfig) continue;
    const evento = PROMPT_HOOK_EVENTS[name];
    const registrado = (name === 'claude code' && plugin) || events?.includes(evento);
    let nota;
    if (!registrado) nota = `después de la respuesta — falta el hook ${evento}: ejecuta init`;
    else if (promptHookAlive(vivos, name)) nota = 'antes de la respuesta';
    else if (name === 'codex') nota = `después de la respuesta hasta que ${evento} corra — Codex pide confiar en el hook nuevo`;
    else nota = `después de la respuesta hasta que ${evento} corra — escribe un mensaje en una sesión nueva`;
    console.log(`  ${pad(name)} ${nota}`);
  }

  // #82: sin la statusline de chaski no hay dato de cuota, y la narrativa se
  // pide por turnos y commits en vez de antes de que la cuota se acabe.
  const claude = cliStatus.find(({ name }) => name === 'claude code');
  if (claude.installed) {
    console.log('\nCuota (statusline de Claude Code)');
    const sl = readJson(claude.cli.config, {})?.statusLine;
    if (!isChaskiStatusLine(sl?.command)) {
      console.log(`  ${pad('claude code')} sin dato — ejecuta \`chaski init --statusline\` para pedir la narrativa antes de que se acabe`);
    } else {
      const resumen = usageSummary((readJson(usagePath(), {}) ?? {})['claude code'], Date.now(), Infinity);
      console.log(`  ${pad('claude code')} ${resumen ?? 'statusline instalada; todavía sin dato (solo planes Pro, Max y Ultra, tras la primera respuesta)'}`);
    }
  }

  console.log('\nProyecto');
  console.log(`  ${pad('directorio')} ${cwd}`);
  for (const l of projectRootNote(cwd, workspace)) console.log(`  ${pad('')} ${l}`);
  const sync = syncedFolder(cwd);
  console.log(`  ${pad('sincronizada')} ${sync ? `sí (${sync}) — se usa escritura atómica` : 'no'}`);
  console.log(`  ${pad('.tambo en git')} ${tamboIsIgnored(cwd) ? 'ignorado, correcto' : 'NO IGNORADO — ejecuta init'}`);

  const huerfanos = orphanRelays(cwd);
  if (huerfanos.length) {
    const withNarrative = huerfanos.filter((h) => h.withNarrative).length;
    // Plazos reales de la config, no los valores por defecto: con `0` la
    // poda se desactiva y decir «viven 90 días» sería mentir.
    const cfg = loadConfig(cwd);
    const dias = effectivePruneDays({ factsOnly: cfg.pruneAfterDays, withNarrative: cfg.pruneNarrativeAfterDays });
    let nota = '';
    if (withNarrative) {
      nota = dias.facts === 0 || dias.narrative === 0
        ? `, ${withNarrative} con narrativa (la poda de esos relevos está desactivada)`
        : `, ${withNarrative} con narrativa (viven ${dias.narrative} días en vez de ${dias.facts})`;
    }
    console.log(`  ${pad('huérfanos')} ${huerfanos.length} relevo(s) de ramas que ya no existen` + nota);
  }

  const relevo = readOnlyRelayPath(cwd);
  if (existsSync(relevo)) {
    const estado = readJson(readOnlyStatePath(cwd), {}) ?? {};
    const md = readFileSync(relevo, 'utf8');
    const edad = estado.writtenAt ? Math.round((Date.now() - new Date(estado.writtenAt).getTime()) / 60000) : null;
    console.log(`  ${pad('relevo')} ${md.length} caracteres${edad !== null ? `, escrito hace ${edad} min` : ''}`);
    console.log(`  ${pad('firma')} ${estado.signature ? (isValidSignature(md, estado.signature) ? 'válida' : 'NO VALIDA — editado fuera de chaski') : 'sin firma'}`);
    console.log(`  ${pad('narrativa')} ${estado.narrative ? `sí, por ${estado.narrativeAuthor ?? '?'}` : 'no — escribe «relevo» en el chat del agente'}`);
  } else {
    console.log(`  ${pad('relevo')} todavía no existe para esta rama`);
  }

  console.log('\nQué sale de esta máquina');
  console.log(`  ${pad('capture')} nada: solo lee archivos locales y git`);
  console.log(`  ${pad('inject')} nada: imprime un archivo local`);
  console.log(`  ${pad('skill relevo')} usa el agente que ya tienes abierto (uso interactivo)`);
  console.log(`  ${pad('llamadas')} chaski NO invoca claude -p, codex exec ni agy -p\n`);
}

function describeHooks({ installed, hasConfig, cli, events }, plugin) {
  if (!installed) return 'no instalado';
  if (cli.formato === 'json-claude' && plugin) {
    return `vía plugin ${CLAUDE_PLUGIN_ID}` + (events?.length
      ? ' — también hay hooks en settings.json: se silencian solos, pero corre init para quitarlos'
      : '');
  }
  if (!hasConfig) return 'sin config — ejecuta init';
  if (events === null) return 'config ilegible — revisa el archivo';
  if (!events.length) return 'hooks NO registrados — ejecuta init';
  return `registrado (${events.join(', ')})`;
}

/**
 * Eventos con un hook de chaski de verdad registrado, según la estructura de
 * cada formato. `null` si el archivo no se puede leer o parsear.
 *
 * Antes bastaba con que el texto contuviera "chaski" y se sacaban los eventos
 * con una regex sobre todo el archivo (#51): un comentario que mencionara
 * chaski, SessionStart y Stop hacía que doctor declarara hooks que no existían
 * y mandara al usuario a conceder confianza en Codex por nada. Ahora cuenta
 * solo un comando que apunte a un script o wrapper de chaski, dentro de la
 * clave de hooks que ese CLI realmente lee.
 */
function registeredEvents(cli) {
  let txt;
  try { txt = stripBom(readFileSync(cli.config, 'utf8')); } catch { return null; }
  // Un comando que ejecuta un hook de chaski: los scripts de entrada (y los
  // puentes con nombres viejos) o un wrapper generado en ~/.chaski/.
  const HOOK_DE_CHASKI = /(?:capture|inject|capturar|leer)\.mjs|[\\/]\.chaski[\\/][\w.-]+\.(?:cmd|sh)\b/;
  const eventos = new Set();
  const esNuestro = (c) => typeof c === 'string' && HOOK_DE_CHASKI.test(c);

  if (cli.formato === 'toml-codex') {
    // Sin parser TOML (cero dependencias): se recorren las líneas, se ignoran
    // los comentarios y se atribuye cada `command` a la tabla `[[hooks.X…]]`
    // en la que aparece.
    let evento = null;
    for (const linea of txt.split(/\r?\n/)) {
      const l = linea.trim();
      if (!l || l.startsWith('#')) continue;
      const tabla = l.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/);
      if (tabla) {
        const m = tabla[1].match(/^hooks\.([A-Za-z]+)(?:\.hooks)?$/);
        evento = m ? m[1] : null;
        continue;
      }
      const c = l.match(/^command\s*=\s*(".*"|'.*')/);
      if (evento && c) {
        let valor;
        try { valor = c[1].startsWith('"') ? JSON.parse(c[1]) : c[1].slice(1, -1); } catch { valor = c[1]; }
        if (esNuestro(valor)) eventos.add(evento);
      }
    }
    return [...eventos];
  }

  let datos;
  try { datos = JSON.parse(txt); } catch { return null; }
  if (!datos || typeof datos !== 'object') return [];

  if (cli.formato === 'json-claude') {
    // hooks.<Evento> = [{ matcher?, hooks: [{ type, command }] }]
    for (const [ev, grupos] of Object.entries(datos.hooks ?? {})) {
      if (!Array.isArray(grupos)) continue;
      const hay = grupos.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => esNuestro(h?.command)));
      if (hay) eventos.add(ev);
    }
  } else if (cli.formato === 'json-agy') {
    // <propietario>.<Evento> = [{ type, command }] o, en PreToolUse y
    // PostToolUse, [{ matcher, hooks: [...] }]. Se mira cualquier propietario
    // por si alguien movió el bloque, pero solo cuentan comandos de chaski.
    for (const owner of Object.values(datos)) {
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue;
      for (const [ev, lista] of Object.entries(owner)) {
        if (!Array.isArray(lista)) continue;
        const hay = lista.some((h) => esNuestro(h?.command)
          || (Array.isArray(h?.hooks) && h.hooks.some((x) => esNuestro(x?.command))));
        if (hay) eventos.add(ev);
      }
    }
  }
  return [...eventos];
}
