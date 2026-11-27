// Decisiones que vienen de haber probado los hooks contra las herramientas:
//   - Se instala a NIVEL DE USUARIO, no de proyecto. Los hooks de proyecto
//     quedan inertes hasta que alguien acepta el diálogo de workspace trust,
//     y eso es una dependencia silenciosa inaceptable.
//   - Las rutas se registran NATIVAS y citadas. Una ruta POSIX de Git Bash
//     (/tmp/...) no resuelve cuando el hook se ejecuta en Windows, y el
//     proyecto puede vivir en una carpeta con espacios.
//   - Cada config se respalda antes de tocarla; uninstall quita solo lo de
//     chaski de la config actual y deja el respaldo (ver uninstall()).
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { globalDir } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/atomic.mjs';
import { AQUI } from './common.mjs';


// CONTRATO: estos tres nombres de archivo no se cambian nunca.
//
// `init` escribe su ruta absoluta en la configuración de cada CLI, que vive
// fuera del repositorio. Renombrarlos deja a todas las instalaciones
// existentes invocando un archivo que no existe, y el usuario ve un volcado de
// Node en cada turno hasta que vuelva a correr `init`. Ya pasó una vez, al
// pasar `capturar.mjs` a `capture.mjs`.
//
// La alternativa —que los hooks invoquen `cli.mjs` con un subcomando, para
// tener un solo punto de entrada— se midió y cuesta 213 ms más por hook
// (495 contra 282), porque arrastra todos los imports del instalador. Eso
// duplicaría el presupuesto más apretado del proyecto.
//
// Hay un test que falla si estos nombres cambian.
export const CAPTURE = resolve(AQUI, 'capture.mjs');
export const INJECT = resolve(AQUI, 'inject.mjs');
export const STATUSLINE = resolve(AQUI, 'statusline.mjs');
// El plugin de OpenCode: el archivo que init deja en la config de OpenCode
// lo importa por esta ruta, así que el nombre queda fijo igual que los otros.
export const OPENCODE_PLUGIN = resolve(AQUI, 'opencode.mjs');
export const MARCA_INI = '# >>> chaski (no editar a mano) >>>';
export const MARCA_FIN = '# <<< chaski <<<';

/**
 * Comando de shell, con rutas nativas y citadas.
 *
 * El nombre del agent va sin espacios: el shell parte los argumentos por
 * espacio, así que "claude code" llegaba al script como dos argumentos y la
 * atribución del relevo quedaba truncada en "claude".
 *
 * `viaEnvoltorio` es para Codex y Antigravity: ejecutan con `cmd /c` y
 * re-escapan las comillas del archivo de configuración, así que al shell le
 * llega `\"C:\Program Files\...\"` y busca un ejecutable llamado
 * `\"C:\Program`. El log de Antigravity lo delató con "is not recognized as
 * an internal or external command". Ver `wrapper()`.
 *
 * Claude Code no lo necesita: acepta el comando citado tal cual, y está
 * validado funcionando así.
 */
export function cmd(script, event, agent, viaEnvoltorio = false) {
  const slug = agent.replace(/ /g, '-');
  if (viaEnvoltorio) return wrapper(script, event, slug);
  const q = (s) => `"${s.replace(/\//g, process.platform === 'win32' ? '\\' : '/')}"`;
  return `${q(process.execPath)} ${q(script)} ${event} ${slug}`;
}

/**
 * Script wrapper en ~/.chaski/, cuya ruta no tiene espacios.
 *
 * Es la única forma determinística de resolver el doble escapado: las rutas
 * con espacios quedan dentro del script, entre comillas, donde nadie las
 * re-escapa. El hook solo invoca una ruta limpia.
 *
 * Se descartó la ruta corta 8.3 de Windows porque la generación de nombres
 * cortos suele estar deshabilitada en volúmenes modernos y falla en silencio.
 */
function wrapper(script, event, agent) {
  // El nombre incluye el script destino: si no, el wrapper de la sonda y
  // el del hook normal colisionan y el último en instalarse pisa al otro.
  const destino = String(script).split(/[\\/]/).pop().replace(/\.mjs$/, '');
  const base = `${agent.replace(/ /g, '-')}-${destino}-${event}`;
  const win = process.platform === 'win32';
  const ruta = join(globalDir(), base + (win ? '.cmd' : '.sh'));
  const q = (s) => `"${s.replace(/\//g, win ? '\\' : '/')}"`;
  const cuerpo = win
    ? ['@echo off', 'rem Generado por chaski. Evita el doble escapado de comillas.',
       `${q(process.execPath)} ${q(script)} ${event} ${agent} %*`, ''].join('\r\n')
    : ['#!/bin/sh', '# Generado por chaski. Evita el doble escapado de comillas.',
       `exec ${q(process.execPath)} ${q(script)} ${event} ${agent} "$@"`, ''].join('\n');
  // Idéntico al que ya está: no se toca. Un init repetido sobre una
  // instalación sana no debe escribir nada (#50), ni siquiera los wrappers.
  let actual = null;
  try { actual = readFileSync(ruta, 'utf8'); } catch {}
  if (actual !== cuerpo) {
    // Los hooks pueden ejecutar el wrapper desde el primer instante visible.
    writeAtomic(ruta, cuerpo, win ? {} : { mode: 0o755 });
  } else if (!win && (statSync(ruta).mode & 0o111) !== 0o111) {
    chmodSync(ruta, 0o755);
  }
  return ruta.replace(/\//g, win ? '\\' : '/');
}

export const CLIS = {
  'claude code': {
    bin: 'claude',
    config: join(homedir(), '.claude', 'settings.json'),
    formato: 'json-claude',
  },
  'codex': {
    bin: 'codex',
    config: resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
    formato: 'toml-codex',
  },
  'agy': {
    bin: 'agy',
    config: join(homedir(), '.gemini', 'config', 'hooks.json'),
    formato: 'json-agy',
  },
  // OpenCode no tiene hooks de shell: carga los .js de su carpeta de plugins
  // (XDG también en Windows, verificado con `opencode debug paths`). La
  // «config» es un archivo propio de chaski, no uno compartido.
  'opencode': {
    bin: 'opencode',
    config: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'plugins', 'chaski.js'),
    formato: 'js-opencode',
  },
};

/** Primera línea del plugin de OpenCode: lo identifica como de chaski. */
export const OPENCODE_MARK = '// >>> chaski: generado por `chaski init`, no editar a mano >>>';

/** Eventos de chaski que traduce el plugin de OpenCode (ver src/opencode.mjs). */
export const OPENCODE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact'];

/**
 * Contenido del plugin de OpenCode: importa src/opencode.mjs por su ruta
 * absoluta y le pasa la de Node, porque dentro de OpenCode
 * `process.execPath` es el binario de OpenCode.
 */
export function opencodePluginSource() {
  return [
    OPENCODE_MARK,
    `import { chaskiDefinition } from ${JSON.stringify(pathToFileURL(OPENCODE_PLUGIN).href)};`,
    `export default chaskiDefinition({ node: ${JSON.stringify(process.execPath)} });`,
    '',
  ].join('\n');
}

/**
 * Versión mínima de OpenCode que carga el plugin de chaski. Es desde cuando
 * 1.x acepta un `export default` con `server()` (guía oficial de migración a
 * 2.x: «V1 object entrypoints are supported in OpenCode 1.18.29 and newer»),
 * que es lo que permite servir 1.x y 2.x desde el mismo archivo.
 * La política de versiones está en AGENTS.md («Versiones soportadas»).
 */
export const OPENCODE_MIN = [1, 18, 29];

/**
 * Versión del OpenCode instalado como `[mayor, menor, parche]`, o null si no
 * se pudo leer. 1.x imprime `1.19.6`; 2.x, `opencode v2.4.2`.
 * Con `shell` en Windows porque `opencode` es un shim .cmd/.ps1 de npm. El
 * comando va como un solo texto fijo: pasar argumentos aparte junto con
 * `shell` está deprecado en Node (DEP0190) y ensuciaba la salida de init.
 */
export function opencodeVersion() {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('opencode --version', { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true })
      : spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 8000 });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

/**
 * ¿Esta versión carga el plugin? Una versión ilegible se da por buena: es
 * preferible instalar y que doctor lo diga a no instalar por una salida rara.
 */
export function opencodeSupported(version) {
  if (!Array.isArray(version)) return true;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== OPENCODE_MIN[i]) return version[i] > OPENCODE_MIN[i];
  }
  return true;
}

/** Rutas que usa un plugin de OpenCode generado por chaski, o null si no es nuestro. */
export function parseOpencodePlugin(texto) {
  if (typeof texto !== 'string' || !texto.startsWith(OPENCODE_MARK)) return null;
  // `chaskiPlugin` es la forma de antes de soportar OpenCode 2.x: se reconoce
  // para que doctor y uninstall sigan funcionando sobre una instalación vieja.
  const modulo = texto.match(/^import \{ (?:chaskiDefinition|chaskiPlugin) \} from ("[^"\n]*");$/m);
  const node = texto.match(/(?:chaskiDefinition|chaskiPlugin)\(\{ node: ("[^"\n]*") \}\)/);
  try {
    return { module: modulo ? JSON.parse(modulo[1]) : null, node: node ? JSON.parse(node[1]) : null };
  } catch {
    return { module: null, node: null };
  }
}

/**
 * Reconoce los hooks de Claude Code registrados por chaski.
 *
 * Antes bastaba con que el JSON del grupo contuviera «chaski», y eso borraba
 * también hooks del usuario que solo compartían la palabra (una ruta como
 * `~/chaski-tools/lint.mjs`). Ahora se reconoce la forma exacta que escribe
 * `cmd()` en todas sus versiones —el script de entrada (o su puente con
 * nombre viejo) seguido del evento y del agente— o un wrapper de `~/.chaski/`.
 */
export function isChaskiHookGroup(grupo) {
  const firma = /(?:capture|inject|capturar|leer)\.mjs"?\s+[A-Za-z]+\s+\S|[\\/]\.chaski[\\/][\w.-]+\.(?:cmd|sh)\b/;
  const comandos = [grupo?.command, ...(Array.isArray(grupo?.hooks) ? grupo.hooks.map((h) => h?.command) : [])];
  return comandos.some((c) => typeof c === 'string' && firma.test(c));
}

export const PROBE_START = '# >>> chaski probe >>>';
export const PROBE_END = '# <<< chaski probe <<<';

export function findBlock(text, start = MARCA_INI, end = MARCA_FIN) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const last = text.indexOf(end, from + start.length);
  if (last === -1) return null;
  return { from, to: last + end.length };
}

export function removeBlock(text, start, end) {
  const block = findBlock(text, start, end);
  return block ? text.slice(0, block.from) + text.slice(block.to) : text;
}

/**
 * ¿Este grupo de hooks es la sonda de `chaski probe`? Mismo criterio que
 * isChaskiHookGroup: la ruta de la sonda en ~/.chaski/ (o su wrapper), no la
 * palabra «sonda» en cualquier parte, que también borraba hooks ajenos.
 */
export function isProbeHookGroup(grupo) {
  const firma = /[\\/]\.chaski[\\/][\w.-]*sonda[\w.-]*\.(?:mjs|cmd|sh)\b/;
  const comandos = [grupo?.command, ...(Array.isArray(grupo?.hooks) ? grupo.hooks.map((h) => h?.command) : [])];
  return comandos.some((c) => typeof c === 'string' && firma.test(c));
}

export function isInstalled(bin) {
  try {
    const cmdWhich = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmdWhich, [bin], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    // En entornos restringidos where.exe puede no enumerar un directorio
    // aunque sus ejecutables sean accesibles por su ruta completa.
    if (process.platform !== 'win32') return false;
    const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
      for (const ext of extensions) {
        try {
          if (statSync(join(dir.replace(/^"|"$/g, ''), bin + ext)).isFile()) return true;
        } catch {}
      }
    }
    return false;
  }
}
