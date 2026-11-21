import { createReadStream, existsSync, mkdirSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readOnlyGlobalDir, readJson, loadConfig, currentBranch, usagePath, tambo, readOnlyTambo, readOnlyStatePath, legacyBranchState, openTurnsPath } from '../lib/paths.mjs';
import { usageSummary } from '../lib/ask.mjs';
import { canonicalAgent } from '../lib/payload.mjs';
import { latestMergedBranchEntry } from '../lib/history.mjs';
import { isFresh, MODEL_TEXT_TTL_MS } from '../lib/time.mjs';
import { writeAtomic } from '../lib/atomic.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { createRedactor, redact, anonymize } from '../lib/secrets.mjs';
import { pad } from './common.mjs';
import { CLIS, isInstalled } from './hook-config.mjs';
import { projectContext } from './project.mjs';

function normalizeAgentMap(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const key = canonicalAgent(k);
    const prevAt = Date.parse(out[key]?.at ?? '');
    const nextAt = Date.parse(v.at ?? '');
    if (!out[key] || (Number.isFinite(nextAt) && (!Number.isFinite(prevAt) || nextAt >= prevAt))) {
      out[key] = v;
    }
  }
  return out;
}

export function next() {
  const { cwd } = projectContext();
  console.log('\nchaski next\n');
  const branch = currentBranch(cwd);
  const rama = branch ?? 'sin-rama';
  const estado = readBranchState(cwd, branch);
  const quota = normalizeAgentMap(readJson(join(readOnlyGlobalDir(), 'quota.json'), {}));
  const writtenMs = Date.parse(estado.writtenAt ?? '');
  const edadRelevo = Number.isFinite(writtenMs)
    ? Math.max(0, Math.round((Date.now() - writtenMs) / 60000))
    : null;
  const detalleRelevo = edadRelevo !== null
    ? `relevo al día (hace ${edadRelevo} min)`
    : 'sin relevo todavía';

  const usage = normalizeAgentMap(readJson(usagePath(), {}));
  const now = Date.now();
  const filas = [];
  for (const [name, cli] of Object.entries(CLIS)) {
    const instalado = isInstalled(cli.bin);
    const q = quota[name];
    // Cuota real, si la statusline de chaski la anotó (#82).
    const uso = usageSummary(usage[name]);
    const qAt = Date.parse(q?.at ?? '');
    const validQAt = Number.isFinite(qAt) && qAt <= now + 60_000;
    const minsAgotado = validQAt ? Math.max(0, Math.round((now - qAt) / 60000)) : null;
    // Un registro de agotamiento de más de 12 h ya expiró en cualquier ventana
    // de cuota de consumidor.
    const agotado = Boolean(q && minsAgotado !== null && minsAgotado < 720);
    filas.push({ name, instalado, agotado, q, minsAgotado, uso });
  }

  // Preferimos sugerir un CLI disponible distinto del que acaba de sellar por
  // límite; si todos están disponibles, el primero instalado.
  const disponibles = filas.filter((f) => f.instalado && !f.agotado);
  const agenteSellado = estado.agent ? canonicalAgent(estado.agent) : null;
  const sugerido = disponibles.find((f) => estado.sealedAtLimit ? f.name !== agenteSellado : true)
    ?? disponibles[0]
    ?? null;

  for (const f of filas) {
    const flecha = sugerido && f.name === sugerido.name ? '→' : ' ';
    if (!f.instalado) {
      console.log(`  ${flecha} ${pad(f.name)} no instalado`);
    } else if (f.agotado) {
      const rawMotivo = typeof f.q.message === 'string' && f.q.message.trim()
        ? f.q.message
        : (typeof f.q.reason === 'string' && f.q.reason.trim() ? f.q.reason : 'rate_limit');
      const motivo = rawMotivo.replace(/\s+/g, ' ').trim();
      console.log(`  ${flecha} ${pad(f.name)} agotado · hace ${f.minsAgotado} min (${motivo})`);
    } else {
      console.log(`  ${flecha} ${pad(f.name)} disponible · ${detalleRelevo}${f.uso ? ` · ${f.uso}` : ''}`);
    }
  }

  console.log('');
  const sucios = estado.facts?.dirtyTotal ?? estado.facts?.dirty?.length ?? 0;
  const estadoArbol = sucios
    ? `${sucios} archivo(s) sin commitear`
    : (estado.facts?.dirtyUnknown || !Number.isFinite(writtenMs))
      ? 'estado del árbol sin comprobar'
      : 'árbol limpio';
  console.log(`  # ${estadoArbol} en ${rama}`);
  if (estado.facts?.upstream?.ahead > 0) {
    const colisiones = estado.facts.upstream.collisions?.length
      ? ` (${estado.facts.upstream.collisions.length} archivo(s) en común)` : '';
    console.log(`  # upstream (${estado.facts.upstream.ref}) tiene ${estado.facts.upstream.ahead} commit(s) que no tienes${colisiones}`);
  }
  if (estado.lastFile) {
    console.log(`  # último archivo tocado: ${estado.lastFile}`);
  }
  const config = loadConfig(cwd);
  const narrativaRedactada = estado.narrative ? redact(String(estado.narrative), config).texto : null;
  const pendiente = summarizePending(narrativaRedactada);
  const heredada = latestMergedBranchEntry(cwd, estado);
  if (pendiente) {
    console.log(`  # pendiente: ${pendiente}`);
  } else if (!heredada && estado.lastReply?.text && isFresh(estado.lastReply.at, MODEL_TEXT_TTL_MS)) {
    const respaldo = summarizeLastReply(redact(String(estado.lastReply.text), config).texto);
    if (respaldo) console.log(`  # última respuesta: ${respaldo}`);
  }
  if (heredada) {
    const pendienteHeredado = summarizePending(redact(String(heredada.narrative), config).texto);
    if (pendienteHeredado) {
      console.log(`  # narrativa más reciente (de ${heredada.branch}, ya no existe): ${pendienteHeredado}`);
    }
  }
  if (Array.isArray(estado.backgroundTasks) && estado.backgroundTasks.length) {
    const tareas = estado.backgroundTasks
      .map((t) => redact(String(t?.description ?? ''), config).texto.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (tareas.length) {
      console.log(`  # en segundo plano: ${tareas.join('; ')}`);
    }
  }
  const abiertos = activeOpenTurns(cwd);
  if (abiertos.length) {
    console.log(`  # turno(s) abierto(s): ${abiertos.join(', ')} (revisa git status / git diff)`);
  }
  console.log('');
}

function readBranchState(cwd, branch) {
  const canonical = readOnlyStatePath(cwd, branch);
  if (existsSync(canonical)) return readJson(canonical, {}) ?? {};
  const legacy = legacyBranchState(cwd, branch);
  return legacy ? (readJson(join(legacy.dir, 'estado.json'), {}) ?? {}) : {};
}

function summarizePending(narrative) {
  if (!narrative) return null;
  const lineas = String(narrative).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const patron = /^([*#>-]|\d+\.)*\s*(pendiente|siguiente paso|en vuelo|a medias|falta)\b/i;
  const soloTitulo = /^([*#>-]|\d+\.)*\s*(pendiente|siguiente paso|en vuelo|a medias|falta)\s*[:*—-]*\s*$/i;
  const idx = lineas.findIndex((l) => patron.test(l));
  const clave = idx === -1 ? null : (soloTitulo.test(lineas[idx]) ? lineas[idx + 1] : lineas[idx]);
  const elegida = (clave ?? lineas.find((l) => !l.startsWith('#') && !/^\*\*[^*]+\*\*\s*:?\s*$/.test(l))) || null;
  return elegida ? elegida.replace(/^[-*#>\s]+/, '').slice(0, 120) : null;
}

function summarizeLastReply(text) {
  const limpio = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!limpio) return null;
  return limpio.length > 120 ? limpio.slice(0, 119) + '…' : limpio;
}

function activeOpenTurns(cwd, ahora = Date.now()) {
  const crudo = readJson(openTurnsPath(cwd), null);
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return [];
  const agentes = [];
  for (const t of Object.values(crudo)) {
    if (isFresh(t?.at, MODEL_TEXT_TTL_MS, ahora)) {
      const nombre = t?.agent ? canonicalAgent(t.agent) : 'otro agente';
      agentes.push(String(nombre).replace(/[^\w .-]/g, ''));
    }
  }
  return [...new Set(agentes)];
}

// ----------------------------------------------------------------- cost

export function cost() {
  console.log('\nchaski cost\n');
  console.log('Gasto externo');
  console.log('  0 tokens · $0.00 (chaski no invoca modelos ni APIs externas)\n');

  const rawCost = readJson(join(readOnlyGlobalDir(), 'cost.json'), { asks: [], narratives: [] });
  const c = rawCost && typeof rawCost === 'object' && !Array.isArray(rawCost) ? rawCost : {};
  const isEntry = (x) => Boolean(x && typeof x === 'object' && !Array.isArray(x));
  const asks = Array.isArray(c.asks) ? c.asks.filter(isEntry) : [];
  const narratives = Array.isArray(c.narratives) ? c.narratives.filter(isEntry) : [];
  const now = Date.now();
  const hace7d = now - 7 * 86_400_000;
  const in7d = (x) => {
    const t = Date.parse(x?.at ?? '');
    return Number.isFinite(t) && t >= hace7d && t <= now + 60_000;
  };

  const asks7d = asks.filter(in7d);
  const narr7d = narratives.filter(in7d);

  // Desde #73 la mayoría de las peticiones se difieren: llegan junto con el
  // mensaje siguiente del usuario y no agregan un turno. Contarlas como
  // «turnos extra» exageraba el costo; se separan.
  const enStop = (l) => l.filter((x) => !x?.deferred);
  const diferidas = (l) => l.filter((x) => Boolean(x?.deferred));

  console.log('Peticiones de narrativa (últimos 7 días / histórico)');
  console.log(`  ${pad('en Stop')} ${enStop(asks7d).length} en 7d · ${enStop(asks).length} total — cada una agrega un turno`);
  console.log(`  ${pad('diferidas')} ${diferidas(asks7d).length} en 7d · ${diferidas(asks).length} total — sin turno extra, antes de la respuesta`);
  console.log(`  ${pad('narrativas')} ${narr7d.length} en 7d · ${narratives.length} total
`);

  console.log('Por CLI');
  for (const name of Object.keys(CLIS)) {
    const de = (l) => l.filter((x) => canonicalAgent(x?.agent) === name);
    const n7 = de(narr7d).length;
    const nTot = de(narratives).length;
    console.log(`  ${pad(name)} ${n7} narrativa(s) en 7d (${nTot} total) · ${enStop(de(asks7d)).length} en Stop y ${diferidas(de(asks7d)).length} diferida(s) en 7d`);
  }
  console.log('');
}

// ------------------------------------------------------------------ why

export async function why(args) {
  const { cwd } = projectContext();
  const filtro = args.join(' ').trim().toLowerCase();
  const terminos = filtro ? filtro.split(/\s+/).filter(Boolean) : [];
  console.log(`\nchaski why${filtro ? ` — "${filtro}"` : ''}\n`);

  const tambo = readOnlyTambo(cwd);
  const coincidencias = [];
  let seq = 0;
  const addMatch = (entry) => {
    const texto = `${entry.branch ?? ''} ${entry.author ?? ''} ${entry.narrative}`.toLowerCase();
    if (terminos.length && !terminos.every((t) => texto.includes(t))) return;
    const ms = Date.parse(entry.at ?? '');
    coincidencias.push({ ...entry, _ms: Number.isFinite(ms) ? ms : null, _seq: seq++ });
  };

  // También revisa el estado vivo de cada rama por si una narrativa se
  // escribió a mano en estado.json y todavía no pasó por otra captura.
  const redactNarrative = createRedactor(loadConfig(cwd));
  const live = new Map();
  const branchesDir = join(tambo, 'branches');
  if (existsSync(branchesDir)) {
    for (const dir of readdirSync(branchesDir)) {
      const est = readJson(join(branchesDir, dir, 'estado.json'), null);
      const rawNarrative = String(est?.narrative ?? '').trim();
      if (!rawNarrative) continue;
      // La narrativa de estado.json la escribe el agente tal cual: se redacta
      // al mostrarla, como en el relevo (secretos y <private>). La de
      // historia/ ya se redactó al archivarse.
      const texto = redactNarrative(rawNarrative).texto;
      const branch = est.facts?.branch ?? dir;
      const key = JSON.stringify([branch, texto]);
      if (live.has(key)) continue;
      live.set(key, {
        fuente: 'rama',
        at: est.narrativeWrittenAt || est.writtenAt || null,
        author: est.narrativeAuthor || est.agent ? canonicalAgent(est.narrativeAuthor || est.agent) : '?',
        branch,
        head: est.head ?? null,
        narrative: texto,
      });
    }
  }

  for await (const entry of historyEntries(join(tambo, 'historia', 'entries.jsonl'))) {
    // Una copia archivada prevalece sobre la misma narrativa en estado.json,
    // incluso cuando la búsqueda no coincide con el autor archivado.
    const narrative = redactNarrative(String(entry.narrative).trim()).texto;
    if (live.size) live.delete(JSON.stringify([entry.branch, narrative]));
    const author = entry.author ? canonicalAgent(entry.author) : '?';
    addMatch({ ...entry, narrative, author, fuente: 'historia' });
  }
  for (const entry of live.values()) addMatch(entry);

  const decDir = join(cwd, 'decisiones');
  if (existsSync(decDir)) {
    for (const f of readdirSync(decDir).filter((n) => n.endsWith('.md')).sort()) {
      try {
        const txt = redactNarrative(readFileSync(join(decDir, f), 'utf8').trim()).texto;
        addMatch({
          fuente: `decisiones/${f}`,
          at: f.slice(0, 10),
          author: 'equipo',
          branch: f,
          head: null,
          narrative: txt,
        });
      } catch {}
    }
  }

  if (!coincidencias.length) {
    console.log(filtro
      ? `  No encontré decisiones que mencionen "${filtro}".\n`
      : '  Todavía no hay narrativas registradas en .tambo/historia/ ni en decisiones/.\n');
    return;
  }

  const ordenadas = [...coincidencias]
    .sort((a, b) => {
      if (a._ms !== b._ms) {
        if (a._ms === null) return -1;
        if (b._ms === null) return 1;
        return a._ms - b._ms;
      }
      return a._seq - b._seq;
    })
    .slice(-10)
    .reverse();

  for (const e of ordenadas) {
    const fecha = String(e.at ?? '').slice(0, 16).replace('T', ' ') || 'sin fecha';
    const head = e.head ? ` · ${e.head}` : '';
    console.log(`── ${fecha} · ${e.branch} · por ${e.author}${head} (${e.fuente})`);
    console.log(e.narrative.trim());
    console.log('');
  }
}

async function* historyEntries(path) {
  const parse = (line) => {
    try {
      const entry = JSON.parse(line);
      return typeof entry?.narrative === 'string' && entry.narrative ? entry : null;
    } catch { return null; }
  };
  let partial = '';
  try {
    for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const entry = parse(line);
        if (entry) yield entry;
      }
    }
    const entry = parse(partial);
    if (entry) yield entry;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// ---------------------------------------------------------------- share

export function share(args) {
  const { cwd } = projectContext();
  const autoConfirm = args.includes('--yes');
  const temaArgs = args.filter((a) => a !== '--yes').join(' ').trim();

  const branch = currentBranch(cwd);
  const estado = readBranchState(cwd, branch);
  const tienePropia = Boolean(estado.narrative && String(estado.narrative).trim());
  const heredada = tienePropia ? null : latestMergedBranchEntry(cwd, estado);
  if (!tienePropia && !heredada) {
    console.error('\nchaski share: la rama actual no tiene narrativa para publicar.');
    console.error('Escribe «relevo» en tu agente antes de compartir una decisión.\n');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(cwd);
  const home = homedir();
  const redactForShare = (value) => {
    const { texto, redactions } = redact(value, config);
    return { ...anonymize(texto, { home }), redactions };
  };
  const narrativeRaw = tienePropia ? String(estado.narrative).trim() : String(heredada.narrative).trim();
  const branchRaw = tienePropia ? (branch || 'decision') : (heredada.branch || branch || 'decision');
  const authorRaw = tienePropia
    ? (estado.narrativeAuthor || estado.agent ? canonicalAgent(estado.narrativeAuthor ?? estado.agent) : 'desconocido')
    : (heredada.author ? canonicalAgent(heredada.author) : 'desconocido');
  const headRaw = tienePropia ? estado.head : heredada.head;
  const body = redactForShare(narrativeRaw);
  const branchLabel = redactForShare(branchRaw);
  const title = temaArgs ? redactForShare(temaArgs) : branchLabel;
  const author = redactForShare(authorRaw);
  const redactions = body.redactions + branchLabel.redactions + (temaArgs ? title.redactions : 0) + author.redactions;
  const anonymized = body.anonymized + branchLabel.anonymized + (temaArgs ? title.anonymized : 0) + author.anonymized;
  const slug = slugify(title.texto);
  const fecha = new Date().toISOString().slice(0, 10);
  const decDir = join(cwd, 'decisiones');
  const nombre = decisionName(decDir, fecha, slug);
  const titulo = temaArgs ? title.texto : `Decisión en ${branchLabel.texto}`;
  const head = /^[0-9a-f]{4,64}$/i.test(headRaw ?? '') ? ` (${headRaw})` : '';
  const contenido = [
    `# ${titulo}`,
    '',
    `- Fecha: ${fecha}`,
    `- Rama: ${branchLabel.texto}${head}`,
    `- Autor del relevo: ${author.texto}`,
    '',
    body.texto,
    '',
  ].join('\n');

  console.log(`\nchaski share → decisiones/${nombre}`);
  if (redactions > 0) {
    console.log(`(${redactions} secreto(s) redactado(s) antes de publicar)`);
  }
  if (anonymized > 0) {
    console.log(`(${anonymized} dato(s) personal(es) anonimizado(s): carpetas personales y correos)`);
  }
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(contenido.trimEnd());
  console.log('────────────────────────────────────────────────────────────\n');

  if (!autoConfirm) {
    process.stdout.write(`¿Escribir en decisiones/${nombre}? [s/N]: `);
    const resp = readStdinLine();
    if (!/^(s|si|sí|y|yes)$/i.test(resp)) {
      console.log('\nCancelado: no se escribió ningún archivo.\n');
      process.exitCode = 1;
      return;
    }
  }

  const published = withFileLock(join(tambo(cwd), 'share'), () => {
    mkdirSync(decDir, { recursive: true });
    // El nombre de la vista previa puede haberse ocupado al confirmar.
    const name = decisionName(decDir, fecha, slug);
    writeAtomic(join(decDir, name), contenido);
    return name;
  });
  if (!published) throw new Error('otra publicación está en curso. Vuelve a ejecutar share');
  console.log(`Publicado en decisiones/${published}\n`);
}

function decisionName(dir, date, slug) {
  const base = `${date}-${slug}`;
  let name = `${base}.md`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${base}-${n}.md`;
  return name;
}

function slugify(s) {
  const limpio = String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return limpio || 'decision';
}

function readStdinLine() {
  const bytes = [];
  const buf = Buffer.alloc(1);
  while (bytes.length < 256) {
    let n = 0;
    try { n = readSync(0, buf, 0, 1, null); } catch { break; }
    if (n <= 0) break;
    if (buf[0] === 0x0a) break;
    bytes.push(buf[0]);
  }
  return Buffer.from(bytes).toString('utf8').trim();
}
