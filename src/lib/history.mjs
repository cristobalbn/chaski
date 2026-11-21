// Historia de narrativas: `.tambo/historia/entries.jsonl`, append-only, una
// línea `{ at, author, branch, head, narrative }` por narrativa nueva, ya
// redactada. La escribe capture.mjs; la leen `chaski why` y el arranque de
// sesión (la narrativa de una rama ya fusionada).
//
// Ninguna función lanza: las llaman los hooks (invariante 4).
import { existsSync, readFileSync, mkdirSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tambo, readOnlyTambo, git } from './paths.mjs';
import { writeAtomic } from './relay.mjs';
import { redact } from './secrets.mjs';
import { canonicalAgent } from './payload.mjs';
import { ageText, DAY_MS } from './time.mjs';

/**
 * Registro append-only de narrativas en `.tambo/historia/entries.jsonl`,
 * consultado por `chaski why`. Cuando la narrativa se reescribe en el relevo,
 * la anterior sigue viva aquí sin ocupar presupuesto de contexto al inyectar.
 */
export function recordHistory(cwd, estado, config) {
  try {
    const dir = join(tambo(cwd), 'historia');
    mkdirSync(dir, { recursive: true });
    const ruta = join(dir, 'entries.jsonl');
    const { texto } = redact(String(estado.narrative ?? '').trim(), config);
    if (!texto) return;
    const previas = existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
    const ultima = lastHistoryEntry(previas);
    const branch = estado.facts?.branch ?? 'sin-rama';
    if (ultima && ultima.branch === branch && ultima.narrative === texto) return;
    const entrada = {
      at: estado.narrativeWrittenAt ?? estado.writtenAt,
      author: canonicalAgent(estado.narrativeAuthor ?? estado.agent),
      branch,
      head: estado.head ?? null,
      narrative: texto,
    };
    const nuevo = (previas ? previas.trimEnd() + '\n' : '') + JSON.stringify(entrada) + '\n';
    writeAtomic(ruta, nuevo);
  } catch {}
}
/**
 * La narrativa más reciente, si es de una rama que ya no existe y es más
 * nueva que la de la rama actual.
 *
 * El caso: se trabaja en `feat/x`, se guarda ahí la narrativa, se hace
 * squash-merge y se borra la rama. De vuelta en `main`, el relevo trae la
 * narrativa vieja de `main`, y la que describe lo último que se hizo quedó en
 * el relevo huérfano de `feat/x` (pasó el 2026-11-20). Con squash no hay
 * ancestro en común que lo delate, así que la señal es la rama borrada.
 *
 * Solo lee `.tambo/historia/` (ya redactada al escribirse) y, si hay una
 * candidata, lanza UN `git rev-parse` para ver si la rama sigue viva. No
 * copia nada al estado de la rama actual: se muestra rotulada y aparte.
 */
export function mergedBranchNarrative(cwd, estado, budget) {
  try {
    const ruta = join(readOnlyTambo(cwd), 'historia', 'entries.jsonl');
    if (!existsSync(ruta)) return null;
    // Las últimas entradas bastan: un archivo append-only puede ser largo.
    const fd = openSync(ruta, 'r');
    let ultima;
    try {
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - 64 * 1024);
      const buf = Buffer.alloc(size - from);
      const bytes = readSync(fd, buf, 0, buf.length, from);
      ultima = lastHistoryEntry(buf.toString('utf8', 0, bytes));
    } finally { closeSync(fd); }
    if (!ultima) return null;
    const rama = String(ultima.branch);
    // `HEAD` es lo que git informa en detached HEAD: no es una rama que exista
    // ni que pueda haberse fusionado.
    if (rama === estado.facts?.branch || rama === 'sin-rama' || rama === 'HEAD') return null;
    const at = Date.parse(ultima.at);
    const propia = Date.parse(estado.narrativeWrittenAt ?? '') || 0;
    if (!Number.isFinite(at) || at <= propia || Date.now() - at > 14 * DAY_MS) return null;
    // El nombre va como argumento a git: nada que pueda leerse como opción.
    if (!/^[\w./-]+$/.test(rama) || rama.startsWith('-')) return null;
    // `for-each-ref` y no `rev-parse --verify`: este último sale con error
    // tanto si la rama no existe como si git falló o se acabó el presupuesto,
    // y git() devuelve null en los dos casos. Con for-each-ref, «no existe»
    // es salida vacía (''), y null queda solo para «no se pudo saber», donde
    // no se afirma nada.
    const viva = git(cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/${rama}`], { budget });
    if (viva !== '') return null;
    const cuerpo = String(ultima.narrative).trim();
    const corto = cuerpo.length > 900 ? cuerpo.slice(0, 900).trimEnd() + '…' : cuerpo;
    const hace = ageText(at);
    return [
      `## Narrativa más reciente: de la rama \`${rama}\` (ya no existe; probablemente se fusionó)`,
      '',
      `_Escrita por ${String(ultima.author ?? 'un agente').replace(/[^\w .-]/g, '')} hace ${hace}, después de la de esta rama. Contrástala con el código: describe el trabajo de esa rama._`,
      '',
      corto,
    ].join('\n');
  } catch {
    return null;
  }
}

function lastHistoryEntry(text) {
  // Busca desde el final. Archivar una entrada no necesita separar todo el historial.
  for (let end = text.length; end > 0;) {
    const previous = text.lastIndexOf('\n', end - 1);
    const line = text.slice(previous + 1, end);
    end = previous;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.narrative && entry?.branch && entry?.at) return entry;
    } catch {}
  }
  return null;
}
