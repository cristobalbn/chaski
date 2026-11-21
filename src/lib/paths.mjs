// Resolución de rutas, ramas y locks.
// Todo path se construye con path.join: el caso real incluye carpetas con
// espacios y acentos sincronizadas por OneDrive, donde se rompen los scripts
// escritos asumiendo rutas POSIX.
import { join, resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { MIN_GIT_CALL_MS, effectiveTimeout } from './budget.mjs';

export const TAMBO = '.tambo';

/**
 * Directorio raíz del proyecto a partir del cwd que informa el CLI.
 *
 * Resuelve dos casos reales sin lanzar subprocesos de git:
 *   1. El CLI se abrió en una subcarpeta del repositorio (`repo/src`): sube
 *      hasta encontrar `.git`.
 *   2. El CLI se abrió en una carpeta contenedora que envuelve a un único
 *      repositorio hijo (`workspace/repo/.git`): usa ese repositorio en vez
 *      de caer en `sin-rama` en la carpeta padre. Si hay cero o varios repos
 *      hijos, no adivina y conserva `cwd`.
 */
export function projectDir(cwd) {
  const base = resolve(cwd);
  if (existsSync(join(base, '.git'))) return base;

  const tope = resolve(homedir());
  const tmp = resolve(tmpdir());
  if (base === tope || base === tmp) return base;

  let actual = base;
  while (actual !== tope && actual !== tmp) {
    const padre = dirname(actual);
    if (padre === actual || padre === tope || padre === tmp) break;
    if (existsSync(join(padre, '.git'))) return padre;
    actual = padre;
  }

  try {
    const hijos = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(base, e.name))
      .filter((ruta) => existsSync(join(ruta, '.git')));
    if (hijos.length === 1) return hijos[0];
  } catch {}

  return base;
}

/** Directorio .tambo del proyecto, creado si falta. */
export function tambo(cwd) {
  const dir = join(projectDir(cwd), TAMBO);
  mkdirSync(dir, { recursive: true });
  // Invariante 3 sin depender de `init` (#80): quien instala solo el plugin
  // de Claude Code nunca corre init, y `.tambo/` no queda en el .gitignore
  // del proyecto. Un .gitignore propio con `*` hace que git ignore la carpeta
  // entera sin tocar el del usuario. `wx`: si ya existe, no se toca.
  try { writeFileSync(join(dir, '.gitignore'), '# chaski: relevo local, nunca se versiona\n*\n', { flag: 'wx' }); } catch {}
  return dir;
}

/**
 * Slug seguro para nombre de carpeta a partir de una rama git.
 *
 * Lleva un sufijo con un hash corto del nombre original porque el slug solo
 * no es único: `feat/a-b` y `feat-a-b` producían el mismo texto y compartían
 * el relevo, igual que dos ramas largas que difirieran después del carácter
 * 80. El sufijo mantiene la carpeta legible y la hace inequívoca.
 */
export function branchSlug(rama) {
  const name = rama || 'sin-rama';
  const base = name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sin-rama';

  // El sufijo solo va cuando hubo transformación, que es cuando puede haber
  // ambigüedad. Así `main` sigue siendo `main` —la carpeta queda legible en
  // el caso habitual— y únicamente los nombres con barras, caracteres raros
  // o más de 60 letras reciben el desambiguador.
  return base === name ? base : `${base}-${fingerprint(name)}`;
}

/** Hash corto y estable de un nombre, para desambiguar slugs. */
function fingerprint(texto) {
  // FNV-1a de 32 bits: suficiente para distinguir nombres de rama, y no
  // requiere importar node:crypto en el camino caliente de cada captura.
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** Rama actual del árbol en cwd, o null si no hay repo. */
export function currentBranch(cwd, budget = null) {
  const ref = git(cwd, ['rev-parse', '--symbolic-full-name', 'HEAD'], { budget });
  return ref?.replace(/^refs\/heads\//, '') ?? null;
}

/**
 * Ejecuta git y devuelve stdout, o null ante cualquier fallo.
 * Nunca lanza: un hook que falla le arruina la sesión al usuario.
 *
 * `opciones.budget`, si se pasa, hace dos cosas: si ya no queda tiempo para
 * que valga la pena intentar el subproceso, ni lo lanza (devuelve null sin
 * costo); y si queda algo pero menos que el `timeout` pedido, el timeout
 * efectivo se recorta a lo que queda. Antes el timeout por llamada (4.000 ms)
 * era mayor que el presupuesto entero del hook `Stop` (1,5 s compartido), así
 * que no protegía nada: una sola llamada cara podía agotar todo el hook. Con
 * esto, ninguna llamada puede ya exceder lo que queda del presupuesto global,
 * aunque la estimación de costo de quien la llamó haya sido optimista.
 */
export function git(cwd, args, opciones = {}) {
  const { timeout = 4000, budget = null, raw = false } =
    typeof opciones === 'number' ? { timeout: opciones } : opciones;
  // Sin tiempo ni para que valga la pena intentarlo: ni se spawnea.
  if (budget && budget.remaining() <= MIN_GIT_CALL_MS) return null;
  const timeoutEfectivo = effectiveTimeout(timeout, budget);
  const root = projectDir(cwd);
  try {
    const stdout = execFileSync('git', [
      // Sin esto, git escapa en octal cualquier ruta con acentos: un
      // `café.txt` llegaba al relevo como `caf\303\251.txt`. Importa en
      // cualquier proyecto en español.
      '-c', 'core.quotepath=false',
      ...args,
    ], {
      cwd: root, encoding: 'utf8', timeout: timeoutEfectivo,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return raw ? stdout : stdout.trim();
  } catch {
    return null;
  }
}

/** Directorio de estado de la rama activa. El relevo sigue a la rama, no a la carpeta. */
export function branchDir(cwd, branch = undefined) {
  const rama = branch === undefined ? currentBranch(cwd) : branch;
  const dir = join(tambo(cwd), 'branches', branchSlug(rama));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function relayPath(cwd, branch = undefined) { return join(branchDir(cwd, branch), 'relevo.md'); }
export function statePath(cwd, branch = undefined) { return join(branchDir(cwd, branch), 'estado.json'); }

/**
 * Las mismas rutas, SIN crear nada: para quien solo lee. relayPath() y
 * statePath() crean `.tambo/branches/<slug>/` (y el .gitignore de `.tambo/`)
 * porque los usa quien va a escribir; el hook de inicio de sesión y los
 * comandos de consulta los usaban para leer, y así dejaban un `.tambo/` vacío
 * en cada proyecto que se abría —con el plugin, en todos los repos del
 * usuario—, aunque chaski nunca hubiera capturado ahí.
 */
export function readOnlyTambo(cwd) { return join(projectDir(cwd), TAMBO); }
export function readOnlyBranchDir(cwd, branch = undefined) {
  const rama = branch === undefined ? currentBranch(cwd) : branch;
  return join(readOnlyTambo(cwd), 'branches', branchSlug(rama));
}
/** Busca el relevo que una versión anterior guardó con el nombre abreviado de Git. */
export function legacyBranchState(cwd, branch, budget = null) {
  if (!branch || branch === 'HEAD') return null;
  const names = ['heads/' + branch, 'refs/heads/' + branch];
  if (!names.some((name) => existsSync(join(readOnlyBranchDir(cwd, name), 'estado.json')))) return null;
  const legacy = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { budget });
  if (!names.includes(legacy)) return null;
  const dir = readOnlyBranchDir(cwd, legacy);
  return existsSync(join(dir, 'estado.json')) ? { dir, branch: legacy } : null;
}

export function readOnlyRelayPath(cwd, branch = undefined) { return join(readOnlyBranchDir(cwd, branch), 'relevo.md'); }
export function readOnlyStatePath(cwd, branch = undefined) { return join(readOnlyBranchDir(cwd, branch), 'estado.json'); }

/** Config y estado global de chaski, fuera de cualquier proyecto. */
export function readOnlyGlobalDir() { return join(homedir(), '.chaski'); }

export function globalDir() {
  const dir = readOnlyGlobalDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lock por directorio: mkdir es atómico en Windows, macOS y Linux, así que
 * no hace falta nada más. Devuelve una función para liberarlo, o null si otro
 * proceso lo tiene. Un lock más viejo que maxEdadMs se considera huérfano.
 */
export function acquireLock(cwd, maxEdadMs = 30000) {
  const lock = join(tambo(cwd), '.lock');
  const crear = () => { mkdirSync(lock); };
  try {
    crear();
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > maxEdadMs) {
        rmSync(lock, { recursive: true, force: true });
        crear();
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  try { writeFileSync(join(lock, 'pid'), String(process.pid)); } catch {}
  return () => { try { rmSync(lock, { recursive: true, force: true }); } catch {} };
}

/** ¿El proyecto vive en una carpeta sincronizada? Esos clientes bloquean archivos al subirlos. */
export function syncedFolder(cwd) {
  const p = resolve(cwd).replace(/\\/g, '/');
  for (const marca of ['OneDrive', 'Dropbox', 'Google Drive', 'iCloudDrive']) {
    if (p.includes('/' + marca)) return marca;
  }
  return null;
}

/**
 * ¿Está .tambo/ ignorado por git?
 * Se consulta con barra final: una regla `.tambo/` solo aplica a directorios,
 * y si el directorio todavía no existe, `check-ignore .tambo` da falso
 * negativo. Como respaldo se lee el .gitignore, para que doctor no reporte
 * un problema que no existe.
 */
export function tamboIsIgnored(cwd) {
  const root = projectDir(cwd);
  for (const arg of [TAMBO + '/', TAMBO]) {
    try {
      execFileSync('git', ['check-ignore', '-q', arg], { cwd: root, stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {}
  }
  try {
    const txt = readFileSync(join(root, '.gitignore'), 'utf8');
    if (txt.split(/\r?\n/).some((l) => {
      const s = l.trim();
      return s === TAMBO || s === TAMBO + '/';
    })) return true;
  } catch {}
  // El .gitignore propio de `.tambo/` (ver tambo()): `git check-ignore` sobre
  // la carpeta no lo reporta como ignorada aunque todo su contenido lo esté.
  try {
    return readFileSync(join(root, TAMBO, '.gitignore'), 'utf8').split(/\r?\n/).some((l) => l.trim() === '*');
  } catch {
    return false;
  }
}

/** Quita el BOM que algunos editores de Windows ponen al inicio: JSON.parse no lo tolera. */
export function stripBom(texto) { return String(texto).replace(/^\uFEFF/, ''); }

export function readJson(ruta, porDefecto = null) {
  try { return JSON.parse(stripBom(readFileSync(ruta, 'utf8'))); } catch { return porDefecto; }
}

/**
 * Lee un JSON que se va a **modificar y volver a escribir**.
 *
 * Distinto de `readJson`: si el archivo existe pero no se puede parsear,
 * lanza en lugar de devolver un objeto vacío. Esa diferencia evita el peor
 * error posible del proyecto — un `settings.json` con una coma final o un
 * comentario hacía que `init` lo reemplazara por completo, y el usuario
 * perdía su `model`, su `theme` y sus `permissions` en el primer comando que
 * corría.
 *
 * Para leer algo que solo se consulta, `readJson` sigue siendo lo correcto.
 */
export function readJsonForWrite(ruta) {
  if (!existsSync(ruta)) return {};
  const bruto = readFileSync(ruta, 'utf8');
  if (!bruto.trim()) return {};
  try {
    return JSON.parse(stripBom(bruto));
  } catch (e) {
    throw new Error(
      `${ruta} no es JSON válido (${e.message}).\n` +
      '  chaski no lo va a tocar: reescribirlo borraría tu configuración.\n' +
      '  Corrige el archivo y vuelve a intentar.');
  }
}

export { existsSync };

/**
 * Configuración combinada: global < proyecto < local en escalares, y
 * concatenación en `redact` y `excludePaths`. La usan capture.mjs e
 * inject.mjs: los dos tienen que redactar igual, o el re-render de inject no
 * coincide con lo que capture firmó.
 */
export function loadConfig(cwd) {
  const layers = [
    join(readOnlyGlobalDir(), 'config.json'),
    join(cwd, 'chaski.json'),
    join(cwd, 'chaski.local.json'),
  ].map((path) => readJson(path, null))
    .filter((layer) => layer && typeof layer === 'object' && !Array.isArray(layer));
  const patterns = (key) => layers.flatMap((layer) => Array.isArray(layer[key]) ? layer[key] : []);
  return {
    ...layers.reduce((merged, layer) => ({ ...merged, ...layer }), {}),
    redact: patterns('redact'),
    excludePaths: patterns('excludePaths'),
  };
}

/**
 * Petición de narrativa anotada en `Stop` para entregarse en el mensaje
 * siguiente (#73). El archivo es por proyecto y cada pedido por sesión.
 * Quien lo lee es el hook de
 * `UserPromptSubmit`, que corre en cada mensaje y no puede pagar un `git` para
 * saber la rama. La sesión que trae adentro la ata a su conversación.
 */
export function pendingAskPath(cwd) { return join(projectDir(cwd), TAMBO, 'pending-ask.json'); }

/**
 * Prueba de vida del hook de entrega de cada CLI: `{ "<agent>": "<ISO>" }`.
 * La escribe inject.mjs al correr en `UserPromptSubmit`/`PreInvocation`, y
 * capture.mjs solo difiere la petición si es reciente. Ver ask.mjs.
 */
export function promptHookPath() { return join(readOnlyGlobalDir(), 'prompt-hook.json'); }

/**
 * Turnos empezados y no terminados, por sesión: `{ "<session>": { agent, at } }`.
 * El hook de entrega (inicio de turno) agrega la sesión y capture.mjs la quita
 * al cerrar el turno. Si sobrevive, el turno se cortó: interrupción, ventana
 * cerrada, cuelgue. Ver openTurn() en inject.mjs.
 */
export function openTurnsPath(cwd) { return join(projectDir(cwd), TAMBO, 'turns-open.json'); }

// ----------------------------------------------------------- plugin de Claude Code
//
// Desde #80 chaski también se instala como plugin de Claude Code: el repo es a
// la vez el marketplace (`.claude-plugin/marketplace.json`) y el plugin
// (`.claude-plugin/plugin.json` + `hooks/hooks.json`). El id que queda en
// `enabledPlugins` es `<plugin>@<marketplace>`, los dos `chaski`.

/** Id del plugin en `enabledPlugins`. */
export const CLAUDE_PLUGIN_ID = 'chaski@chaski';

/**
 * ¿El plugin de chaski está activo para Claude Code en este proyecto?
 *
 * Mira los tres niveles donde Claude Code guarda `enabledPlugins`, con su
 * precedencia (local > proyecto > usuario): un `false` más específico apaga
 * un `true` más general. Nunca lanza.
 */
export function claudePluginEnabled(cwd) {
  const base = projectDir(cwd);
  let activo = false;
  for (const ruta of [
    join(homedir(), '.claude', 'settings.json'),
    join(base, '.claude', 'settings.json'),
    join(base, '.claude', 'settings.local.json'),
  ]) {
    const v = readJson(ruta, null)?.enabledPlugins?.[CLAUDE_PLUGIN_ID];
    if (typeof v === 'boolean') activo = v;
  }
  return activo;
}

/**
 * ¿El plugin está activo para el USUARIO (en `~/.claude/settings.json`)?
 *
 * Es la que decide si `init` quita los hooks de chaski de ese mismo archivo:
 * esos hooks valen para todos los proyectos, así que solo se quitan si el
 * plugin también. Con el plugin activo solo en un proyecto, quitarlos dejaba
 * sin chaski a todos los demás.
 */
export function claudePluginEnabledForUser() {
  return readJson(join(homedir(), '.claude', 'settings.json'), null)?.enabledPlugins?.[CLAUDE_PLUGIN_ID] === true;
}

/**
 * ¿Este proceso de hook debe callarse porque el plugin ya hace su trabajo?
 *
 * Quien instaló chaski con `init` y después el plugin tiene los mismos hooks
 * dos veces: Claude Code los corre en paralelo y el relevo se inyectaría dos
 * veces por sesión. Los del plugin traen `CLAUDE_PLUGIN_ROOT` en el entorno
 * (documentado); los de `settings.json` no. Si el plugin está activo, los de
 * `settings.json` salen sin hacer nada. Solo Claude Code: Codex y agy no
 * tienen plugin de chaski.
 */
export function silencedByPlugin(agent, cwd) {
  if (agent !== 'claude code' || process.env.CLAUDE_PLUGIN_ROOT) return false;
  if (typeof cwd !== 'string' || !cwd) return false;
  return claudePluginEnabled(cwd);
}

/**
 * Cuota de cada CLI tal como la reporta su statusline (#82):
 * `{ "claude code": { at, fiveHour: { usedPercentage, resetsAt }, sevenDay } }`.
 * La escribe statusline.mjs; la leen capture.mjs (para pedir la narrativa
 * antes de quedarse sin cuota) y `chaski next`.
 */
export function usagePath() { return join(readOnlyGlobalDir(), 'usage.json'); }

/** Un transcript de reemplazo tiene que haberse escrito hace menos de esto. */
export const TRANSCRIPT_FALLBACK_MS = 15 * 60 * 1000;

/**
 * La ruta del transcript que de verdad se está escribiendo.
 *
 * Al retomar una conversación, Claude Code le da un session_id nuevo y le
 * pasa a los hooks `transcript_path` = `<carpeta>/<id-nuevo>.jsonl`, un archivo
 * que no existe: sigue escribiendo en el transcript original (visto el
 * 2026-11-20, con las líneas todavía marcadas con el id original). Sin esto,
 * chaski no leía nada después de un resume —ni comandos, ni turnos, ni la
 * última respuesta— y tampoco podía reconocer la conversación retomada.
 *
 * Si la ruta existe, es esa. Si no, el `.jsonl` modificado más recientemente
 * de la misma carpeta, siempre que se haya escrito en los últimos 15 min: es
 * la conversación activa. Si nada cumple, la ruta tal cual llegó.
 */
export function resolveTranscript(ruta, ahora = Date.now()) {
  if (!ruta || typeof ruta !== 'string') return ruta ?? null;
  try {
    if (existsSync(ruta)) return ruta;
    if (!/\.jsonl$/i.test(ruta)) return ruta;
    const dir = dirname(ruta);
    let mejor = null;
    for (const nombre of readdirSync(dir)) {
      if (!/\.jsonl$/i.test(nombre)) continue;
      const p = join(dir, nombre);
      const t = statSync(p).mtimeMs;
      if (ahora - t <= TRANSCRIPT_FALLBACK_MS && (!mejor || t > mejor.t)) mejor = { p, t };
    }
    return mejor ? mejor.p : ruta;
  } catch {
    return ruta;
  }
}
