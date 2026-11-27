// Relevos de otros árboles de trabajo del mismo repositorio.
//
// `.tambo/` vive en el árbol principal aunque la sesión corra en un worktree
// enlazado (stateRoot en paths.mjs). Eso no basta para que el siguiente agente
// lo vea: un worktree de Codex suele estar en detached HEAD (carpeta
// `HEAD-<worktree>`) o en una rama propia, y el relevo inyectado es el de la
// rama actual. Aquí se arma un puntero —no el contenido— a los relevos
// recientes escritos desde otro árbol. Sin subprocesos: corre en SessionStart.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, readOnlyTambo, projectDir } from './paths.mjs';
import { canonicalAgent } from './payload.mjs';
import { ageText, MODEL_TEXT_TTL_MS } from './time.mjs';

const MAX_ITEMS = 3;

const sameTree = (a, b) => {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '');
  // Windows y macOS no distinguen mayúsculas en rutas; un falso «otro árbol»
  // por una C: contra c: mostraría el relevo propio como ajeno.
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
};

/**
 * Líneas de aviso con los relevos de las últimas 72 h escritos desde otro
 * árbol de trabajo, o null. `ownDir` es la carpeta del relevo que ya se
 * inyecta, para no señalarla dos veces. Los estados anteriores a este campo
 * no traen `worktree` y se ignoran: no se sabe de qué árbol son.
 */
export function otherWorktreeRelays(cwd, ownDir = null, ahora = Date.now()) {
  try {
    const here = projectDir(cwd);
    const base = join(readOnlyTambo(cwd), 'branches');
    const found = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      if (ownDir && sameTree(dir, ownDir)) continue;
      const path = join(dir, 'estado.json');
      // El mtime filtra antes de parsear: un repo viejo puede tener decenas
      // de ramas, y este hook está en el camino crítico.
      let mtime;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      if (ahora - mtime > MODEL_TEXT_TTL_MS) continue;
      const estado = readJson(path, null);
      const tree = typeof estado?.worktree === 'string' ? estado.worktree : null;
      const at = Date.parse(estado?.writtenAt ?? '');
      if (!tree || sameTree(tree, here) || !Number.isFinite(at) || at > ahora || ahora - at > MODEL_TEXT_TTL_MS) continue;
      found.push({ at, estado, dir });
    }
    if (!found.length) return null;
    found.sort((a, b) => b.at - a.at);
    const lineas = ['Relevos recientes de otros worktrees de este repositorio (léelos si continúas ese trabajo):'];
    for (const { at, estado, dir } of found.slice(0, MAX_ITEMS)) {
      const branch = String(estado.facts?.branch ?? 'sin-rama').replace(/[`\r\n]/g, '');
      const rama = branch === 'HEAD' ? 'detached HEAD' : `rama \`${branch}\``;
      const quien = estado.agent ? String(canonicalAgent(estado.agent)).replace(/[^\w .-]/g, '') : 'otro agente';
      const narrativa = estado.narrative ? ', con narrativa' : '';
      lineas.push(`- ${quien}, ${rama}, hace ${ageText(at, ahora)}${narrativa}: \`${join(dir, 'relevo.md')}\``);
    }
    if (found.length > MAX_ITEMS) lineas.push(`- y ${found.length - MAX_ITEMS} más en \`${base}\``);
    return lineas.join('\n');
  } catch {
    return null;
  }
}
