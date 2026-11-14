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
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { budget });
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
  const { timeout = 4000, budget = null } =
    typeof opciones === 'number' ? { timeout: opciones } : opciones;
  // Sin tiempo ni para que valga la pena intentarlo: ni se spawnea.
  if (budget && budget.remaining() <= MIN_GIT_CALL_MS) return null;
  const timeoutEfectivo = effectiveTimeout(timeout, budget);
  const root = projectDir(cwd);
  try {
    return execFileSync('git', [
      // Sin esto, git escapa en octal cualquier ruta con acentos: un
      // `café.txt` llegaba al relevo como `caf\303\251.txt`. Importa en
      // cualquier proyecto en español.
      '-c', 'core.quotepath=false',
      ...args,
    ], {
      cwd: root, encoding: 'utf8', timeout: timeoutEfectivo,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
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

/** Config y estado global de chaski, fuera de cualquier proyecto. */
export function globalDir() {
  const dir = join(homedir(), '.chaski');
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

/** Días por defecto antes de borrar el relevo de una rama que ya no existe. */
export const DAYS_FACTS_ONLY = 30;
export const DAYS_WITH_NARRATIVE = 90;

/**
 * Plazos efectivos de la poda, en días. Una sola fuente de verdad para la
 * poda y para `doctor`, que antes tenía «90 en vez de 30» escrito a mano.
 * `0` desactiva: en `facts` apaga toda la poda; en `narrative`, solo la de
 * relevos con narrativa (los demás siguen su plazo). Antes `0` en narrative
 * daba plazo cero y borraba en la próxima poda, al revés que `pruneAfterDays`.
 */
export function effectivePruneDays(opciones = {}) {
  // Compatibilidad: un número suelto se interpreta como los días base.
  const o = typeof opciones === 'number' ? { factsOnly: opciones } : (opciones ?? {});
  const facts = o.factsOnly ?? DAYS_FACTS_ONLY;
  const narrative = o.withNarrative ?? Math.max(facts * 3, DAYS_WITH_NARRATIVE);
  return { facts, narrative };
}

/**
 * Borra los relevos de ramas que ya no existen en git.
 *
 * El criterio no es la antigüedad a secas, porque el costo de equivocarse es
 * asimétrico: borrar de más cuesta contexto irrecuperable, acumular de más
 * cuesta kilobytes. Y dentro de un relevo hay dos cosas de valor muy distinto:
 *
 *   - Los HECHOS son reproducibles: archivos, diff y commits se recalculan
 *     desde git en cualquier momento. Si la rama fue mergeada, además ya
 *     están en el historial.
 *   - La NARRATIVA no se recupera. Existe porque alguien la escribió, costó
 *     un turno de un modelo e incluye el juicio de una persona.
 *
 * Así que los relevos con narrative viven el triple. Y `days = 0` desactiva
 * la limpieza: la tolerancia a la basura es una preferencia legítima.
 *
 * Dos resguardos más: solo se borra lo que git confirma que no existe, y una
 * rama viva nunca se toca, sin importar la antigüedad.
 *
 * Devuelve los nombres borrados.
 */
export function pruneOrphanRelays(cwd, opciones = {}) {
  const { facts: diasHechos, narrative: diasNarrativa } = effectivePruneDays(opciones);

  const borrados = [];
  if (diasHechos === 0) return borrados; // limpieza desactivada
  try {
    const dirRamas = join(tambo(cwd), 'branches');
    if (!existsSync(dirRamas)) return borrados;

    // Si no se puede listar las ramas, no se borra nada: ante la duda, queda.
    const salida = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (salida === null) return borrados;
    const vivas = new Set(salida.split('\n').filter(Boolean).map(branchSlug));

    for (const entrada of readdirSync(dirRamas, { withFileTypes: true })) {
      if (!entrada.isDirectory() || vivas.has(entrada.name)) continue;
      const ruta = join(dirRamas, entrada.name);
      try {
        const tieneNarrativa = !!(readJson(join(ruta, 'estado.json'), {}) ?? {}).narrative;
        const plazo = tieneNarrativa ? diasNarrativa : diasHechos;
        if (plazo === 0) continue; // limpieza de relevos con narrativa desactivada
        if (statSync(ruta).mtimeMs > Date.now() - plazo * 86_400_000) continue;
        rmSync(ruta, { recursive: true, force: true });
        borrados.push(entrada.name);
      } catch {}
    }
  } catch {}
  return borrados;
}

/** Relevos cuya rama ya no existe, sin borrar nada. Para `doctor`. */
export function orphanRelays(cwd) {
  try {
    const dirRamas = join(tambo(cwd), 'branches');
    if (!existsSync(dirRamas)) return [];
    const salida = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (salida === null) return [];
    const vivas = new Set(salida.split('\n').filter(Boolean).map(branchSlug));
    return readdirSync(dirRamas, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !vivas.has(e.name))
      .map((e) => {
        const ruta = join(dirRamas, e.name);
        let days = 0;
        try { days = (Date.now() - statSync(ruta).mtimeMs) / 86_400_000; } catch {}
        const withNarrative = !!(readJson(join(ruta, 'estado.json'), {}) ?? {}).narrative;
        return { name: e.name, days: Math.round(days), withNarrative };
      });
  } catch {
    return [];
  }
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
    return txt.split(/\r?\n/).some((l) => {
      const s = l.trim();
      return s === TAMBO || s === TAMBO + '/';
    });
  } catch {
    return false;
  }
}

export function readJson(ruta, porDefecto = null) {
  try { return JSON.parse(readFileSync(ruta, 'utf8')); } catch { return porDefecto; }
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
    // Se quita el BOM: JSON.parse no lo tolera y es frecuente en Windows.
    return JSON.parse(bruto.replace(/^﻿/, ''));
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
  const proyecto = readJson(join(cwd, 'chaski.json'), {}) ?? {};
  const local = readJson(join(cwd, 'chaski.local.json'), {}) ?? {};
  const global = readJson(join(globalDir(), 'config.json'), {}) ?? {};
  // `redact` y `excludePaths` se concatenan: el archivo local puede sumar
  // patrones, nunca quitar los del repo. Las claves escalares las pisa el
  // nivel más específico.
  const merged = { ...global, ...proyecto, ...local };
  merged.redact = [...(global.redact ?? []), ...(proyecto.redact ?? []), ...(local.redact ?? [])];
  merged.excludePaths = [
    ...(global.excludePaths ?? []), ...(proyecto.excludePaths ?? []), ...(local.excludePaths ?? []),
  ];
  return merged;
}
