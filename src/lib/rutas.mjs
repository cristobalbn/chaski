// Resolución de rutas, ramas y locks.
// Todo path se construye con path.join: el caso real incluye carpetas con
// espacios y acentos sincronizadas por OneDrive, donde se rompen los scripts
// escritos asumiendo rutas POSIX.
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const TAMBO = '.tambo';

/** Directorio .tambo del proyecto, creado si falta. */
export function tambo(cwd) {
  const dir = join(resolve(cwd), TAMBO);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Slug seguro para nombre de carpeta a partir de una rama git. */
export function slugRama(rama) {
  const s = (rama || 'sin-rama')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'sin-rama';
}

/** Rama actual del árbol en cwd, o null si no hay repo. */
export function rama(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Ejecuta git y devuelve stdout, o null ante cualquier fallo.
 * Nunca lanza: un hook que falla le arruina la sesión al usuario.
 */
export function git(cwd, args, timeout = 4000) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** Directorio de estado de la rama activa. El relevo sigue a la rama, no a la carpeta. */
export function dirRama(cwd) {
  const dir = join(tambo(cwd), 'ramas', slugRama(rama(cwd)));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function rutaRelevo(cwd) { return join(dirRama(cwd), 'relevo.md'); }
export function rutaEstado(cwd) { return join(dirRama(cwd), 'estado.json'); }

/** Config y estado global de chaski, fuera de cualquier proyecto. */
export function dirGlobal() {
  const dir = join(homedir(), '.chaski');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lock por directorio: mkdir es atómico en Windows, macOS y Linux, así que
 * no hace falta nada más. Devuelve una función para liberarlo, o null si otro
 * proceso lo tiene. Un lock más viejo que maxEdadMs se considera huérfano.
 */
export function tomarLock(cwd, maxEdadMs = 30000) {
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

/**
 * Borra los relevos de ramas que ya no existen en git.
 *
 * Sin esto, cada rama mergeada y borrada deja su relevo para siempre: en un
 * proyecto de un año son cientos de carpetas huérfanas. Y el daño no es el
 * espacio —son unos KB— sino que si alguien recrea una rama con el mismo
 * nombre meses después, hereda un relevo viejo y sin relación.
 *
 * Dos resguardos: solo borra lo que git confirma que no existe, y solo si el
 * relevo tiene más de `diasMinimos`. Una rama recién creada en otro worktree,
 * o un `detached HEAD` momentáneo, no deben costarte el relevo del día.
 *
 * Devuelve los nombres borrados.
 */
export function limpiarRelevosHuerfanos(cwd, diasMinimos = 30) {
  const borrados = [];
  try {
    const dirRamas = join(tambo(cwd), 'ramas');
    if (!existsSync(dirRamas)) return borrados;

    // Si no se puede listar las ramas, no se borra nada: ante la duda, queda.
    const salida = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (salida === null) return borrados;
    const vivas = new Set(salida.split('\n').filter(Boolean).map(slugRama));

    const limite = Date.now() - diasMinimos * 86_400_000;
    for (const entrada of readdirSync(dirRamas, { withFileTypes: true })) {
      if (!entrada.isDirectory() || vivas.has(entrada.name)) continue;
      const ruta = join(dirRamas, entrada.name);
      try {
        if (statSync(ruta).mtimeMs > limite) continue;
        rmSync(ruta, { recursive: true, force: true });
        borrados.push(entrada.name);
      } catch {}
    }
  } catch {}
  return borrados;
}

/** Relevos cuya rama ya no existe, sin borrar nada. Para `doctor`. */
export function relevosHuerfanos(cwd) {
  try {
    const dirRamas = join(tambo(cwd), 'ramas');
    if (!existsSync(dirRamas)) return [];
    const salida = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (salida === null) return [];
    const vivas = new Set(salida.split('\n').filter(Boolean).map(slugRama));
    return readdirSync(dirRamas, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !vivas.has(e.name))
      .map((e) => {
        let dias = 0;
        try { dias = (Date.now() - statSync(join(dirRamas, e.name)).mtimeMs) / 86_400_000; } catch {}
        return { nombre: e.name, dias: Math.round(dias) };
      });
  } catch {
    return [];
  }
}

/** ¿El proyecto vive en una carpeta sincronizada? Esos clientes bloquean archivos al subirlos. */
export function carpetaSincronizada(cwd) {
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
export function tamboIgnorado(cwd) {
  for (const arg of [TAMBO + '/', TAMBO]) {
    try {
      execFileSync('git', ['check-ignore', '-q', arg], { cwd, stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {}
  }
  try {
    const txt = readFileSync(join(resolve(cwd), '.gitignore'), 'utf8');
    return txt.split(/\r?\n/).some((l) => {
      const s = l.trim();
      return s === TAMBO || s === TAMBO + '/';
    });
  } catch {
    return false;
  }
}

export function leerJson(ruta, porDefecto = null) {
  try { return JSON.parse(readFileSync(ruta, 'utf8')); } catch { return porDefecto; }
}

export { existsSync };
