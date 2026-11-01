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

/**
 * Slug seguro para nombre de carpeta a partir de una rama git.
 *
 * Lleva un sufijo con un hash corto del nombre original porque el slug solo
 * no es único: `feat/a-b` y `feat-a-b` producían el mismo texto y compartían
 * el relevo, igual que dos ramas largas que difirieran después del carácter
 * 80. El sufijo mantiene la carpeta legible y la hace inequívoca.
 */
export function slugRama(rama) {
  const nombre = rama || 'sin-rama';
  const base = nombre
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sin-rama';

  // El sufijo solo va cuando hubo transformación, que es cuando puede haber
  // ambigüedad. Así `main` sigue siendo `main` —la carpeta queda legible en
  // el caso habitual— y únicamente los nombres con barras, caracteres raros
  // o más de 60 letras reciben el desambiguador.
  return base === nombre ? base : `${base}-${huella(nombre)}`;
}

/** Hash corto y estable de un nombre, para desambiguar slugs. */
function huella(texto) {
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
export function rama(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Ejecuta git y devuelve stdout, o null ante cualquier fallo.
 * Nunca lanza: un hook que falla le arruina la sesión al usuario.
 */
export function git(cwd, args, timeout = 4000) {
  try {
    return execFileSync('git', [
      // Sin esto, git escapa en octal cualquier ruta con acentos: un
      // `café.txt` llegaba al relevo como `caf\303\251.txt`. Importa en
      // cualquier proyecto en español.
      '-c', 'core.quotepath=false',
      ...args,
    ], {
      cwd, encoding: 'utf8', timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
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

/** Días por defecto antes de borrar el relevo de una rama que ya no existe. */
export const DIAS_SOLO_HECHOS = 30;
export const DIAS_CON_NARRATIVA = 90;

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
 * Así que los relevos con narrativa viven el triple. Y `dias = 0` desactiva
 * la limpieza: la tolerancia a la basura es una preferencia legítima.
 *
 * Dos resguardos más: solo se borra lo que git confirma que no existe, y una
 * rama viva nunca se toca, sin importar la antigüedad.
 *
 * Devuelve los nombres borrados.
 */
export function limpiarRelevosHuerfanos(cwd, opciones = {}) {
  // Compatibilidad: un número suelto se interpreta como los días base.
  const o = typeof opciones === 'number' ? { soloHechos: opciones } : opciones;
  const diasHechos = o.soloHechos ?? DIAS_SOLO_HECHOS;
  const diasNarrativa = o.conNarrativa ?? Math.max(diasHechos * 3, DIAS_CON_NARRATIVA);

  const borrados = [];
  if (diasHechos === 0) return borrados; // limpieza desactivada
  try {
    const dirRamas = join(tambo(cwd), 'ramas');
    if (!existsSync(dirRamas)) return borrados;

    // Si no se puede listar las ramas, no se borra nada: ante la duda, queda.
    const salida = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (salida === null) return borrados;
    const vivas = new Set(salida.split('\n').filter(Boolean).map(slugRama));

    for (const entrada of readdirSync(dirRamas, { withFileTypes: true })) {
      if (!entrada.isDirectory() || vivas.has(entrada.name)) continue;
      const ruta = join(dirRamas, entrada.name);
      try {
        const tieneNarrativa = !!(leerJson(join(ruta, 'estado.json'), {}) ?? {}).narrativa;
        const plazo = tieneNarrativa ? diasNarrativa : diasHechos;
        if (statSync(ruta).mtimeMs > Date.now() - plazo * 86_400_000) continue;
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
        const ruta = join(dirRamas, e.name);
        let dias = 0;
        try { dias = (Date.now() - statSync(ruta).mtimeMs) / 86_400_000; } catch {}
        const conNarrativa = !!(leerJson(join(ruta, 'estado.json'), {}) ?? {}).narrativa;
        return { nombre: e.name, dias: Math.round(dias), conNarrativa };
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

/**
 * Lee un JSON que se va a **modificar y volver a escribir**.
 *
 * Distinto de `leerJson`: si el archivo existe pero no se puede parsear,
 * lanza en lugar de devolver un objeto vacío. Esa diferencia evita el peor
 * error posible del proyecto — un `settings.json` con una coma final o un
 * comentario hacía que `init` lo reemplazara por completo, y el usuario
 * perdía su `model`, su `theme` y sus `permissions` en el primer comando que
 * corría.
 *
 * Para leer algo que solo se consulta, `leerJson` sigue siendo lo correcto.
 */
export function leerJsonParaEscribir(ruta) {
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
