import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, currentBranch, projectDir } from './paths.mjs';
import { createPathFilter, createRedactor } from './secrets.mjs';
import { hasTime } from './budget.mjs';

// Calibrado con árboles de hasta 10.000 archivos modificados. La reserva
// deja tiempo para firmar y guardar el relevo si se calcula el diff.
const NUMSTAT_BASE_MS = 30;
const NUMSTAT_PER_FILE_MS = 0.6;
const AFTER_NUMSTAT_MS = 200;
const STATUS_TIMEOUT_MS = 450;
const MAX_DIRTY = 50;

/**
 * Un solo status entrega rama, HEAD, upstream y archivos. El timeout deja
 * margen para consultar la rama por separado cuando el árbol tarda demasiado.
 */
export function readGitSnapshot(cwd, budget = null) {
  const root = projectDir(cwd);
  const hasWorktree = existsSync(join(root, '.git'));
  if (!hasWorktree && !process.env.GIT_DIR && !existsSync(join(root, 'HEAD'))) {
    return { branch: null, isRepo: false };
  }

  const status = hasTime(budget, 100)
    ? git(root, ['--no-optional-locks', '-c', 'status.aheadBehind=true', 'status', '--porcelain=v2', '--branch', '-z'], {
      budget, raw: true, timeout: budget ? STATUS_TIMEOUT_MS : undefined,
    }) : null;
  const records = status === null ? null : status.split('\0');
  const headers = new Map();
  for (const record of records ?? []) {
    if (!record.startsWith('# ')) break;
    const separator = record.indexOf(' ', 2);
    if (separator !== -1) headers.set(record.slice(2, separator), record.slice(separator + 1));
  }
  const oid = headers.get('branch.oid');
  const worktreeBranch = headers.get('branch.head');
  const unborn = oid === '(initial)';
  const head = /^[0-9a-f]{40,64}$/i.test(oid ?? '') ? oid : null;
  const branch = unborn ? null : worktreeBranch === '(detached)' ? 'HEAD'
    : worktreeBranch ?? currentBranch(root, budget);
  return { branch, isRepo: hasWorktree || status !== null || branch !== null, records, headers: records ? headers : null, head, unborn };
}

/** Hechos de git para el relevo, con la misma rama que se usó al leer su estado. */
export function gitFacts(cwd, config, budget = null, snapshot = readGitSnapshot(cwd, budget)) {
  const { branch, isRepo, records, headers, head, unborn } = snapshot;
  const facts = { branch, isRepo, dirty: [], commits: [], upstream: null, trimmed: [] };
  if (!isRepo) return facts;
  if (!branch && !unborn) facts.trimmed.push('rama actual: no se pudo confirmar con git');
  if (!records) {
    facts.dirtyUnknown = true;
    facts.trimmed.push('lista de archivos sin commitear: no respondió git status. No se pudo comprobar si el árbol está limpio');
  }

  const files = new Map();
  let isExcluded;
  for (let i = 0; i < (records?.length ?? 0); i++) {
    const record = records[i];
    let path;
    let untracked = false;
    if (record.startsWith('? ')) {
      untracked = true;
      path = record.slice(2);
    } else if (record.startsWith('1 ')) {
      path = pathAfterFields(record, 8);
    } else if (record.startsWith('2 ')) {
      path = pathAfterFields(record, 9);
      i++; // En porcelain v2, el destino va antes del origen.
    } else if (record.startsWith('u ')) {
      path = pathAfterFields(record, 10);
    }
    if (path && !(isExcluded ??= createPathFilter(config))(path)) {
      files.set(path, { ruta: path, mas: null, menos: null, nuevo: untracked });
    }
  }

  if (!unborn) {
    const log = hasTime(budget)
      ? git(cwd, ['log', '-5', '--format=%h %s', head ?? 'HEAD', '--'], { budget }) : null;
    if (log === null) facts.trimmed.push('últimos commits: no se pudieron consultar');
    else {
      const redactCommit = createRedactor(config);
      facts.commits = log.split('\n').filter(Boolean).map((line) => redactCommit(line).texto);
    }
  }

  // Los nuevos sin seguimiento nunca aparecen en numstat. Para el resto se
  // calcula el diff solo cuando cabe y se conserva la lista aun si falla.
  const tracked = [...files.values()].filter((entry) => !entry.nuevo).length;
  if (tracked && hasTime(budget, NUMSTAT_BASE_MS + tracked * NUMSTAT_PER_FILE_MS + AFTER_NUMSTAT_MS)) {
    const args = unborn ? ['diff', '--cached'] : ['diff', head ?? 'HEAD'];
    const stats = git(cwd, [...args, '--numstat', '-z', '--'], { budget, raw: true });
    if (stats !== null) applyNumstat(stats, files);
    else facts.trimmed.push('detalle de líneas +/-: no respondió git diff --numstat');
  } else if (tracked) {
    facts.trimmed.push('detalle de líneas +/-: no quedaba presupuesto para git diff --numstat');
  }

  facts.dirtyTotal = files.size;
  facts.dirty = [...files.values()].slice(0, MAX_DIRTY);
  facts.upstream = upstreamDivergence(cwd, files, headers, head, budget, facts.trimmed);
  return facts;
}

function pathAfterFields(record, count) {
  let offset = 0;
  for (let i = 0; i < count; i++) {
    offset = record.indexOf(' ', offset);
    if (offset === -1) return null;
    offset++;
  }
  return record.slice(offset);
}

function applyNumstat(stdout, files) {
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first === -1 || second === -1) continue;
    // Un campo de ruta vacío introduce el origen y el destino del renombre.
    let path = record.slice(second + 1);
    if (!path) {
      i += 2;
      path = records[i];
    }
    const entry = files.get(path);
    if (!entry) continue;
    entry.mas = numberOrNull(record.slice(0, first));
    entry.menos = numberOrNull(record.slice(first + 1, second));
  }
}

function upstreamDivergence(cwd, files, headers, head, budget, trimmed) {
  if (!headers) {
    trimmed.push('divergencia con upstream: no se pudo confirmar con git status');
    return null;
  }
  const ref = headers.get('branch.upstream');
  const counts = /^\+\d+ -(\d+)$/.exec(headers.get('branch.ab') ?? '');
  // Puede conocerse el nombre sin disponer del commit remoto.
  if (!ref || !counts) return null;

  const ahead = Number(counts[1]);
  const collisions = [];
  if (!ahead || !files.size) return { ref, ahead, collisions };
  const changed = hasTime(budget, 150)
    ? git(cwd, ['diff', '--name-only', '-z', (head ?? 'HEAD') + '..' + ref, '--'], { budget, raw: true }) : null;
  if (changed === null) {
    trimmed.push('archivos en común con upstream: no se pudieron comprobar');
    return { ref, ahead, collisions };
  }
  const paths = new Set(changed.split('\0'));
  for (const path of files.keys()) {
    if (paths.has(path)) collisions.push(path);
    if (collisions.length >= MAX_DIRTY) break;
  }
  return { ref, ahead, collisions };
}

function numberOrNull(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}
