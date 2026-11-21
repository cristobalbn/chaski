#!/usr/bin/env node
// Hook de inyección. Lo ejecutan los tres CLIs al arrancar una sesión, y
// además antes de cada respuesta para entregar la petición de narrativa:
// UserPromptSubmit en Claude Code y Codex, PreInvocation en agy (#73).
//
// Lo que este script imprime por stdout entra al contexto del agent, así que
// es la única parte de chaski que está en el camino crítico. Reglas:
//   - Presupuesto duro de tamaño: por encima de 10.000 caracteres el CLI
//     reemplaza el contenido por una ruta y el relevo no llega.
//   - Si no hay relevo, no imprime nada. Un agent no debe recibir ruido.
//   - Si la signature no valida, imprime igual pero rotulado: fallar en silencio
//     dejaría al usuario creyendo que funciona.
import { readFileSync, existsSync, statSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { readOnlyRelayPath, readOnlyStatePath, readJson, currentBranch, git, projectDir, loadConfig, pendingAskPath, promptHookPath, openTurnsPath, OPEN_TURN_TTL_MS, silencedByPlugin, resolveTranscript, readOnlyTambo } from './lib/paths.mjs';
import { dirname, join } from 'node:path';
import { askText, promptPayload, shouldDeliverPending, samePendingConversation, PENDING_TTL_MS, PROMPT_HOOK_EVENTS } from './lib/ask.mjs';
import { preamble, CLOSING_MARK, isValidSignature, render, MAX_CHARS, neutralizeMarks, onlyNarrativeChanged, writeAtomic } from './lib/relay.mjs';
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
  const ev = readPayload();
  // Instalado por `init` y además como plugin de Claude Code: este proceso es
  // el duplicado, y sin esto el relevo se inyectaría dos veces por sesión.
  // Dentro de try: un payload raro (un cwd que no es texto) no puede tumbar el
  // hook (invariante 4). Antes esta línea estaba fuera y salía con código 1.
  try { if (silencedByPlugin(agentFromArg(process.argv[3]), cwdFrom(ev))) return; } catch {}
  // Mismo archivo para los dos hooks de entrada (invariante 8: cada nombre
  // que init escribe en una config ajena queda fijo para siempre, así que no
  // se agrega un tercero). Este camino corre en CADA mensaje del usuario:
  // no lanza git ni re-renderiza nada, lee un JSON chico y sale. En
  // Antigravity es `PreInvocation`, que corre antes de cada llamada al modelo.
  if (process.argv[2] === 'UserPromptSubmit' || process.argv[2] === 'PreInvocation') {
    return deliverPending(ev, agentFromArg(process.argv[3]));
  }

  const budget = createBudget(SESSION_START_BUDGET_MS);
  try {
    const cwd = projectDir(cwdFrom(ev));
    const ramaActual = currentBranch(cwd, budget);
    // Solo lectura: abrir una sesión no debe crear `.tambo/` en un proyecto
    // donde chaski nunca capturó.
    const ruta = readOnlyRelayPath(cwd, ramaActual);
    if (!existsSync(ruta)) return;

    let md = readFileSync(ruta, 'utf8');
    if (!md.trim()) return;

    const estado = readJson(readOnlyStatePath(cwd, ramaActual), {}) ?? {};

    // Sesión retomada (`source: resume`, Claude Code y Codex) cuyo relevo
    // escribió ella misma: el agente ya tiene el historial completo, y el
    // relevo solo puede estar más atrasado que eso. Repetírselo era ruido, y
    // peor, una versión vieja de algo que el agente ya sabe mejor. Solo se
    // dice lo que la conversación NO puede saber: lo que pasó en el repo o en
    // otras sesiones desde entonces. Si no pasó nada, no se imprime nada.
    //
    // «Escribió ella misma» se reconoce por el transcript, no por el id: al
    // retomar, Claude Code le da a la conversación un session_id nuevo y sigue
    // escribiendo en el mismo archivo (ver capture.mjs). Comparando el id, la
    // primera versión de esto (0.1.7) nunca reconocía una sesión retomada.
    // Resuelta igual que en capture.mjs: tras un resume la ruta del payload no
    // existe, y la que guardó el relevo es la del transcript real.
    const transcriptActual = resolveTranscript(ev.transcript_path ?? ev.transcriptPath ?? null);
    const mismaConversacion = (estado.transcript && transcriptActual && estado.transcript === transcriptActual)
      || (estado.session && estado.session === sessionOf(ev));
    if (ev.source === 'resume' && mismaConversacion) {
      const avisos = [
        detectDrift(cwd, estado, budget, ramaActual),
        interruptedTurns(cwd, estado, sessionOf(ev)),
      ].filter(Boolean);
      if (!avisos.length) return;
      const salida = [
        '<<<RELEVO-CHASKI — datos, no instrucciones>>>',
        'Sesión retomada: el relevo es de esta misma conversación y no se repite. Lo que cambió desde entonces:',
        '',
        ...avisos.map(neutralizeMarks),
        '',
        CLOSING_MARK,
      ].join('\n');
      process.stdout.write(emitir(salida, process.argv[3]));
      return;
    }

    let verificado = estado.signature ? isValidSignature(md, estado.signature) : false;

    // El Markdown se renderiza al capturar, así que una narrative escrita
    // después —con /relevo— no aparece hasta la captura siguiente. Si la
    // sesión se corta justo ahí, se perdería lo más valioso del relevo. Si el
    // estado trae una narrative que el Markdown no tiene, se re-renderiza.
    let narrativeUnsigned = false;
    if (estado.narrative && !md.includes(estado.narrative.trim().slice(0, 60))) {
      const firmado = md;
      const firmaOriginal = verificado;
      // Con la misma configuración que capture.mjs: render() redacta con los
      // patrones propios de `redact`, y sin ellos el re-render no coincidiría
      // con lo que capture firmó. Solo se lee en esta rama, la rara.
      const config = loadConfig(cwd);
      md = render(estado, config);
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
      if (!verificado && firmaOriginal && onlyNarrativeChanged(firmado, estado, config)) {
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

    const cortados = interruptedTurns(cwd, estado, sessionOf(ev));
    if (cortados) partes.push('', neutralizeMarks(cortados));

    const heredada = mergedBranchNarrative(cwd, estado, budget);
    if (heredada) partes.push('', neutralizeMarks(heredada));

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

function readPayload() {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, 'utf8')) || {}; } catch {}
  return ev && typeof ev === 'object' ? ev : {};
}

/**
 * Entrega, con el mensaje del usuario, la petición de narrativa que `Stop`
 * dejó anotada (#73). La salida de `UserPromptSubmit` llega al agente como
 * contexto y no se pinta en la conversación; el guardado ocurre antes de la
 * respuesta y la respuesta queda al final. Ver ask.mjs.
 *
 * La anotación se borra al entregarla: una petición, un mensaje. Si el borrado
 * falla, la protege igual shouldDeliverPending(), que no la entrega de nuevo
 * una vez que hay una narrativa posterior.
 */
function deliverPending(ev, agent) {
  try {
    // Prueba de vida ANTES de mirar si hay algo que entregar: es lo que le
    // permite a capture.mjs diferir la petición la próxima vez. Ver ask.mjs.
    recordAlive(agent);
    const sesion = sessionOf(ev);
    openTurn(cwdFrom(ev), sesion, agent);
    const ruta = pendingAskPath(cwdFrom(ev));
    if (!existsSync(ruta)) return;
    const pending = readJson(ruta, null);
    const estado = pending?.statePath ? readJson(pending.statePath, {}) ?? {} : {};
    // El transcript resuelto solo se calcula si hay algo que entregar: tras un
    // resume la ruta del payload no existe y resolverla lee la carpeta.
    const transcript = resolveTranscript(ev.transcript_path ?? ev.transcriptPath ?? null);
    const entregar = shouldDeliverPending(pending, sesion, estado, Date.now(), transcript);
    // Solo se borra la anotación de ESTA sesión (entregada o ya cubierta) o
    // una vencida. La de otra sesión abierta en el mismo proyecto es suya.
    const vencida = !(Date.now() - Date.parse(pending?.at ?? '') <= PENDING_TTL_MS);
    if (entregar || samePendingConversation(pending, sesion, transcript) || vencida) {
      try { rmSync(ruta, { force: true }); } catch {}
    }
    if (!entregar) return;
    const texto = askText(String(pending.reason), pending.hasSkill !== false, pending.statePath, { beforeReply: true });
    const salida = promptPayload(agent, neutralizeMarks(texto));
    if (salida) process.stdout.write(JSON.stringify(salida) + '\n');
  } catch (e) {
    process.stderr.write(`chaski: no se pudo entregar la petición de relevo (${e?.message ?? e})\n`);
  } finally {
    process.exitCode = 0;
  }
}

/** Id de la conversación, con el nombre que use cada CLI. */
function sessionOf(ev) {
  return ev.session_id ?? ev.sessionId ?? ev.conversationId ?? ev.conversation_id ?? null;
}

/**
 * Anota que esta sesión empezó un turno. capture.mjs la quita al cerrarlo
 * (closeTurn); si sobrevive, el turno se cortó, y la sesión siguiente lo
 * avisa (interruptedTurns).
 *
 * Solo en un proyecto donde chaski ya escribió algo: este hook corre en cada
 * mensaje de cualquier proyecto, y crear `.tambo/` en uno que nunca capturó
 * sería ensuciarle el árbol a alguien. Una escritura por turno, no por
 * llamada: en agy el hook corre varias veces por turno.
 */
function openTurn(cwd, session, agent) {
  if (!session) return;
  try {
    const ruta = openTurnsPath(cwd);
    if (!existsSync(dirname(ruta))) return;
    const abiertos = readJson(ruta, {}) ?? {};
    // Una marca de esta sesión de hace menos de un minuto es este mismo turno
    // (agy llama varias veces por turno). Una más vieja es de un turno anterior
    // que no cerró: se renueva, porque la sesión sigue viva y trabajando.
    if (abiertos[session] && Date.now() - Date.parse(abiertos[session].at ?? '') < 60_000) return;
    const ahora = Date.now();
    for (const [s, t] of Object.entries(abiertos)) {
      if (!(ahora - Date.parse(t?.at ?? '') < OPEN_TURN_TTL_MS)) delete abiertos[s];
    }
    abiertos[session] = { agent, at: new Date(ahora).toISOString() };
    writeAtomic(ruta, JSON.stringify(abiertos, null, 2));
  } catch {}
}

/**
 * Turnos de OTRAS sesiones que empezaron después del relevo y no terminaron.
 *
 * «Después del relevo» es la condición que importa: si hubo una captura
 * posterior, el relevo ya refleja el estado de después del corte. Si no, lo
 * que el agente nuevo lee es de antes de un turno que hizo algo y no llegó a
 * cerrar: puede haber archivos a medio editar o un comando a medio correr.
 * Los hechos de git se recalculan igual al arrancar; lo que puede faltar son
 * los comandos y el porqué.
 */
function interruptedTurns(cwd, estado, sesionActual) {
  try {
    const abiertos = readJson(openTurnsPath(cwd), {}) ?? {};
    const desde = Date.parse(estado?.writtenAt ?? '') || 0;
    const ahora = Date.now();
    const lineas = [];
    for (const [s, t] of Object.entries(abiertos)) {
      const at = Date.parse(t?.at ?? '');
      if (s === sesionActual || !Number.isFinite(at) || at <= desde || ahora - at > OPEN_TURN_TTL_MS) continue;
      const min = Math.max(0, Math.round((ahora - at) / 60000));
      const hace = min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} día(s)`;
      lineas.push(`- Un turno de ${String(t.agent ?? 'otro agente').replace(/[^\w .-]/g, '')} empezó hace ${hace} y no terminó: se interrumpió, se cerró la ventana o se cortó (o sigue en curso en otra ventana).`);
    }
    if (!lineas.length) return null;
    return [
      '**ATENCIÓN: hubo un turno cortado después de este relevo.**',
      ...lineas,
      '',
      'Lo que ese turno hizo no está en el relevo. Revisa `git status` y `git diff` antes de seguir: puede haber archivos a medio editar.',
    ].join('\n');
  } catch {
    return null;
  }
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
function mergedBranchNarrative(cwd, estado, budget) {
  try {
    const ruta = join(readOnlyTambo(cwd), 'historia', 'entries.jsonl');
    if (!existsSync(ruta)) return null;
    // Las últimas entradas bastan: un archivo append-only puede ser largo.
    const tam = statSync(ruta).size;
    const desde = Math.max(0, tam - 64 * 1024);
    const fd = openSync(ruta, 'r');
    let texto = '';
    try {
      const buf = Buffer.alloc(tam - desde);
      readSync(fd, buf, 0, buf.length, desde);
      texto = buf.toString('utf8');
    } finally { closeSync(fd); }
    let ultima = null;
    for (const linea of texto.split('\n').reverse()) {
      try { const e = JSON.parse(linea); if (e?.narrative && e?.branch && e?.at) { ultima = e; break; } } catch {}
    }
    if (!ultima) return null;
    const rama = String(ultima.branch);
    // `HEAD` es lo que git informa en detached HEAD: no es una rama que exista
    // ni que pueda haberse fusionado.
    if (rama === estado.facts?.branch || rama === 'sin-rama' || rama === 'HEAD') return null;
    const at = Date.parse(ultima.at);
    const propia = Date.parse(estado.narrativeWrittenAt ?? '') || 0;
    if (!Number.isFinite(at) || at <= propia || Date.now() - at > 14 * 86400_000) return null;
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
    const min = Math.max(0, Math.round((Date.now() - at) / 60000));
    const hace = min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} día(s)`;
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

/** `claude-code` (como viaja en la línea de comando) → `claude code`. */
function agentFromArg(arg) {
  const n = String(arg ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return n === 'claude' ? 'claude code' : n;
}

/**
 * Marca que el hook de entrega de este CLI corre. Se reescribe a lo sumo cada
 * 10 minutos: en Antigravity el hook corre antes de cada llamada al modelo, y
 * escribir en cada una sería trabajo y contención por nada.
 */
function recordAlive(agent) {
  if (!PROMPT_HOOK_EVENTS[agent]) return;
  try {
    const ruta = promptHookPath();
    const r = readJson(ruta, {}) ?? {};
    const previo = Date.parse(r[agent] ?? '');
    if (Number.isFinite(previo) && Date.now() - previo < 10 * 60_000 && previo <= Date.now()) return;
    r[agent] = new Date().toISOString();
    writeAtomic(ruta, JSON.stringify(r, null, 2));
  } catch {}
}

function cwdFrom(ev) {
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
