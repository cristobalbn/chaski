import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readOnlyGlobalDir, readJson, loadConfig, currentBranch, usagePath, tambo, readOnlyTambo, readOnlyStatePath, legacyBranchState, openTurnsPath } from '../lib/paths.mjs';
import { usageSummary } from '../lib/ask.mjs';
import { latestMergedBranchEntry } from '../lib/history.mjs';
import { isFresh, MODEL_TEXT_TTL_MS } from '../lib/time.mjs';
import { writeAtomic } from '../lib/atomic.mjs';
import { withFileLock } from '../lib/lock.mjs';
import { createRedactor, redact, anonymize } from '../lib/secrets.mjs';
import { pad } from './common.mjs';
import { CLIS, isInstalled } from './hook-config.mjs';
import { projectContext } from './project.mjs';

export function next() {
  const { cwd } = projectContext();
  console.log('\nchaski next\n');
  const branch = currentBranch(cwd);
  const estado = readBranchState(cwd, branch);
  const quota = readJson(join(readOnlyGlobalDir(), 'quota.json'), {}) ?? {};
  const edadRelevo = estado.writtenAt
    ? Math.max(0, Math.round((Date.now() - new Date(estado.writtenAt).getTime()) / 60000))
    : null;
  const detalleRelevo = edadRelevo !== null
    ? `relevo al día (hace ${edadRelevo} min)`
    : 'sin relevo todavía';

  const usage = readJson(usagePath(), {}) ?? {};
  const filas = [];
  for (const [name, cli] of Object.entries(CLIS)) {
    const instalado = isInstalled(cli.bin);
    const q = quota[name];
    // Cuota real, si la statusline de chaski la anotó (#82).
    const uso = usageSummary(usage[name]);
    const minsAgotado = q?.at ? Math.round((Date.now() - new Date(q.at).getTime()) / 60000) : null;
    // Un registro de agotamiento de más de 12 h ya expiró en cualquier ventana
    // de cuota de consumidor.
    const agotado = Boolean(q && minsAgotado !== null && minsAgotado < 720);
    filas.push({ name, instalado, agotado, q, minsAgotado, uso });
  }

  // Preferimos sugerir un CLI disponible distinto del que acaba de sellar por
  // límite; si todos están disponibles, el primero instalado.
  const disponibles = filas.filter((f) => f.instalado && !f.agotado);
  const sugerido = disponibles.find((f) => estado.sealedAtLimit ? f.name !== estado.agent : true)
    ?? disponibles[0]
    ?? null;

  for (const f of filas) {
    const flecha = sugerido && f.name === sugerido.name ? '→' : ' ';
    if (!f.instalado) {
      console.log(`  ${flecha} ${pad(f.name)} no instalado`);
    } else if (f.agotado) {
      const motivo = f.q.message || f.q.reason || 'rate_limit';
      console.log(`  ${flecha} ${pad(f.name)} agotado · hace ${f.minsAgotado} min (${motivo})`);
    } else {
      console.log(`  ${flecha} ${pad(f.name)} disponible · ${detalleRelevo}${f.uso ? ` · ${f.uso}` : ''}`);
    }
  }

  console.log('');
  const sucios = estado.facts?.dirtyTotal ?? estado.facts?.dirty?.length ?? 0;
  console.log(`  # ${sucios ? `${sucios} archivo(s) sin commitear` : 'árbol limpio'} en ${branch}`);
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
      agentes.push(String(t?.agent ?? 'otro agente').replace(/[^\w .-]/g, ''));
    }
  }
  return [...new Set(agentes)];
}

// ----------------------------------------------------------------- cost

export function cost() {
  console.log('\nchaski cost\n');
  console.log('Gasto externo');
  console.log('  0 tokens · $0.00 (chaski no invoca modelos ni APIs externas)\n');

  const c = readJson(join(readOnlyGlobalDir(), 'cost.json'), { asks: [], narratives: [] }) ?? {};
  const asks = Array.isArray(c.asks) ? c.asks : [];
  const narratives = Array.isArray(c.narratives) ? c.narratives : [];
  const hace7d = Date.now() - 7 * 86_400_000;

  const asks7d = asks.filter((x) => new Date(x.at).getTime() >= hace7d);
  const narr7d = narratives.filter((x) => new Date(x.at).getTime() >= hace7d);

  // Desde #73 la mayoría de las peticiones se difieren: llegan junto con el
  // mensaje siguiente del usuario y no agregan un turno. Contarlas como
  // «turnos extra» exageraba el costo; se separan.
  const enStop = (l) => l.filter((x) => !x.deferred);
  const diferidas = (l) => l.filter((x) => x.deferred);

  console.log('Peticiones de narrativa (últimos 7 días / histórico)');
  console.log(`  ${pad('en Stop')} ${enStop(asks7d).length} en 7d · ${enStop(asks).length} total — cada una agrega un turno`);
  console.log(`  ${pad('diferidas')} ${diferidas(asks7d).length} en 7d · ${diferidas(asks).length} total — sin turno extra, antes de la respuesta`);
  console.log(`  ${pad('narrativas')} ${narr7d.length} en 7d · ${narratives.length} total
`);

  console.log('Por CLI');
  for (const name of Object.keys(CLIS)) {
    const de = (l) => l.filter((x) => x.agent === name);
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
  const addMatch = (entry) => {
    const texto = `${entry.branch ?? ''} ${entry.author ?? ''} ${entry.narrative}`.toLowerCase();
    if (terminos.length && !terminos.every((t) => texto.includes(t))) return;
    coincidencias.push(entry);
    if (coincidencias.length > 10) coincidencias.shift();
  };

  // También revisa el estado vivo de cada rama por si una narrativa se
  // escribió a mano en estado.json y todavía no pasó por otra captura.
  const live = new Map();
  const branchesDir = join(tambo, 'branches');
  if (existsSync(branchesDir)) {
    const redactNarrative = createRedactor(loadConfig(cwd));
    for (const dir of readdirSync(branchesDir)) {
      const est = readJson(join(branchesDir, dir, 'estado.json'), null);
      if (!est?.narrative) continue;
      // La narrativa de estado.json la escribe el agente tal cual: se redacta
      // al mostrarla, como en el relevo (secretos y <private>). La de
      // historia/ ya se redactó al archivarse.
      const texto = redactNarrative(String(est.narrative).trim()).texto;
      const branch = est.facts?.branch ?? dir;
      const key = JSON.stringify([branch, texto]);
      if (live.has(key)) continue;
      live.set(key, {
        fuente: 'rama',
        at: est.narrativeWrittenAt ?? est.writtenAt ?? null,
        author: est.narrativeAuthor ?? est.agent ?? '?',
        branch,
        head: est.head ?? null,
        narrative: texto,
      });
    }
  }

  for await (const entry of historyEntries(join(tambo, 'historia', 'entries.jsonl'))) {
    // Una copia archivada prevalece sobre la misma narrativa en estado.json,
    // incluso cuando la búsqueda no coincide con el autor archivado.
    if (live.size) live.delete(JSON.stringify([entry.branch, entry.narrative]));
    addMatch({ ...entry, fuente: 'historia' });
  }
  for (const entry of live.values()) addMatch(entry);

  const decDir = join(cwd, 'decisiones');
  if (existsSync(decDir)) {
    for (const f of readdirSync(decDir).filter((n) => n.endsWith('.md')).sort()) {
      try {
        const txt = readFileSync(join(decDir, f), 'utf8').trim();
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

  for (const e of coincidencias.reverse()) {
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
  if (!estado.narrative || !String(estado.narrative).trim()) {
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
  const body = redactForShare(String(estado.narrative).trim());
  const branchLabel = redactForShare(branch || 'decision');
  const title = temaArgs ? redactForShare(temaArgs) : branchLabel;
  const author = redactForShare(estado.narrativeAuthor ?? estado.agent ?? 'desconocido');
  const redactions = body.redactions + branchLabel.redactions + (temaArgs ? title.redactions : 0) + author.redactions;
  const anonymized = body.anonymized + branchLabel.anonymized + (temaArgs ? title.anonymized : 0) + author.anonymized;
  const slug = slugify(title.texto);
  const fecha = new Date().toISOString().slice(0, 10);
  const decDir = join(cwd, 'decisiones');
  const nombre = decisionName(decDir, fecha, slug);
  const titulo = temaArgs ? title.texto : `Decisión en ${branchLabel.texto}`;
  const head = /^[0-9a-f]{4,64}$/i.test(estado.head ?? '') ? ` (${estado.head})` : '';
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
    let resp = '';
    try { resp = readFileSync(0, 'utf8').trim(); } catch {}
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
