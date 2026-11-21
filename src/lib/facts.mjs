// Capa de facts: todo lo que se puede derivar de git sin
// llamar a ningún modelo. Cero tokens, milisegundos, y exacto por construcción.
//
// Invariante del proyecto: el modelo NO puede escribir en estos campos.
// El estado de los tests sale del exit code y de ningún otro lado.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, currentBranch, projectDir } from './paths.mjs';
import { isExcludedPath } from './secrets.mjs';
import { hasTime } from './budget.mjs';

// Costo de `diff --numstat` por archivo modificado, calibrado contra git
// real: 1.000/5.000/10.000 archivos sin commitear tardaron ~0,45 ms/archivo
// de forma consistente en el caso de prueba (ver docs/auditoria-2026-11.md).
// Se usa 0,6 con un piso fijo para quedar con margen sin ser tan conservador
// que un turno de 1.000 archivos —un `prettier --write` normal— pierda el
// detalle que sí le cabe en el presupuesto.
const MS_BASE_NUMSTAT = 30;
const MS_POR_ARCHIVO_NUMSTAT = 0.6;
// Lo que se reserva después de numstat para upstream, render, sign y las dos
// escrituras atómicas. Medido: ese resto cuesta decenas de ms, no cientos;
// 200 ms es margen generoso, no ajustado al límite.
const RESERVA_DESPUES_DE_NUMSTAT_MS = 200;

/** Hechos de git: rama, archivos sin commitear, diff y divergencia con upstream. */
export function gitFacts(cwd, config, budget = null, branch = undefined) {
  const h = {
    branch: branch === undefined ? currentBranch(cwd, budget) : branch,
    isRepo: false, dirty: [], commits: [], upstream: null,
    trimmed: [],
  };
  if (h.branch === null) {
    // `null` no significa "no es un repo": git() también devuelve null cuando
    // el subproceso no respondió dentro del presupuesto. Tomarlo como "sin
    // repositorio" hacía que un runner lento —o una máquina cargada— produjera
    // un relevo que afirmaba "Sin repositorio git" y perdía la lista de
    // archivos. Se distingue mirando el disco, que no cuesta un subproceso:
    // si hay un .git, es un repo cuya rama no se pudo leer, y se declara.
    if (!existsSync(join(projectDir(cwd), '.git'))) return h;
    h.trimmed.push('rama actual: "git rev-parse" no respondió dentro del presupuesto de tiempo');
  }
  h.isRepo = true;

  // status --porcelain --branch es la fuente PRIMARIA, no numstat. Antes era al
  // revés, y eso es justo el defecto: numstat calcula diff real por archivo
  // y con miles de archivos sin commitear tarda segundos (medido: ~4,5 s con
  // 10.000, contra ~0,1 s de status --porcelain sobre el mismo árbol), más
  // que el presupuesto entero del hook. status ya trae todo lo que el relevo
  // necesita para la lista y el total — rama, upstream, divergencia, ruta, si
  // es nuevo, incluso renombres (`viejo -> nuevo`) — y numstat solo agrega el
  // detalle de líneas +/-, que es justamente lo que un relevo con miles de
  // archivos no necesita mostrar.
  //
  // El parseo NO usa columnas fijas: el stdout llega sin el espacio inicial de
  // la primera línea, así que un slice(3) cortaría un carácter del name.
  //
  // Si no queda presupuesto ni para ESTE llamado, no hay que confundir "no lo
  // sabemos" con "está limpio": sin status no hay con qué decir que el árbol
  // está limpio, y afirmarlo sería mentir. Por eso se distingue null (no se
  // pudo pedir) de '' (se pidió y no hay nada sucio) en vez de usar `?? ''`
  // como hacían todas las llamadas de esta función en la versión anterior.
  const status = hasTime(budget, 100)
    ? git(cwd, ['status', '--porcelain', '--branch'], { budget }) : null;
  const porArchivo = new Map();
  let statusUpstream = null;
  if (status !== null) {
    for (const linea of status.split('\n')) {
      if (linea.startsWith('## ')) {
        statusUpstream = parseStatusBranch(linea);
        continue;
      }
      const m = /^\s*(\S{1,2})\s+(.+?)\s*$/.exec(linea);
      if (!m) continue;
      const ruta = m[2].replace(/^"|"$/g, '').split(' -> ').pop();
      if (!ruta || isExcludedPath(ruta, config)) continue;
      porArchivo.set(ruta, { ruta, mas: null, menos: null, nuevo: m[1].includes('?') });
    }
  } else {
    h.dirtyUnknown = true;
    h.trimmed.push(
      'lista de archivos sin commitear: se omitió "git status --porcelain" por presupuesto de tiempo '
      + '-- no se puede afirmar que el árbol está limpio, solo que no se comprobó',
    );
  }

  // Últimos commits: barato (cinco líneas fijas) y de alto valor — el relevo
  // nuevo necesita saber qué ya quedó cerrado. Va antes de numstat a
  // propósito: es justo el tipo de paso que SÍ debe sobrevivir un recorte.
  if (hasTime(budget)) {
    const log = git(cwd, ['log', '-5', '--format=%h %s'], { budget }) ?? '';
    h.commits = log.split('\n').filter(Boolean);
  } else {
    h.trimmed.push('últimos commits: se omitió, no quedaba presupuesto de tiempo');
  }

  // El detalle +/- por archivo (numstat) es el paso caro y de bajo valor
  // informativo cuando hay miles de archivos: el relevo solo lista 20 y el
  // total aparte, así que el detalle de los otros 9.980 no aporta nada. Se
  // omite si no cabe en lo que queda del presupuesto — y si se omite, el
  // archivo no desaparece del relevo: sigue viniendo de status, solo que sin
  // el "+X -Y".
  const estimadoNumstat = MS_BASE_NUMSTAT + porArchivo.size * MS_POR_ARCHIVO_NUMSTAT;
  const alcanza = porArchivo.size > 0
    && hasTime(budget, estimadoNumstat + RESERVA_DESPUES_DE_NUMSTAT_MS);

  let numstatOk = porArchivo.size === 0; // nada que enriquecer: no es un recorte
  if (alcanza) {
    const numstat = git(cwd, ['diff', 'HEAD', '--numstat'], { budget });
    // `null` es "no corrió" (timeout, presupuesto, repo sin HEAD); `''` es
    // "corrió y no hay nada que informar", que es el caso NORMAL cuando todo
    // lo sucio está sin seguimiento: numstat no lista archivos untracked.
    // Tratar los dos igual hacía que el relevo declarara un recorte que nunca
    // ocurrió — la misma clase de mentira que el recorte vino a evitar, en la
    // dirección contraria.
    if (numstat !== null) {
      numstatOk = true;
      for (const linea of numstat.split('\n').filter(Boolean)) {
        const [mas, menos, bruto] = linea.split('\t');
        const ruta = renameTarget(bruto);
        if (!ruta || isExcludedPath(ruta, config)) continue;
        const previo = porArchivo.get(ruta);
        porArchivo.set(ruta, { ruta, mas: num(mas), menos: num(menos), nuevo: previo?.nuevo ?? false });
      }
    }
  }
  if (!numstatOk) {
    h.trimmed.push(
      `detalle de líneas +/- de los ${porArchivo.size} archivo(s) sin commitear: se omitió, no quedaba `
      + 'presupuesto de tiempo para "git diff --numstat" (la lista de archivos y el total siguen completos)',
    );
  }

  // Tope deliberado. El relevo muestra 20, pero el estado guardaba todos: en
  // un repo con miles de archivos dirty —tras un `npm install` sin
  // gitignore, o al generar código— el estado.json pasaba del megabyte y se
  // reescribía completo en cada turno. Se guarda un margen sobre lo que se
  // muestra y el total aparte, que es lo único que el relevo necesita.
  const todos = [...porArchivo.values()];
  h.dirty = todos.slice(0, 50);
  h.dirtyTotal = todos.length;

  // Divergencia con upstream: si `status --branch` ya trajo la referencia y el
  // conteo, solo lanza git cuando upstream efectivamente tiene commits nuevos.
  if (hasTime(budget, 150)) {
    h.upstream = upstreamDivergence(cwd, h.dirty.map((s) => s.ruta), budget, statusUpstream);
  } else {
    h.trimmed.push('divergencia con upstream: se omitió, no quedaba presupuesto de tiempo');
  }

  return h;
}

/**
 * Extrae el upstream y cuántos commits tiene por delante de HEAD a partir de
 * la cabecera `## rama...upstream [ahead X, behind Y]` de `git status --branch`.
 */
function parseStatusBranch(linea) {
  const cuerpo = linea.slice(3).trim();
  const idx = cuerpo.indexOf('...');
  if (idx === -1) return { hasUpstream: false };
  const resto = cuerpo.slice(idx + 3);
  const m = /^([^\s\[]+)(?:\s+\[([^\]]+)\])?/.exec(resto);
  if (!m) return { hasUpstream: false };
  const ref = m[1];
  const detalle = m[2] ?? '';
  if (/\bgone\b/.test(detalle)) return { hasUpstream: false };
  const behind = /\bbehind\s+(\d+)\b/.exec(detalle);
  return {
    hasUpstream: true,
    ref,
    ahead: behind ? (parseInt(behind[1], 10) || 0) : 0,
  };
}

/**
 * Qué hicieron los demás en los archivos que estás tocando.
 * Sale de la información que git ya tiene local: no hace fetch, no usa red.
 */
function upstreamDivergence(cwd, misArchivos, budget = null, statusUpstream = null) {
  let up = null;
  let ahead = 0;
  if (statusUpstream) {
    if (!statusUpstream.hasUpstream) return null;
    up = statusUpstream.ref;
    ahead = statusUpstream.ahead;
  } else {
    up = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { budget });
    if (!up) return null;
    if (!hasTime(budget)) return null;

    const cuenta = git(cwd, ['rev-list', '--count', `HEAD..${up}`], { budget });
    ahead = parseInt(cuenta ?? '0', 10) || 0;
  }
  if (ahead === 0) return { ref: up, ahead: 0, collisions: [] };
  if (!hasTime(budget)) return { ref: up, ahead, collisions: [] };

  const tocados = git(cwd, ['diff', '--name-only', `HEAD..${up}`], { budget }) ?? '';
  const suyos = new Set(tocados.split('\n').filter(Boolean));
  const collisions = misArchivos.filter((r) => suyos.has(r));
  return { ref: up, ahead, collisions };
}

/**
 * El archivo de destino, cuando git informa un renombre.
 *
 * `--numstat` usa `viejo.txt => nuevo.txt`, y con prefijo común
 * `src/{viejo.txt => nuevo.txt}`. Sin desarmarlo, el relevo mostraba el
 * renombre como un archivo llamado "viejo.txt => nuevo.txt" **y además**
 * el destino por separado: dos entradas para un solo archivo, una con un
 * nombre que no existe.
 */
function renameTarget(bruto) {
  if (!bruto) return null;
  const s = bruto.trim();
  if (!s.includes('=>')) return s;

  // Forma con llaves: prefijo{antes => después}sufijo
  const conLlaves = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(s);
  if (conLlaves) {
    const [, pre, , despues, post] = conLlaves;
    return (pre + despues + post).replace(/\/{2,}/g, '/');
  }
  // Forma simple: antes => después
  return s.split('=>').pop().trim();
}

function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
