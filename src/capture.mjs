#!/usr/bin/env node
// Hook de captura. Lo ejecutan Claude Code, Codex y agy al terminar cada turno.
//
// Reglas que gobiernan este archivo:
//   - Nunca falla. Cualquier error sale por exit 0 con un aviso a stderr: un
//     hook que revienta le arruina la sesión al usuario.
//   - Nunca llama a un modelo. Cero tokens, cero red, cero términos de uso.
//   - Nunca tarda. El presupuesto del hook Stop de Claude Code es de 1,5 s
//     COMPARTIDO con los demás hooks del evento. El caso normal mide ~220 ms
//     de mediana (ver Presupuestos en AGENTS.md); con miles de archivos modificados a la vez, el reloj de
//     lib/budget.mjs corta trabajo caro antes de llegar ahí (ver gitFacts en
//     lib/facts.mjs) en vez de dejar que el hook se cancele y se pierda el
//     relevo entero.
//   - Nunca escribe fuera de .tambo/ del proyecto y ~/.chaski/.
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { branchDir, readJson, readOnlyTambo, readOnlyBranchDir, legacyBranchState, acquireLock, globalDir, git, currentBranch, existsSync, projectDir, loadConfig, promptHookPath, silencedByPlugin, usagePath } from './lib/paths.mjs';
import { notePendingAsk, markPendingSessionEnded } from './lib/pending.mjs';
import { closeTurn } from './lib/turns.mjs';
import { recordHistory } from './lib/history.mjs';
import { pruneOnSchedule } from './lib/maintenance.mjs';
import { recordCaptureActivity } from './lib/activity.mjs';
import { withFileLock } from './lib/lock.mjs';
import { gitFacts, readGitSnapshot } from './lib/facts.mjs';
import { transcriptFacts } from './lib/transcript.mjs';
import { writeAtomic } from './lib/atomic.mjs';
import { publishRelay } from './lib/relay-store.mjs';
import { redact } from './lib/secrets.mjs';
import { shouldAsk, askText, askPayload, promptHookAlive, COMPACT_HINT, quotaPressure } from './lib/ask.mjs';
import { createBudget, STOP_HOOK_BUDGET_MS } from './lib/budget.mjs';
import { readStdinJson, canonicalAgent, sessionOf, cwdOf, transcriptOf, eventOf } from './lib/payload.mjs';
import { MODEL_TEXT_TTL_MS, isFresh } from './lib/time.mjs';

main();

function main() {
  // Reloj único para todo el hook, desde la primera línea de main(). Es la
  // mitad "presupuesto global" del arreglo: cada paso caro de gitFacts
  // consulta budget.remaining() antes de lanzar un subproceso en vez de
  // intentarlo siempre y confiar en que algún timeout lo salve. Arranca aquí
  // y no antes porque todo lo anterior (imports, parseo de este archivo) ya
  // corrió antes de que exista un reloj que lo cuente — es overhead de Node
  // que no podemos medir desde dentro del script.
  const budget = createBudget(STOP_HOOK_BUDGET_MS);
  let liberar = null;
  try {
    const ev = readPayload();
    const sessionDir = resolve(ev.cwd || process.cwd());
    const cwd = projectDir(sessionDir);

    // Instalado por `init` y además como plugin: este proceso es el duplicado.
    if (silencedByPlugin(ev.__agente, sessionDir)) return ok();

    const config = loadConfig(cwd);

    // Un subagente que termina promueve su conclusión al relevo del padre, y
    // nada más. Tiene camino propio porque la captura normal haría dos daños:
    // leería el transcript DEL SUBAGENTE y dejaría su tamaño como marca de
    // agua del padre —que en su próximo turno leería desde la posición
    // equivocada— y derivaría los facts de git del árbol del hijo, que puede
    // ser otro worktree.
    if (ev.hook_event_name === 'SubagentStop') {
      return promote(ev, cwd, config);
    }

    // Los demás eventos de un subagente se descartan: su exploración
    // contaminaría el relevo con cien lecturas de archivos y tres caminos
    // abandonados que a nadie le sirven mañana.
    if (ev.agent_id) return ok();

    // El turno terminó: se quita su marca de turno abierto. Va antes del lock
    // a propósito: si otro proceso lo tiene, esta captura se saltea, pero el
    // turno igual terminó bien y avisar lo contrario sería mentir. PreCompact
    // no cierra el turno (la compactación automática ocurre a mitad de uno).
    if (ev.hook_event_name !== 'PreCompact') closeTurn(cwd, ev.session_id);

    // Si la sesión que anotó un pedido de narrativa termina, se anota: desde
    // ahí el pedido puede entregarse a la conversación retomada (otro id,
    // mismo transcript). Ver samePendingConversation() en ask.mjs.
    if (ev.hook_event_name === 'SessionEnd') markPendingSessionEnded(cwd, ev.session_id);

    // En Claude Code, lo que PreCompact imprime «becomes instructions for the
    // compaction summary». Se pide que el resumen conserve lo mismo que una
    // narrativa: compactar es perder contexto, igual que cambiar de agente.
    // Va antes del lock: no depende del estado, y una captura salteada no
    // debería dejar sin instrucción a la compactación.
    if (ev.hook_event_name === 'PreCompact' && ev.__agente === 'claude code') {
      process.stdout.write(COMPACT_HINT + '\n');
    }

    // Un solo escritor. Si otro proceso tiene el lock, este turno se saltea:
    // el siguiente lo recupera, porque la marca de agua no avanzó.
    liberar = acquireLock(cwd);
    if (!liberar) return ok();

    const snapshot = readGitSnapshot(cwd, budget);
    const branch = snapshot.branch;
    const dir = branchDir(cwd, branch);
    const rutaEstado = join(dir, 'estado.json');
    const current = readJson(rutaEstado, null);
    const legacy = current || existsSync(rutaEstado) ? null : legacyBranchState(cwd, branch, budget);
    const previo = current ?? (legacy ? readJson(join(legacy.dir, 'estado.json'), null) : null) ?? {};

    // La marca de agua pertenece a UNA sesión y a UN transcript. Si cambia
    // cualquiera de los dos, se lee desde el principio: arrastrar el offset
    // de ayer a un transcript nuevo haría que se saltee todo el trabajo de
    // hoy hasta ese byte. El caso aparece al volver a trabajar al día
    // siguiente, que es justo cuando el relevo importa.
    //
    // Pero «la misma sesión» no es «el mismo session_id»: al retomar
    // (`--resume`, `/resume`), Claude Code le da a la conversación un id nuevo
    // y sigue escribiendo en el MISMO transcript. Comparando solo el id, cada
    // reinicio parecía una sesión nueva: se releía el transcript entero (6 MB
    // en una sesión larga) y los turnos de toda la conversación quedaban
    // contados como posteriores a la narrativa. El transcript compartido es lo
    // que identifica la conversación; el id solo, cuando no hay transcript.
    const mismoTranscript = Boolean(previo.transcript && ev.transcript_path
      && previo.transcript === ev.transcript_path);
    const mismaSesion = mismoTranscript
      || Boolean(previo.session && ev.session_id && previo.session === ev.session_id && !ev.transcript_path);
    const desde = mismoTranscript ? (previo.offset ?? 0) : 0;

    const previousCommands = mismaSesion && Array.isArray(previo.commands) ? previo.commands : [];
    const t = transcriptFacts(ev.transcript_path, desde, config, budget, previousCommands);
    const g = gitFacts(cwd, config, budget, snapshot);
    const headFromLog = g.commits?.[0]?.split(' ')[0] || null;

    const estado = {
      version: 1,
      writtenAt: new Date().toISOString(),
      agent: ev.__agente ?? 'desconocido',
      session: ev.session_id ?? null,
      // La ruta del transcript se guarda para poder invalidar la marca de agua.
      transcript: ev.transcript_path ?? null,
      offset: t.offset,
      // Los turns se acumulan dentro de una sesión; en una nueva se reinician,
      // o el relevo diría "1.200 turns" de trabajo que ya no está en contexto.
      turns: (mismaSesion && !t.reset ? (previo.turns ?? 0) : 0) + t.turns,
      facts: g,
      // El log da el SHA corto. Si se recorta, status ya dio el SHA completo.
      head: g.isRepo ? (headFromLog ?? snapshot.head ?? null) : null,
      // Si algún paso de gitFacts se quedó sin presupuesto, se declara aquí
      // -en un campo de hechos, no de narrative- para que el agent siguiente
      // sepa que el relevo es incompleto por diseño y no por error silencioso.
      trimmed: [...(g.trimmed ?? []), ...(t.trimmed ? ['transcript'] : [])],
      commands: t.commands,
      lastFile: lastTouched(g, previo),
      // La narrative es del agent, no de este script. Se preserva tal cual.
      narrative: previo.narrative ?? null,
      narrativeAuthor: previo.narrativeAuthor ?? null,
      narrativeWrittenAt: previo.narrativeWrittenAt ?? null,
      // Las conclusiones de los subagents se preservan, como la narrative: las
      // escribió un modelo y no se pueden recalcular. Sin esto, `promote()`
      // las guardaba y la captura del final del MISMO turno las borraba, así
      // que la sección "Trabajo delegado" duraba lo que duraba el turno.
      //
      // Se preservan entre sesiones a propósito, no solo dentro de una. Atarlas
      // a la sesión las borraría en la primera captura del CLI siguiente, que
      // es justo el escenario que esta herramienta existe para cubrir: el
      // agent nuevo las lee al arrancar y las perdería para el que venga
      // después. Su antigüedad se muestra en el relevo, que es la forma honesta
      // de que algo viejo se note sin desaparecer.
      //
      // Pero no para siempre. Una conclusión es texto de modelo que puede
      // repetir lo que el subagente leyó (una página, un archivo hostil), y se
      // inyecta en cada arranque de los tres CLIs. Sin vencimiento, un texto
      // así quedaba hasta que lo desplazaran seis conclusiones nuevas, lo que
      // en un repo sin subagentes es nunca. Ver freshSubagents().
      subagents: freshSubagents(previo.subagents),
      // Tareas en segundo plano que quedan corriendo. Si cambias de CLI con
      // algo a medio ejecutar, el agent nuevo tiene que saberlo.
      backgroundTasks: liveTasks(ev),
      redactions: t.redactions,
      event: ev.hook_event_name ?? null,
    };

    // Un corte por cuota se sella y se deja anotado: es el instante del relevo.
    const detalleLimite = `${ev.error_type ?? ''} ${ev.error_message ?? ''} ${ev.error ?? ''} ${ev.terminationReason ?? ''}`;
    if ((ev.hook_event_name === 'StopFailure' && /rate.?limit/i.test(ev.error_type ?? ''))
      || /rate.?limit|quota.?exceeded|MAX_TOKEN_BUDGET_EXCEEDED/i.test(detalleLimite)) {
      estado.sealedAtLimit = {
        at: estado.writtenAt,
        motivo: redact(ev.error_type || ev.terminationReason || 'rate_limit', config).texto,
      };
    }

    // Red de seguridad de la petición diferida (#73): si nadie escribe otro
    // mensaje, la narrativa no llega a pedirse, pero la última respuesta del
    // agente suele decir qué se hizo y qué falta. Se guarda sin intervención
    // de ningún modelo. Es texto de modelo, así que va fuera de los hechos
    // (invariante 2), redactado (invariante 6) y con vencimiento, como las
    // conclusiones de subagentes y por la misma razón: se inyecta en cada
    // arranque y puede repetir algo hostil que el agente leyó.
    // Stop puede llegar antes de que el CLI escriba la respuesta en JSONL.
    const payloadReply = ev.hook_event_name === 'Stop' && typeof ev.last_assistant_message === 'string'
      ? ev.last_assistant_message.trim() : '';
    estado.lastReply = replyFrom(payloadReply || t.lastMessage, config, estado.writtenAt)
      ?? freshReply(previo.lastReply);

    // Cuántos turnos tenía el relevo cuando se escribió la narrativa: es con
    // esto que se mide si quedó atrás, y lo anota el código, no el modelo.
    //
    // Se compara contra `narrativeStamp` —la marca que esta misma función ya
    // contabilizó— y NO contra `previo.narrativeWrittenAt`. La narrativa se
    // escribe fuera de banda, directo en estado.json, así que en la captura
    // siguiente el previo ya trae la marca nueva y los dos valores coinciden:
    // comparándolos, el contador nunca se movía de cero y la política creía
    // que habían pasado todos los turnos de la sesión desde la última
    // narrativa. Resultado: la pedía cada vez que expiraba el debounce, para
    // siempre. Con `turns` en 2.049 y el contador en 0, se veía en cada turno.
    //
    // Va antes de render() porque el relevo decide con él si mostrar
    // `lastReply`: solo cuando hubo trabajo después de la narrativa.
    const narrativaNueva = (estado.narrativeWrittenAt ?? null) !== (previo.narrativeStamp ?? null);
    // `turns` se reinicia en cada sesión nueva; arrastrar `turnsAtNarrative`
    // de la sesión anterior dejaba `turns - turnsAtNarrative` en negativo y
    // postergaba la petición tantos turnos como hubiera durado la sesión previa.
    //
    // Y si la sesión cambió, la base NO es 0 sino los turnos de ahora. Con 0,
    // releer desde el principio el transcript de una sesión larga (retomada,
    // o que alterna con otra en el mismo proyecto) contaba todos sus turnos
    // como posteriores a la narrativa: con `turns` en 1.027 y la narrativa de
    // hacía 3 minutos, el relevo mostraba «Última respuesta del agente» y la
    // petición creía que iban mil turnos. La base de ahora puede atrasar la
    // próxima petición unos turnos; nunca inventa trabajo que no hubo. Sin
    // narrativa todavía, la base sí es 0: todo el trabajo es posterior a ella.
    const previosEnSesion = mismaSesion && !t.reset && (previo.turnsAtNarrative ?? 0) <= (estado.turns ?? 0)
      ? (previo.turnsAtNarrative ?? 0) : (estado.narrative ? (estado.turns ?? 0) : 0);
    estado.turnsAtNarrative = narrativaNueva ? (estado.turns ?? 0) : previosEnSesion;
    estado.narrativeStamp = estado.narrativeWrittenAt ?? null;


    // ¿Toca pedirle la narrativa al agent? Se decide ANTES de escribir, para
    // que el instante de la petición quede en el mismo estado que se guarda:
    // el hook no tiene memoria entre turnos y el debounce vive ahí.
    //
    // La cuota (#82) viene de la statusline de ese CLI (statusline.mjs); sin
    // ella, `cuota` es null y la política queda como antes.
    const cuota = ev.hook_event_name === 'Stop'
      ? quotaPressure((readJson(usagePath(), {}) ?? {})[estado.agent], config) : null;
    const motivo = ev.hook_event_name === 'Stop'
      ? shouldAsk(ev, estado, previo, config, Date.now(), cuota) : null;
    if (motivo) {
      estado.askedAt = estado.writtenAt;
      estado.askedReason = motivo;
    } else {
      estado.askedAt = previo.askedAt ?? null;
      estado.askedReason = previo.askedReason ?? null;
    }
    // Una petición por ventana de cuota: se recuerda en cuál se pidió.
    estado.askedQuotaKey = motivo && cuota && motivo.startsWith('la cuota')
      ? cuota.key : (previo.askedQuotaKey ?? null);
    publishRelay(dir, estado, config, previo);
    recordCaptureActivity(estado.agent);
    recordQuota(ev, estado, config);
    if (narrativaNueva && estado.narrative) recordHistory(cwd, estado, config);
    let diferida = false;

    // La petición va por stdout y solo después de que el relevo esté escrito:
    // si algo de arriba fallara, se pierde la petición y no el relevo.
    //
    // El contrato lo arma `askPayload`, porque NO es el mismo en los tres:
    // Claude Code usa `additionalContext`, Codex usa `decision: "block"` y
    // Antigravity usa `"continue"`; otro valor le da permiso para parar.
    if (motivo) {
      // Resolver el repo hijo no carga su skill en una sesión abierta en la
      // carpeta contenedora. Tampoco sirve la copia instalada para otro CLI:
      // en ambos casos la petición debe incluir cómo escribir la narrativa.
      const relativeSession = relative(cwd, sessionDir);
      const inProject = relativeSession !== '..'
        && !relativeSession.startsWith('..' + sep) && !isAbsolute(relativeSession);
      const skillBase = estado.agent === 'claude code' ? '.claude' : '.agents';
      // Con el plugin, la skill viaja con él y vale en cualquier carpeta.
      const enPlugin = process.env.CLAUDE_PLUGIN_ROOT
        && existsSync(join(process.env.CLAUDE_PLUGIN_ROOT, 'skill', 'SKILL.md'));
      const hasSkill = Boolean(enPlugin) || (inProject
        && existsSync(join(cwd, skillBase, 'skills', 'relevo', 'SKILL.md')));
      if (estado.session && canDefer(estado.agent)) {
        // #73: no se imprime nada. Lo entrega inject.mjs con el mensaje
        // siguiente del usuario, antes de la respuesta. Ver ask.mjs.
        diferida = notePendingAsk(cwd, {
          session: estado.session, transcript: estado.transcript, at: estado.writtenAt, reason: motivo, statePath: rutaEstado, hasSkill,
        }) === true;
      }
      if (!diferida) {
        const salida = askPayload(estado.agent, askText(motivo, hasSkill, rutaEstado));
        if (salida) process.stdout.write(JSON.stringify(salida) + '\n');
      }
    }

    if (motivo || (narrativaNueva && estado.narrative)) recordCost(estado, motivo, narrativaNueva, diferida);
    pruneOnSchedule(cwd, {
      factsOnly: config.pruneAfterDays, withNarrative: config.pruneNarrativeAfterDays,
    }, budget);

    // Aviso para quien mire stderr (doctor, una terminal, logs del CLI). El
    // relevo mismo ya lo dice -- esto es la copia para quien no lo abra.
    if (estado.trimmed.length) {
      process.stderr.write(
        `chaski: relevo recortado por presupuesto de tiempo (${budget.elapsed()} ms) -- `
        + `${estado.trimmed.length} paso(s) omitido(s)\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`chaski: captura omitida (${e?.message ?? e})\n`);
  } finally {
    if (liberar) liberar();
    ok();
  }
}

function ok() { process.exitCode = 0; }

/**
 * Promueve el resultado de un subagente al relevo del padre.
 *
 * Promoción, no concatenación: sube lo que sobrevive —la conclusión que
 * declaró al terminar y por qué paró— y se descarta el proceso. El relevo
 * guarda lo que el equipo de agentes **logró**, no lo que **tanteó**.
 *
 * Beneficio secundario: como es mecánico, diez subagents no multiplican por
 * diez el costo. No hay síntesis aquí; solo el padre sintetiza, una vez, sobre
 * resultados ya condensados.
 *
 * El diseño original proponía un quipu hijo efímero en `.tambo/sub/<id>.json`.
 * Resultó innecesario: el payload de `SubagentStop` ya trae la conclusión, así
 * que un archivo intermedio solo agregaría algo que limpiar.
 */
function promote(ev, cwd, config) {
  let liberar = null;
  try {
    if (!existsSync(join(readOnlyTambo(cwd), 'branches'))) return ok();
    liberar = acquireLock(cwd);
    if (!liberar) return ok();

    const dir = readOnlyBranchDir(cwd, currentBranch(cwd));
    const rutaEstado = join(dir, 'estado.json');
    const estado = readJson(rutaEstado, null);
    // Sin relevo del padre no hay dónde promote. Crear uno desde un subagente
    // dejaría un relevo con la conclusión de un hijo y ningún hecho.
    if (!estado) return ok();

    // Sin identidad del subagente no se promueve nada.
    //
    // Pasó en producción y se vio en el relevo: la sección "Trabajo delegado"
    // quedó con CUATRO MENSAJES DEL USUARIO —"dale, abre el issue", "ya,
    // gracias, ahora vuelvo"— presentados como conclusiones de subagentes y
    // con la etiqueta vacía. Algún CLI dispara este evento con el último
    // mensaje de la conversación, que puede ser el del usuario, donde Claude
    // Code pone el del subagente. Sin `agent_type` no hay forma de saber que
    // hubo un subagente de verdad, así que no se promueve: un relevo que
    // afirma que alguien concluyó algo que nunca pasó es peor que uno sin la
    // sección.
    //
    // La distinción exacta importa: lo que llegaba NO era el campo ausente,
    // era el campo VACÍO. Por eso `??` no lo cubría y la etiqueta se
    // renderizaba como `****`.
    //
    // Ausente se sigue aceptando con un nombre genérico, porque un CLI puede
    // no mandarlo y la promoción es legítima. Presente pero vacío se rechaza:
    // es la huella de quien mandó el mensaje del usuario como si fuera la
    // conclusión de un subagente.
    if ('agent_type' in ev && !String(ev.agent_type ?? '').trim()) return ok();
    const kind = String(ev.agent_type ?? '').trim() || 'subagente';

    const { texto } = redact(String(ev.last_assistant_message ?? '').trim(), config);
    const conclusion = summarizeConclusion(texto);
    if (!conclusion) return ok();

    const entrada = {
      kind,
      conclusion,
      at: new Date().toISOString(),
      // `stop_reason` distinto de end_turn suele significar que no terminó
      // lo que estaba haciendo, y eso es justamente lo que hay que avisar.
      reason: ev.stop_reason && ev.stop_reason !== 'end_turn' ? ev.stop_reason : null,
    };

    const previas = (estado.subagents ?? []).filter((s) => s.conclusion !== conclusion);
    // Presupuesto: el relevo tiene techo de tamaño y los subagents compiten
    // con los facts por ese espacio.
    estado.subagents = [...previas, entrada].slice(-6);
    estado.writtenAt = new Date().toISOString();

    publishRelay(dir, estado, config, estado);
  } catch (e) {
    process.stderr.write(`chaski: promoción omitida (${e?.message ?? e})\n`);
  } finally {
    if (liberar) liberar();
  }
  return ok();
}

/**
 * Las conclusiones que no vencieron. Sin `at` legible se descartan: no hay
 * cómo fecharlas.
 *
 * Vencen a las 72 h: alcanza para un fin de semana entre una sesión y otra,
 * que es el relevo entre CLIs que motivó preservarlas, y acota cuánto tiempo
 * puede repetirse en cada arranque un texto que nadie verificó.
 *
 * El plazo va DENTRO de la función, no como `const` de módulo: `main()` corre
 * en la línea de arriba del archivo, antes de que un `const` declarado aquí
 * abajo se inicialice, y el ReferenceError lo atrapaba el hook en silencio.
 */
function freshSubagents(lista, ahora = Date.now()) {
  if (!Array.isArray(lista)) return null;
  const vivas = lista.filter((s) => isFresh(s?.at, MODEL_TEXT_TTL_MS, ahora));
  return vivas.length ? vivas : null;
}

/**
 * La última respuesta del agente, redactada y acotada, o null.
 *
 * A diferencia de una conclusión de subagente, lo valioso suele estar al
 * FINAL («falta X», «siguiente paso»), así que si no cabe se conservan el
 * principio y el final, no solo el principio.
 */
function replyFrom(texto, config, at) {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const limpio = redact(texto, config).texto
    .replace(/```[\s\S]*?```/g, '[bloque de código]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!limpio) return null;
  const MAX = 700;
  const corto = limpio.length > MAX
    ? `${limpio.slice(0, 280).trimEnd()} […] ${limpio.slice(-400).trimStart()}`
    : limpio;
  return { text: corto, at };
}

function freshReply(r, ahora = Date.now()) {
  // El vencimiento viene de lib/time.mjs (un import, resuelto antes de que
  // main() corra). Como `const` de módulo de este archivo provocaba un error
  // de TDZ: ver el test «los hooks no declaran const ni let de módulo después
  // de llamar a main()».
  return r?.text && isFresh(r.at, MODEL_TEXT_TTL_MS, ahora) ? r : null;
}

/**
 * ¿Puede diferirse la petición al mensaje siguiente? (#73)
 *
 * Solo si el hook de entrega de ESE CLI dio señales de vida hace poco.
 * Mirar la configuración no alcanza (así lo hacía la primera versión, solo
 * para Claude Code): una instalación que actualizó el paquete sin volver a
 * correr `init` no tiene el hook, y en Codex un hook registrado no corre
 * hasta que el usuario lo marca como confiable. Diferir ahí sería anotar
 * peticiones que nadie entrega y quedarse sin narrativa en silencio. Para
 * esos casos sigue la petición en `Stop`, que molesta pero funciona.
 */
function canDefer(agent) {
  try {
    return promptHookAlive(readJson(promptHookPath(), {}), agent);
  } catch {
    return false;
  }
}

/**
 * La conclusión de un subagente, acotada.
 *
 * Se queda con los primeros párrafos útiles: un `last_assistant_message`
 * puede traer el informe completo, y el relevo tiene presupuesto. Lo que
 * importa es qué logró y qué falló, que suele estar al principio.
 */
function summarizeConclusion(texto) {
  if (!texto) return null;
  const limpio = texto
    .replace(/```[\s\S]*?```/g, '[bloque de código]') // el código ya está en el diff
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!limpio) return null;
  return limpio.length > 400 ? limpio.slice(0, 400).trimEnd() + '…' : limpio;
}

/**
 * Lee el payload de stdin y lo deja normalizado sobre el mismo objeto, con los
 * nombres que usa el resto de este archivo. La normalización vive en
 * lib/payload.mjs, compartida con inject.mjs.
 */
function readPayload() {
  const ev = readStdinJson();
  // Resuelto: tras un resume, Claude Code manda la ruta de un archivo que no
  // existe (ver resolveTranscript en paths.mjs).
  ev.transcript_path = transcriptOf(ev);
  ev.hook_event_name = eventOf(ev);
  ev.session_id = sessionOf(ev);
  ev.cwd = cwdOf(ev);
  // agy manda el último prompt del usuario; sirve como pista de la tarea.
  ev.__ultimoPrompt = ev.lastUserInput ?? ev.user_prompt ?? null;
  // Normalizado aquí y no al estampar el latido: `estado.agent` es lo que
  // encabeza el relevo que lee el agent siguiente, y la grafía cambiaba según
  // el evento que lo hubiera escrito.
  ev.__agente = canonicalAgent(process.argv[3] ?? detectAgent(ev));
  return ev;
}

function detectAgent(ev) {
  if (process.env.CLAUDECODE || ev.hook_event_name === 'StopFailure') return 'claude code';
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION) return 'codex';
  if (process.env.AGY_SESSION || process.env.ANTIGRAVITY_SESSION) return 'agy';
  return 'desconocido';
}


function lastTouched(g, previo) {
  // Solo archivos: un directorio sin trackear no es "el último archivo tocado".
  const cand = (g.dirty ?? []).filter((s) => !s.ruta.endsWith('/'));
  if (!cand.length) return previo.lastFile ?? null;
  // Aproximación: el que acumula más cambios. El orden del diff no indica
  // recencia, así que no sirve para esto.
  const conCambios = cand.filter((s) => s.mas !== null);
  if (conCambios.length) {
    return conCambios.sort((a, b) => (b.mas + b.menos) - (a.mas + a.menos))[0].ruta;
  }
  return cand[0].ruta;
}

/**
 * Tareas en segundo plano todavía corriendo, del payload del hook.
 * Confirmado en el payload real de Claude Code: campo `background_tasks`,
 * con id, status y description. Los otros CLIs pueden no enviarlo.
 */
function liveTasks(ev) {
  const tareas = ev.background_tasks ?? ev.backgroundTasks ?? [];
  if (!Array.isArray(tareas)) return [];
  return tareas
    .filter((t) => t && /running|pending|in_progress/i.test(t.status ?? ''))
    .map((t) => ({
      description: String(t.description ?? t.id ?? 'sin descripción').slice(0, 120),
      kind: t.type ?? null,
    }))
    .slice(0, 6);
}

/**
 * Estado de cuota por CLI en `~/.chaski/quota.json`, leído por `chaski next`.
 * Solo escribe cuando ocurre un corte por límite o cuando un CLI que estaba
 * marcado como agotado vuelve a completar un turno normal.
 */
function recordQuota(ev, estado, config) {
  try {
    const ruta = join(globalDir(), 'quota.json');
    const name = canonicalAgent(estado.agent);
    const sealed = estado.sealedAtLimit;
    if (!sealed && (ev.hook_event_name !== 'Stop' || !readJson(ruta, null)?.[name])) return;
    // Dos proyectos pueden informar sobre el mismo CLI al mismo tiempo.
    withFileLock(ruta, () => {
      const quota = readJson(ruta, {}) ?? {};
      const previous = quota[name];
      if (previous?.at > estado.writtenAt || (!sealed && !previous)) return;
      if (sealed) {
        const raw = String(ev.error_message ?? ev.error ?? '').trim();
        const message = redact(raw, config).texto.slice(0, 200) || null;
        quota[name] = { at: estado.writtenAt, reason: sealed.motivo, message };
      } else {
        delete quota[name];
      }
      writeAtomic(ruta, JSON.stringify(quota, null, 2));
    }, 40);
  } catch {}
}

/**
 * Contabilidad local de turnos extra pedidos por chaski y narrativas escritas,
 * en `~/.chaski/cost.json`, para `chaski cost`.
 */
function recordCost(estado, motivo, narrativaNueva, diferida = false) {
  try {
    const ruta = join(globalDir(), 'cost.json');
    withFileLock(ruta, () => {
      const c = readJson(ruta, { asks: [], narratives: [] }) ?? { asks: [], narratives: [] };
      const agent = canonicalAgent(estado.agent);
      const branch = estado.facts?.branch ?? 'sin-rama';
      if (motivo) {
        c.asks = [...(Array.isArray(c.asks) ? c.asks : []), {
          at: estado.writtenAt, agent, branch, reason: motivo,
          // Diferida: se entrega antes de la respuesta siguiente, sin turno extra.
          ...(diferida ? { deferred: true } : {}),
        }].slice(-500);
      }
      if (narrativaNueva && estado.narrative) {
        const author = canonicalAgent(estado.narrativeAuthor ?? estado.agent);
        c.narratives = [...(Array.isArray(c.narratives) ? c.narratives : []), {
          at: estado.narrativeWrittenAt ?? estado.writtenAt, agent: author, branch,
        }].slice(-500);
      }
      writeAtomic(ruta, JSON.stringify(c, null, 2));
    }, 40);
  } catch {}
}
