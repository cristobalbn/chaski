import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { branchSlug, git, readJson, readOnlyTambo, readOnlyGlobalDir, globalDir, projectDir } from './paths.mjs';
import { hasTime } from './budget.mjs';
import { DAY_MS } from './time.mjs';
import { writeAtomic } from './atomic.mjs';
import { withFileLock } from './lock.mjs';

const FACT_DAYS = 30;
const NARRATIVE_DAYS = 90;
const MAINTENANCE_FLOOR_MS = 200;

export function effectivePruneDays(options = {}) {
  const config = typeof options === 'number' ? { factsOnly: options } : (options ?? {});
  const days = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  const facts = days(config.factsOnly, FACT_DAYS);
  return { facts, narrative: days(config.withNarrative, Math.max(facts * 3, NARRATIVE_DAYS)) };
}

function orphanPaths(cwd, budget) {
  const dir = join(readOnlyTambo(cwd), 'branches');
  if (!existsSync(dir)) return [];
  // Un tag con el mismo nombre hace que refname:short devuelva heads/rama.
  // El nombre completo permite quitar exactamente el prefijo de ramas.
  const prefix = 'refs/heads/';
  const output = git(cwd, ['for-each-ref', '--format=%(refname)%00%(refname:short)', prefix], {
    budget, timeout: budget ? 250 : undefined,
  });
  if (output === null) return null;
  const live = new Set();
  for (const line of output.split('\n')) {
    const [full, legacy] = line.split('\0');
    if (!full.startsWith(prefix)) continue;
    live.add(branchSlug(full.slice(prefix.length)));
    if (legacy) live.add(branchSlug(legacy));
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !live.has(entry.name))
    .map(({ name }) => ({ name, path: join(dir, name) }));
}

function hasNarrative(path) {
  return Boolean(readJson(join(path, 'estado.json'), null)?.narrative);
}

function prune(cwd, options, budget) {
  const { facts, narrative } = effectivePruneDays(options);
  const removed = [];
  if (facts === 0) return { removed, completed: true };
  const orphans = orphanPaths(cwd, budget);
  if (!orphans) return { removed, completed: false };
  const now = Date.now();
  for (const { name, path } of orphans) {
    if (!hasTime(budget, 80)) return { removed, completed: false };
    try {
      const age = now - statSync(path).mtimeMs;
      if (age < Math.min(facts, narrative || facts) * DAY_MS) continue;
      const days = hasNarrative(path) ? narrative : facts;
      if (!days || age < days * DAY_MS) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      removed.push(name);
    } catch {}
  }
  return { removed, completed: true };
}

/** Solo borra estados antiguos de ramas que Git confirma ausentes. */
export function pruneOrphanRelays(cwd, options = {}) {
  try { return prune(cwd, options, null).removed; } catch { return []; }
}

export function orphanRelays(cwd) {
  try {
    return (orphanPaths(cwd, null) ?? []).map(({ name, path }) => {
      let days = 0;
      try { days = Math.round((Date.now() - statSync(path).mtimeMs) / DAY_MS); } catch {}
      return { name, days, withNarrative: hasNarrative(path) };
    });
  } catch { return []; }
}

/** La poda es mantenimiento diario. Ante un recorte, puede retomarse otro turno. */
export function pruneOnSchedule(cwd, options, budget) {
  if (!hasTime(budget, MAINTENANCE_FLOOR_MS) || effectivePruneDays(options).facts === 0
      || !existsSync(join(projectDir(cwd), '.git'))) return;
  try {
    const marker = join(readOnlyGlobalDir(), 'ultima-limpieza');
    const due = () => {
      const at = readJson(marker, null);
      const now = Date.now();
      return !Number.isFinite(at) || at > now || now - at >= DAY_MS;
    };
    if (!due()) return;
    globalDir();
    withFileLock(marker, () => {
      if (!due() || !hasTime(budget, MAINTENANCE_FLOOR_MS)) return;
      if (prune(cwd, options, budget).completed) writeAtomic(marker, String(Date.now()));
    }, 0);
  } catch {}
}
