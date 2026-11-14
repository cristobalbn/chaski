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
import { relayPath, statePath, readJson, currentBranch, git, projectDir } from './lib/paths.mjs';
import { preamble, CLOSING_MARK, isValidSignature, render, MAX_CHARS, neutralizeMarks, onlyNarrativeChanged } from './lib/relay.mjs';
import { createBudget, SESSION_START_BUDGET_MS } from './lib/budget.mjs';

main();

function main() {
  // Mismo mecanismo que capture.mjs (ver lib/budget.mjs), aplicado aquí
  // porque este es el único código de chaski en el camino crítico: lo que
  // imprime entra al contexto antes de que el usuario pueda escribir. Las
  // llamadas a git de detectDrift están medidas como baratas incluso en
  // casos extremos (ver auditoría), pero el presupuesto de 4.000 ms por
  // llamada tampoco se justificaba aquí solo, por la misma razón que en
  // capture.mjs: ningún timeout por llamada protege si nadie lo deriva de
  // cuánto queda.
  const budget = createBudget(SESSION_START_BUDGET_MS);
  try {
    const cwd = projectDir(cwdFromPayload());
    const ramaActual = currentBranch(cwd, budget);
    const ruta = relayPath(cwd, ramaActual);
    if (!existsSync(ruta)) return;

    let md = readFileSync(ruta, 'utf8');
    if (!md.trim()) return;

    const estado = readJson(statePath(cwd, ramaActual), {}) ?? {};
    let verificado = estado.signature ? isValidSignature(md, estado.signature) : false;

    // El Markdown se renderiza al capturar, así que una narrative escrita
    // después —con /relevo— no aparece hasta la captura siguiente. Si la
    // sesión se corta justo ahí, se perdería lo más valioso del relevo. Si el
    // estado trae una narrative que el Markdown no tiene, se re-renderiza.
    let narrativeUnsigned = false;
    if (estado.narrative && !md.includes(estado.narrative.trim().slice(0, 60))) {
      const firmado = md;
      const firmaOriginal = verificado;
      md = render(estado);
      // No asumir "verificado" porque viene del mismo estado.json: quien
      // puede escribirlo ya podía inyectar texto editando relevo.md, y ahí
      // el aviso de "no verificado" sí aparece. Si no se recalcula aquí, lo
      // único que se gana es suprimir el rótulo justo cuando dos personas
      // comparten .tambo/ con claves distintas — el caso para el que existe
      // la firma.
      verificado = estado.signature ? isValidSignature(md, estado.signature) : false;
      // Excepción acotada (#49): si lo firmado validaba y todo lo que no es
      // narrativa coincide con el re-render, el único cambio es la narrativa
      // guardada por el canal legítimo. Ahí no corresponde la alarma de
      // manipulación, que le decía al agente que descartara justo eso.
      if (!verificado && firmaOriginal && onlyNarrativeChanged(firmado, estado)) {
        verificado = true;
        narrativeUnsigned = true;
      }
    }

    // Se neutraliza aquí, en la salida, y no al renderizar: así cubre también
    // un relevo.md editado a mano (con firma inválida) y no altera la firma.
    const partes = [preamble(estado, verificado, { narrativeUnsigned }), '', neutralizeMarks(md)];

    // Si el repo se movió desde que se escribió el relevo, hay que decirlo:
    // un relevo desactualizado presentado como verdad es peor que nada.
    // La deriva lleva nombres de rama y mensajes de commit: también se neutraliza.
    const deriva = detectDrift(cwd, estado, budget, ramaActual);
    if (deriva) partes.push('', neutralizeMarks(deriva));

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
function detectDrift(cwd, estado, budget = null, rama = undefined) {
  const avisos = [];

  const ramaActual = rama === undefined ? currentBranch(cwd, budget) : rama;
  if (estado.facts?.branch && ramaActual && estado.facts.branch !== ramaActual) {
    avisos.push(`- El relevo se escribió en \`${estado.facts.branch}\` y ahora estás en \`${ramaActual}\`.`);
  }

  const edadHoras = estado.writtenAt ? (Date.now() - new Date(estado.writtenAt).getTime()) / 3600000 : 0;
  if (edadHoras > 24) {
    avisos.push(`- Tiene ${Math.round(edadHoras / 24)} día(s) de antigüedad.`);
  }

  avisos.push(...changesSinceRelay(cwd, estado, budget));

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
function changesSinceRelay(cwd, estado, budget = null) {
  const avisos = [];
  const head = git(cwd, ['rev-parse', '--short', 'HEAD'], { budget });
  if (!estado.head || !head || estado.head === head) return avisos;
  // `estado.head` va como argumento a git más abajo. Sin validar, un valor
  // como `--output=<archivo>` lo interpreta git como opción de `log`/`diff` y
  // escribe un archivo. Lo escribe capture.mjs, pero estado.json es editable.
  // Hoy `cat-file -e` lo rechaza antes, así que es defensa en profundidad:
  // no depender de que ese paso vaya primero.
  if (!/^[0-9a-f]{4,40}$/i.test(String(estado.head))) return avisos;

  // Si el commit del relevo ya no existe, la historia se reescribió
  // (rebase, squash, fuerza). Nada de lo que sigue es comparable.
  const existe = git(cwd, ['cat-file', '-e', `${estado.head}^{commit}`], { budget }) !== null;
  if (!existe) {
    avisos.push(`- El commit del relevo (\`${estado.head}\`) ya no existe: la historia se reescribió.`);
    avisos.push('  Trata todo este relevo como una hipótesis y verifica cada punto.');
    return avisos;
  }

  const rango = `${estado.head}..HEAD`;
  const log = git(cwd, ['log', rango, '--format=%h|%an|%s'], { budget }) ?? '';
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
  // `--name-only` compara árboles, no contenido: a diferencia de `--numstat`
  // en facts.mjs, no escala con el tamaño del diff. Medido con 10.000
  // archivos cambiados en un commit: ~50 ms.
  const tocados = new Set((git(cwd, ['diff', '--name-only', rango], { budget }) ?? '')
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
