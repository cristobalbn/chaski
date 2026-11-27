#!/usr/bin/env node
// Vigila los CLIs que chaski integra: versiones nuevas, notas de cambios que
// tocan el contrato (hooks, payloads, transcripts, plugins) o que abren una
// oportunidad (statusline, skills, compactación), y líneas mayores que dejan
// de publicarse. Lo corre `.github/workflows/upstream.yml` cada semana y abre
// o actualiza un issue con la etiqueta `upstream`.
//
// Por qué existe: los cuatro CLIs cambian sin avisar y ninguno prometió
// estabilidad. OpenCode 2.x salió en octubre de 2026 con una API de plugins
// incompatible y chaski se enteró un mes después, investigando otra cosa.
//
// No corre en `npm test` (usa la red) ni viaja en el paquete de npm: vive en
// scripts/. Sin dependencias, como todo el repo. Las versiones y la política
// están en scripts/upstream.json; la explicación, en AGENTS.md («Versiones
// soportadas»).
//
//   node scripts/upstream.mjs              informe en Markdown por stdout
//   node scripts/upstream.mjs --out f.md   además lo escribe en f.md
//   GITHUB_TOKEN=...                       evita el límite de la API de GitHub
//
// Sale siempre con 0 salvo error de uso; si hay algo que atender escribe
// `relevant=true` en $GITHUB_OUTPUT.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

// ------------------------------------------------------------ funciones puras

/** `1.19.6`, `v1.19.6` o `rust-v0.172.0` → [1, 19, 6]; null si no es estable. */
export function parseVersion(texto, prefijo = '') {
  let t = String(texto ?? '').trim();
  if (prefijo && t.startsWith(prefijo)) t = t.slice(prefijo.length);
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export const formatVersion = (v) => (v ? v.join('.') : '?');

/**
 * Secciones `## X.Y.Z` de un CHANGELOG en Markdown, de la más nueva a la más
 * vieja, posteriores a `desde`. Claude Code y agy usan ese formato.
 */
export function changelogSections(markdown, desde) {
  const secciones = [];
  let actual = null;
  for (const linea of String(markdown ?? '').split(/\r?\n/)) {
    const h = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/.exec(linea);
    if (h) {
      const v = parseVersion(h[1]);
      if (v && desde && compareVersions(v, desde) <= 0) break;
      actual = v ? { version: v, body: '' } : null;
      if (actual) secciones.push(actual);
      continue;
    }
    if (actual) actual.body += linea + '\n';
  }
  return secciones;
}

/**
 * Releases de GitHub con el prefijo dado, estables y posteriores a `desde`.
 * `major` separa líneas que comparten repo (OpenCode publica v1.* y v2.*).
 */
export function releaseSections(releases, prefijo, desde, major = null) {
  const out = [];
  for (const r of Array.isArray(releases) ? releases : []) {
    if (r?.prerelease || r?.draft) continue;
    if (prefijo && !String(r?.tag_name ?? '').startsWith(prefijo)) continue;
    const v = parseVersion(r?.tag_name, prefijo);
    if (!v || (major !== null && v[0] !== major) || (desde && compareVersions(v, desde) <= 0)) continue;
    out.push({ version: v, body: String(r.body ?? ''), date: r.published_at ?? null });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Líneas de las notas que mencionan alguna palabra clave, por categoría.
 * Se queda con viñetas y frases cortas: el issue lo lee una persona.
 *
 * Cada categoría es `{ words, exclude?, require? }`: `exclude` y `require` son
 * regex sobre el inicio de la línea. Sin ellos, cualquier «Fixed a freeze when
 * a hook…» entraba como posible ruptura del contrato y tapaba lo importante.
 */
export function relevantLines(secciones, keywords, limite = 12) {
  const out = {};
  for (const [categoria, regla] of Object.entries(keywords ?? {})) {
    const { words = [], exclude = null, require: requerido = null } = Array.isArray(regla) ? { words: regla } : regla;
    const res = words.map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const fuera = exclude ? new RegExp(exclude, 'i') : null;
    const dentro = requerido ? new RegExp(requerido, 'i') : null;
    const vistas = new Set();
    const lineas = [];
    for (const s of secciones) {
      for (const bruta of s.body.split(/\r?\n/)) {
        const l = bruta.replace(/^\s*[-*]\s*/, '').replace(/^\*\*[^*]+\*\*:?\s*/, '').trim();
        if (!l || l.length > 400 || vistas.has(l) || !res.some((r) => r.test(l))) continue;
        if ((fuera && fuera.test(l)) || (dentro && !dentro.test(l))) continue;
        vistas.add(l);
        lineas.push({ version: s.version, text: l });
        if (lineas.length >= limite) break;
      }
      if (lineas.length >= limite) break;
    }
    out[categoria] = lineas;
  }
  return out;
}

/**
 * Qué hacer con una línea según la política de scripts/upstream.json:
 * `new-major` si upstream publicó otra mayor (hay que decidir si se soporta),
 * `stale` si la línea no publica hace `staleAfterDays`, y `successor-grace`
 * si ya existe la mayor siguiente y pasó `successorGraceDays` desde entonces.
 */
export function lifecycle({ verified, latest, lastPublished, successorSince }, politica, ahora = Date.now()) {
  const avisos = [];
  if (verified && latest && latest[0] > verified[0]) avisos.push('new-major');
  if (lastPublished && ahora - Date.parse(lastPublished) > politica.staleAfterDays * DAY_MS) avisos.push('stale');
  if (successorSince && ahora - Date.parse(successorSince) > politica.successorGraceDays * DAY_MS) avisos.push('successor-grace');
  return avisos;
}

// ------------------------------------------------------------ red

async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'chaski-upstream-check', ...headers } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers));
}

const npmUrl = (pkg) => `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`;

/** Última versión de npm y cuándo se publicó. */
async function npmLatest(pkg) {
  const doc = await fetchJson(npmUrl(pkg), { accept: 'application/json' });
  const tag = doc?.['dist-tags']?.latest;
  return { version: parseVersion(tag), published: doc?.time?.[tag] ?? null };
}

/**
 * Releases de un repo, en páginas chicas: cada release trae su lista de
 * assets, y 100 por página de openai/codex pesan ~39 MB (una transferencia así
 * llegó cortada). Se pagina hasta pasar la versión verificada.
 */
async function githubReleases(repo, prefijo, verified) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const todas = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`;
    let lote;
    try { lote = await fetchJson(url, headers); } catch { lote = await fetchJson(url, headers); }
    todas.push(...lote);
    const propias = lote.map((r) => (String(r?.tag_name ?? '').startsWith(prefijo) ? parseVersion(r.tag_name, prefijo) : null)).filter(Boolean);
    if (lote.length < 30 || (verified && propias.some((v) => compareVersions(v, verified) <= 0))) break;
  }
  return todas;
}

// ------------------------------------------------------------ informe

async function checkTrack(track, manifest, cache) {
  const verified = parseVersion(track.verified);
  const res = { track, verified, latest: null, published: null, notes: [], errors: [] };

  try {
    if (track.npm) {
      const n = await npmLatest(track.npm);
      res.latest = n.version;
      res.published = n.published;
    }
  } catch (e) { res.errors.push(String(e.message ?? e)); }

  try {
    if (track.notes?.changelog) {
      const md = cache[track.notes.changelog] ??= await fetchText(track.notes.changelog);
      res.notes = changelogSections(md, verified);
      // Sin paquete de npm (agy), la versión nueva es la primera del changelog.
      if (!res.latest) res.latest = changelogSections(md, null)[0]?.version ?? null;
    } else if (track.notes?.github) {
      const clave = `${track.notes.github}#${track.notes.tagPrefix ?? 'v'}`;
      const rel = cache[clave] ??= await githubReleases(track.notes.github, track.notes.tagPrefix ?? 'v', verified);
      res.notes = releaseSections(rel, track.notes.tagPrefix ?? 'v', verified, track.notes.major ?? null);
      if (!res.latest) res.latest = res.notes[0]?.version ?? verified;
      if (!res.published) res.published = res.notes[0]?.date ?? null;
    }
  } catch (e) { res.errors.push(String(e.message ?? e)); }

  res.relevant = relevantLines(res.notes, manifest.keywords);
  return res;
}

export function renderReport(resultados, manifest, ahora = Date.now()) {
  const lineas = ['# Cambios upstream en los CLIs', '',
    `Revisado el ${new Date(ahora).toISOString().slice(0, 10)} por \`scripts/upstream.mjs\`. `
    + 'Política y pasos: AGENTS.md, «Versiones soportadas».', ''];
  let relevante = false;

  for (const r of resultados) {
    const { track } = r;
    const nueva = r.latest && r.verified && compareVersions(r.latest, r.verified) > 0;
    // `successorSince`: cuándo se publicó la mayor siguiente (se anota a mano
    // en la línea vieja al agregar la nueva).
    const avisos = lifecycle({
      verified: r.verified, latest: r.latest, lastPublished: r.published,
      successorSince: track.successorSince ?? null,
    }, manifest, ahora);
    const contrato = r.relevant.contrato ?? [];
    const oportunidad = r.relevant.oportunidad ?? [];
    if (nueva || avisos.length || r.errors.length) relevante = true;

    lineas.push(`## ${track.cli} ${track.line} (\`${track.id}\`)`, '');
    lineas.push(`- Verificada: **${formatVersion(r.verified)}** · última: **${formatVersion(r.latest)}**`
      + (r.published ? ` (${String(r.published).slice(0, 10)})` : '')
      + (nueva ? ` · ${r.notes.length} versión(es) sin verificar` : ' · al día'));
    if (avisos.includes('new-major')) lineas.push('- ⚠ **Nueva versión mayor**: decidir si se soporta y agregar una línea en `scripts/upstream.json`.');
    if (avisos.includes('stale')) lineas.push(`- ⚠ **Sin publicaciones hace más de ${manifest.staleAfterDays} días**: candidata a dejar de soportarse.`);
    if (avisos.includes('successor-grace')) lineas.push(`- ⚠ **Pasó el plazo de gracia** (${manifest.successorGraceDays} días) desde la mayor siguiente: candidata a dejar de soportarse.`);
    for (const e of r.errors) lineas.push(`- ✖ No se pudo leer: ${e}`);
    if (contrato.length) {
      lineas.push('', '**Puede romper el contrato** (re-verificar con `chaski probe` y los fixtures):');
      for (const l of contrato) lineas.push(`- \`${formatVersion(l.version)}\` ${l.text}`);
    }
    if (oportunidad.length) {
      lineas.push('', '**Podría servirnos:**');
      for (const l of oportunidad) lineas.push(`- \`${formatVersion(l.version)}\` ${l.text}`);
    }
    lineas.push('');
  }

  lineas.push('---', '',
    'Al verificar una versión: captura el payload real (`chaski probe`), actualiza el fixture si cambió la forma, '
    + 'corre `npm test` y sube `verified` en `scripts/upstream.json`. El issue se cierra cuando todas las líneas están al día.');
  return { markdown: lineas.join('\n') + '\n', relevant: relevante };
}

async function main(argv) {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  const manifest = JSON.parse(readFileSync(join(AQUI, 'upstream.json'), 'utf8'));
  const cache = {};
  const resultados = [];
  // En serie: los dos tracks de OpenCode comparten el mismo repo y la caché.
  for (const t of manifest.tracks.filter((t) => t.status !== 'dropped')) {
    resultados.push(await checkTrack(t, manifest, cache));
  }
  const { markdown, relevant } = renderReport(resultados, manifest);
  process.stdout.write(markdown);
  if (out) writeFileSync(out, markdown);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${relevant}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`upstream: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
