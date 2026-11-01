#!/usr/bin/env node
// Hook de inyección. Lo ejecutan los tres CLIs al arrancar una sesión.
//
// Lo que este script imprime por stdout entra al contexto del agent, así que
// es la única parte de chaski que está en el camino crítico. Reglas:
//   - Presupuesto duro de tamaño: por encima de 10.000 caracteres el CLI
//     reemplaza el contenido por una ruta y el relevo no llega.
//   - Si no hay relevo, no imprime nada. Un agent no debe recibir ruido.
//   - Si la signature no valida, imprime igual pero rotulado: fallar en silencio
//     dejaría al usuario creyendo que funciona.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { relayPath, statePath, readJson, currentBranch, git } from './lib/paths.mjs';
import { preamble, CLOSING_MARK, isValidSignature, render, MAX_CHARS } from './lib/relay.mjs';

main();

function main() {
  try {
    const cwd = cwdFromPayload();
    const ruta = relayPath(cwd);
    if (!existsSync(ruta)) return;

    let md = readFileSync(ruta, 'utf8');
    if (!md.trim()) return;

    const estado = readJson(statePath(cwd), {}) ?? {};
    let verificado = estado.signature ? isValidSignature(md, estado.signature) : false;

    // El Markdown se renderiza al capturar, así que una narrative escrita
    // después —con /relevo— no aparece hasta la captura siguiente. Si la
    // sesión se corta justo ahí, se perdería lo más valioso del relevo. Si el
    // estado trae una narrative que el Markdown no tiene, se re-renderiza.
    if (estado.narrative && !md.includes(estado.narrative.trim().slice(0, 60))) {
      md = render(estado);
      verificado = true; // reconstruido desde el estado, no desde el archivo
    }

    const partes = [preamble(estado, verificado), '', md];

    // Si el repo se movió desde que se escribió el relevo, hay que decirlo:
    // un relevo desactualizado presentado como verdad es peor que nada.
    const deriva = detectDrift(cwd, estado);
    if (deriva) partes.push('', deriva);

    partes.push('', CLOSING_MARK);

    let salida = partes.join('\n');
    if (salida.length > MAX_CHARS + 1200) {
      salida = salida.slice(0, MAX_CHARS + 1000) + '\n\n_[Recortado.]_\n' + CLOSING_MARK;
    }
    process.stdout.write(emitir(salida, process.argv[3]));
  } catch (e) {
    process.stderr.write(`chaski: no se pudo inyectar el relevo (${e?.message ?? e})\n`);
  } finally {
    process.exitCode = 0;
  }
}

function cwdFromPayload() {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, 'utf8')) || {}; } catch {}
  // Antigravity usa camelCase y manda un array de rutas de workspace en vez
  // de un cwd. Documentado en su contrato de hooks.
  const ws = Array.isArray(ev.workspacePaths) ? ev.workspacePaths[0] : null;
  return ev.cwd ?? ws ?? ev.workspace ?? ev.project_dir ?? process.cwd();
}

/**
 * Cada CLI espera un formato de salida distinto en el hook de inicio:
 *
 *   - Claude Code y Codex: texto plano, que se agrega al contexto.
 *   - Antigravity: un objeto JSON con `injectSteps`. Si se le manda texto
 *     plano no inyecta nada — falla en silencio, que es el peor caso.
 */
function emitir(texto, agent) {
  if (/^agy$/i.test(agent ?? '')) {
    return JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: texto } }],
    }) + '\n';
  }
  return texto + '\n';
}

/** ¿Cambió el repo desde que se escribió el relevo? */
function detectDrift(cwd, estado) {
  const avisos = [];

  const ramaActual = currentBranch(cwd);
  if (estado.facts?.branch && ramaActual && estado.facts.branch !== ramaActual) {
    avisos.push(`- El relevo se escribió en \`${estado.facts.branch}\` y ahora estás en \`${ramaActual}\`.`);
  }

  const edadHoras = estado.writtenAt ? (Date.now() - new Date(estado.writtenAt).getTime()) / 3600000 : 0;
  if (edadHoras > 24) {
    avisos.push(`- Tiene ${Math.round(edadHoras / 24)} día(s) de antigüedad.`);
  }

  avisos.push(...changesSinceRelay(cwd, estado));

  if (!avisos.length) return null;
  return [
    '**ATENCIÓN: el repositorio cambió desde este relevo.**',
    ...avisos,
    '',
    'Verifica contra el código antes de actuar sobre lo que dice este relevo.',
  ].join('\n');
}

/**
 * Qué pasó en el repositorio desde que se escribió el relevo.
 *
 * El caso que motiva esto: alguien se va una semana, su compañero sigue
 * trabajando y hasta termina lo que había quedado a medias. El relevo sigue
 * afirmando que falta, y el agent nuevo podría rehacerlo. Avisar "el
 * repositorio cambió" no alcanza: hay que decir QUÉ cambió, QUIÉN lo hizo y,
 * sobre todo, si toca los archivos que la narrative declara pendientes.
 */
function changesSinceRelay(cwd, estado) {
  const avisos = [];
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (!estado.head || !head || estado.head === head) return avisos;

  // Si el commit del relevo ya no existe, la historia se reescribió
  // (rebase, squash, fuerza). Nada de lo que sigue es comparable.
  const existe = git(cwd, ['cat-file', '-e', `${estado.head}^{commit}`]) !== null;
  if (!existe) {
    avisos.push(`- El commit del relevo (\`${estado.head}\`) ya no existe: la historia se reescribió.`);
    avisos.push('  Trata todo este relevo como una hipótesis y verifica cada punto.');
    return avisos;
  }

  const rango = `${estado.head}..HEAD`;
  const log = git(cwd, ['log', rango, '--format=%h|%an|%s']) ?? '';
  const commits = log.split('\n').filter(Boolean).map((l) => {
    const [h, autor, ...resto] = l.split('|');
    return { h, autor, asunto: resto.join('|') };
  });

  if (commits.length) {
    const autores = [...new Set(commits.map((c) => c.autor))];
    avisos.push(`- ${commits.length} commit(s) nuevo(s) desde entonces, de: ${autores.join(', ')}.`);
    for (const c of commits.slice(0, 6)) {
      avisos.push(`    \`${c.h}\` ${c.autor}: ${c.asunto.slice(0, 70)}`);
    }
    if (commits.length > 6) avisos.push(`    … y ${commits.length - 6} más`);
  }

  // Lo importante: ¿alguien tocó lo que la narrative dice que está pendiente?
  const tocados = new Set((git(cwd, ['diff', '--name-only', rango]) ?? '')
    .split('\n').filter(Boolean));
  const mencionados = mentionedPaths(estado.narrative);
  const collisions = mencionados.filter((r) =>
    [...tocados].some((t) => t === r || t.endsWith('/' + r) || r.endsWith('/' + t)));

  if (collisions.length) {
    avisos.push('');
    avisos.push('- **Archivos que este relevo menciona y que ya cambiaron desde entonces:**');
    for (const r of collisions.slice(0, 8)) avisos.push(`    \`${r}\``);
    avisos.push('  Es posible que lo que el relevo declara pendiente ya esté resuelto.');
    avisos.push('  Léelos antes de retomar: no rehagas trabajo ya hecho.');
  }

  return avisos;
}

/**
 * Archivos que la narrative menciona.
 *
 * Reconoce `src/auth/refresh.ts`, `src/auth/refresh.ts:41` y también
 * `refresh.ts` a secas, porque una narrative escrita a mano no siempre pone
 * la ruta completa. Los falsos positivos no importan: el resultado se cruza
 * contra los archivos que git dice que cambiaron, así que una palabra con
 * punto que no sea un archivo no sobrevive al cruce.
 */
function mentionedPaths(narrative) {
  if (!narrative) return [];
  const re = /\b((?:[\w.@-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8})(?::\d+)?\b/g;
  return [...new Set([...String(narrative).matchAll(re)].map((m) => m[1]))].slice(0, 30);
}
