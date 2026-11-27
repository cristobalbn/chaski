import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyGlobalDir, readJson, syncedFolder, tamboIsIgnored, loadConfig, promptHookPath, claudePluginEnabled, claudePluginEnabledForUser, CLAUDE_PLUGIN_ID, usagePath, readOnlyBranchDir, legacyBranchState, currentBranch, stripBom } from '../lib/paths.mjs';
import { PROMPT_HOOK_EVENTS, promptHookAlive, usageSummary } from '../lib/ask.mjs';
import { canonicalAgent } from '../lib/payload.mjs';
import { isValidSignature } from '../lib/signatures.mjs';
import { latestMergedBranchEntry } from '../lib/history.mjs';
import { readRelay } from '../lib/relay-store.mjs';
import { orphanRelays, effectivePruneDays } from '../lib/maintenance.mjs';
import { outdatedProjectFiles } from '../lib/project-files.mjs';
import { pkgVersion, pad } from './common.mjs';
import { CAPTURE, INJECT, CLIS, isInstalled, parseOpencodePlugin, OPENCODE_EVENTS, opencodeVersion, opencodeSupported, OPENCODE_MIN } from './hook-config.mjs';
import { projectContext, projectRootNote } from './project.mjs';
import { isChaskiStatusLine } from './statusline.mjs';

export function doctor() {
  const { cwd, workspace } = projectContext();
  console.log(`\nchaski doctor (v${pkgVersion()})\n`);

  const plugin = claudePluginEnabled(cwd);
  const pluginUser = claudePluginEnabledForUser();
  const cliStatus = Object.entries(CLIS).map(([name, cli]) => {
    const installed = isInstalled(cli.bin);
    // Un OpenCode anterior al mínimo no carga el plugin, aunque el archivo exista.
    const version = installed && cli.formato === 'js-opencode' ? opencodeVersion() : null;
    const unsupported = Boolean(version) && !opencodeSupported(version);
    const hasConfig = installed && !unsupported && existsSync(cli.config);
    const inspected = hasConfig ? inspectRegisteredHooks(cli) : null;
    const events = inspected ? inspected.events : null;
    const missingPaths = inspected ? inspected.missingPaths : [];
    return { name, cli, installed, version, unsupported, hasConfig, events, missingPaths };
  });

  console.log('CLIs y hooks');
  for (const status of cliStatus) {
    console.log(`  ${pad(status.name)} ${describeHooks(status, plugin, pluginUser)}`);
    if (!(status.cli.formato === 'json-claude' && plugin)) {
      for (const missing of status.missingPaths) {
        console.log(`  ⚠ ${status.name}: hook registrado apunta a una ruta que no existe (${missing}) — ejecuta init`);
      }
    }
  }

  console.log('\nEjecutables del hook');
  for (const [etiqueta, script] of [['capture', CAPTURE], ['inject', INJECT]]) {
    console.log(`  ${pad(etiqueta)} ${existsSync(script) ? 'ok' : 'FALTA'}  ${script}`);
  }

  console.log('\nLatidos (última vez que cada CLI ejecutó el hook)');
  const rawLat = readJson(join(readOnlyGlobalDir(), 'latidos.json'), {});
  const latRaw = rawLat && typeof rawLat === 'object' && !Array.isArray(rawLat) ? rawLat : {};
  const lat = Object.create(null);
  for (const [a, iso] of Object.entries(latRaw)) {
    if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) continue;
    const k = canonicalAgent(a);
    if (!lat[k] || Date.parse(iso) > Date.parse(lat[k])) lat[k] = iso;
  }
  if (!Object.keys(lat).length) console.log('  ninguno todavía — abre una sesión y vuelve a revisar');
  for (const [a, iso] of Object.entries(lat)) {
    const days = (Date.now() - new Date(iso).getTime()) / 86400000;
    console.log(`  ${pad(a)} ${iso.slice(0, 16).replace('T', ' ')}${days > 1 ? `  ← hace ${Math.round(days)} día(s)` : ''}`);
  }

  // Un CLI con hooks registrados que nunca estampó heartbeat es el síntoma de un
  // paso pendiente, no de un bug. Se diagnostica aquí en lugar de dejar al
  // usuario adivinando por qué .tambo/ sigue vacío.
  const sinLatido = cliStatus.filter(({ name, installed, events }) => installed
    && ((name === 'claude code' && plugin) || events?.length)
    && !Object.keys(lat).some((key) => canonicalAgent(key) === name));
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
  for (const { name, installed, hasConfig, events } of cliStatus) {
    if (!hasConfig && !(name === 'claude code' && plugin && installed)) continue;
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
      const rota = missingStatusLineTarget(sl.command);
      if (rota) {
        console.log(`  ⚠ claude code: statusline apunta a una ruta que no existe (${rota}) — ejecuta \`chaski init --statusline\``);
      } else {
        const rawUsage = readJson(usagePath(), {});
        const usageObj = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage) ? rawUsage : {};
        const claudeUsage = usageObj['claude code']
          ?? Object.entries(usageObj).find(([k]) => canonicalAgent(k) === 'claude code')?.[1];
        const resumen = usageSummary(claudeUsage, Date.now(), Infinity);
        console.log(`  ${pad('claude code')} ${resumen ?? 'statusline instalada; todavía sin dato (solo planes Pro, Max y Ultra, tras la primera respuesta)'}`);
      }
    }
  }

  console.log('\nProyecto');
  console.log(`  ${pad('directorio')} ${cwd}`);
  for (const l of projectRootNote(cwd, workspace)) console.log(`  ${pad('')} ${l}`);
  const sync = syncedFolder(cwd);
  console.log(`  ${pad('sincronizada')} ${sync ? `sí (${sync}) — se usa escritura atómica` : 'no'}`);
  console.log(`  ${pad('.tambo en git')} ${tamboIsIgnored(cwd) ? 'ignorado, correcto' : 'NO IGNORADO — ejecuta init'}`);
  // Actualizar chaski no actualiza la skill ni el bloque de AGENTS.md que
  // init copió al proyecto: sin este aviso nadie se entera.
  const viejos = outdatedProjectFiles(cwd);
  console.log(`  ${pad('skill y AGENTS')} ${viejos.length ? `DESACTUALIZADOS (${viejos.join(', ')}) — ejecuta init` : 'al día'}`);

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

  const branch = currentBranch(cwd);
  const relay = readRelay(readOnlyBranchDir(cwd, branch))
    ?? (() => {
      const legacy = legacyBranchState(cwd, branch);
      return legacy ? readRelay(legacy.dir) : null;
    })();
  if (relay) {
    const { state: estado, markdown: md, recovered } = relay;
    const edad = estado.writtenAt ? Math.round((Date.now() - new Date(estado.writtenAt).getTime()) / 60000) : null;
    console.log(`  ${pad('relevo')} ${md.length} caracteres${edad !== null ? `, escrito hace ${edad} min` : ''}`);
    console.log(`  ${pad('firma')} ${estado.signature ? (recovered ? 'válida — vista recuperada del estado' : isValidSignature(md, estado.signature) ? 'válida' : 'NO VALIDA — editado fuera de chaski') : 'sin firma'}`);
    const autorNarrativa = estado.narrative
      ? (estado.narrativeAuthor || estado.agent ? canonicalAgent(estado.narrativeAuthor ?? estado.agent) : '?')
      : null;
    console.log(`  ${pad('narrativa')} ${estado.narrative ? `sí, por ${autorNarrativa}` : 'no — escribe «relevo» en el chat del agente'}`);
    const heredada = latestMergedBranchEntry(cwd, estado);
    if (heredada) {
      const autorHeredado = heredada.author ? canonicalAgent(heredada.author) : '?';
      console.log(`  ${pad('rama fusionada')} narrativa más reciente de ${heredada.branch} (por ${autorHeredado})`);
    }
  } else {
    console.log(`  ${pad('relevo')} todavía no existe para esta rama`);
  }

  console.log('\nQué sale de esta máquina');
  console.log(`  ${pad('capture')} nada: solo lee archivos locales y git`);
  console.log(`  ${pad('inject')} nada: imprime un archivo local`);
  console.log(`  ${pad('skill relevo')} usa el agente que ya tienes abierto (uso interactivo)`);
  console.log(`  ${pad('llamadas')} chaski NO invoca claude -p, codex exec ni agy -p\n`);
}

function describeHooks({ installed, version, unsupported, hasConfig, cli, events }, plugin, pluginUser = false) {
  if (!installed) return 'no instalado';
  if (unsupported) return `${version.join('.')} no soportada (mínimo ${OPENCODE_MIN.join('.')}): actualiza OpenCode`;
  if (cli.formato === 'json-claude' && plugin) {
    if (!events?.length) return `vía plugin ${CLAUDE_PLUGIN_ID}`;
    return `vía plugin ${CLAUDE_PLUGIN_ID}` + (pluginUser
      ? ' — también hay hooks en settings.json: se silencian solos, pero corre init para quitarlos'
      : ' — también hay hooks en settings.json (se silencian en este proyecto; siguen activos en los demás)');
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
function inspectRegisteredHooks(cli) {
  let txt;
  try { txt = stripBom(readFileSync(cli.config, 'utf8')); } catch { return null; }
  // Un comando que ejecuta un hook de chaski: los scripts de entrada (y los
  // puentes con nombres viejos) o un wrapper generado en ~/.chaski/.
  const HOOK_DE_CHASKI = /(?:capture|inject|capturar|leer)\.mjs|[\\/]\.chaski[\\/][\w.-]+\.(?:cmd|sh)\b/;
  const eventos = new Set();
  const missing = new Set();
  const esNuestro = (c) => typeof c === 'string' && HOOK_DE_CHASKI.test(c);
  const registrar = (ev, comando) => {
    if (!esNuestro(comando)) return false;
    eventos.add(ev);
    const rota = missingHookTarget(comando);
    if (rota) missing.add(rota);
    return true;
  };

  if (cli.formato === 'js-opencode') {
    // Un archivo entero de chaski: si es nuestro, trae los cuatro eventos que
    // traduce src/opencode.mjs. Lo que puede romperse son sus dos rutas.
    const plugin = parseOpencodePlugin(txt);
    if (!plugin) return { events: [], missingPaths: [] };
    let modulo = null;
    try { modulo = plugin.module ? fileURLToPath(plugin.module) : null; } catch {}
    for (const ruta of [modulo ?? String(plugin.module), plugin.node]) {
      if (!ruta || !existsSync(ruta)) missing.add(String(ruta));
    }
    return { events: [...OPENCODE_EVENTS], missingPaths: [...missing] };
  }

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
      const c = l.match(/^command\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/);
      if (evento && c) {
        let valor;
        try { valor = c[1].startsWith('"') ? JSON.parse(c[1]) : c[1].slice(1, -1); } catch { valor = c[1]; }
        registrar(evento, valor);
      }
    }
    return { events: [...eventos], missingPaths: [...missing] };
  }

  let datos;
  try { datos = JSON.parse(txt); } catch { return null; }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;

  if (cli.formato === 'json-claude') {
    // hooks.<Evento> = [{ matcher?, hooks: [{ type, command }] }]
    for (const [ev, grupos] of Object.entries(datos.hooks ?? {})) {
      if (!Array.isArray(grupos)) continue;
      for (const g of grupos) {
        if (!Array.isArray(g?.hooks)) continue;
        for (const h of g.hooks) registrar(ev, h?.command);
      }
    }
  } else if (cli.formato === 'json-agy') {
    // <propietario>.<Evento> = [{ type, command }] o, en PreToolUse y
    // PostToolUse, [{ matcher, hooks: [...] }]. Se mira cualquier propietario
    // por si alguien movió el bloque, pero solo cuentan comandos de chaski.
    for (const owner of Object.values(datos)) {
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue;
      for (const [ev, lista] of Object.entries(owner)) {
        if (!Array.isArray(lista)) continue;
        for (const h of lista) {
          registrar(ev, h?.command);
          if (Array.isArray(h?.hooks)) {
            for (const x of h.hooks) registrar(ev, x?.command);
          }
        }
      }
    }
  }
  return { events: [...eventos], missingPaths: [...missing] };
}

function missingHookTarget(comando) {
  const limpio = String(comando ?? '').trim().replace(/^["']|["']$/g, '');
  const wrapperMatch = limpio.match(/^((?:[A-Za-z]:)?[^"']*?[\\/]\.chaski[\\/][\w.-]+\.(?:cmd|sh))\b/);
  if (wrapperMatch) {
    const wrapperPath = wrapperMatch[1];
    if (!existsSync(wrapperPath)) return wrapperPath;
    try {
      const cuerpo = readFileSync(wrapperPath, 'utf8');
      const scriptInWrapper = cuerpo.match(/["']([^"']+?(?:capture|inject|capturar|leer)\.mjs)["']/);
      if (scriptInWrapper && !existsSync(scriptInWrapper[1])) return scriptInWrapper[1];
    } catch {}
    return null;
  }
  const scriptMatch = String(comando ?? '').match(/["']([^"']+?(?:capture|inject|capturar|leer)\.mjs)["']/);
  if (scriptMatch && !existsSync(scriptMatch[1])) return scriptMatch[1];
  return null;
}

function missingStatusLineTarget(comando) {
  const m = String(comando ?? '').match(/["']([^"']+?statusline\.mjs)["']|((?:[A-Za-z]:)?[^\s"']+?statusline\.mjs)\b/);
  const target = m?.[1] ?? m?.[2];
  if (target && !existsSync(target)) return target;
  return null;
}
