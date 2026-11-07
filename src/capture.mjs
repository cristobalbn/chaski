#!/usr/bin/env node
// Hook de captura. Lo ejecutan Claude Code, Codex y agy al terminar cada turno.
//
// Reglas que gobiernan este archivo:
//   - Nunca falla. Cualquier error sale por exit 0 con un aviso a stderr: un
//     hook que revienta le arruina la sesión al usuario.
//   - Nunca llama a un modelo. Cero tokens, cero red, cero términos de uso.
//   - Nunca tarda. El presupuesto del hook Stop de Claude Code es de 1,5 s
//     COMPARTIDO con los demás hooks del event. El caso normal usa unos
//     260-340 ms; con miles de archivos modificados a la vez, el reloj de
//     lib/budget.mjs corta trabajo caro antes de llegar ahí (ver gitFacts en
//     lib/facts.mjs) en vez de dejar que el hook se cancele y se pierda el
//     relevo entero.
//   - Nunca escribe fuera de .tambo/ del proyecto y ~/.chaski/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statePath, relayPath, readJson, acquireLock, globalDir, git, pruneOrphanRelays, existsSync, projectDir } from './lib/paths.mjs';
import { gitFacts, transcriptFacts } from './lib/facts.mjs';
import { render, writeAtomic, sign } from './lib/relay.mjs';
import { redact } from './lib/secrets.mjs';
import { shouldAsk, askText, askPayload } from './lib/ask.mjs';
import { createBudget, STOP_HOOK_BUDGET_MS } from './lib/budget.mjs';

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
    const cwd = projectDir(ev.cwd || process.cwd());

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

    // Un solo escritor. Si otro proceso tiene el lock, este turno se saltea:
    // el siguiente lo recupera, porque la marca de agua no avanzó.
    liberar = acquireLock(cwd);
    if (!liberar) return ok();

    const previo = readJson(statePath(cwd), {}) ?? {};

    // La marca de agua pertenece a UNA sesión y a UN transcript. Si cambia
    // cualquiera de los dos, se lee desde el principio: arrastrar el offset
    // de ayer a un transcript nuevo haría que se saltee todo el trabajo de
    // hoy hasta ese byte. El caso aparece al volver a trabajar al día
    // siguiente, que es justo at el relevo importa.
    const mismaSesion = previo.session && ev.session_id && previo.session === ev.session_id;
    const mismoTranscript = previo.transcript && ev.transcript_path
      && previo.transcript === ev.transcript_path;
    const desde = (mismaSesion && mismoTranscript) ? (previo.offset ?? 0) : 0;

    const t = transcriptFacts(ev.transcript_path, desde, config, budget);
    const g = gitFacts(cwd, config, budget);

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
      turns: (mismaSesion ? (previo.turns ?? 0) : 0) + t.turns,
      facts: g,
      // HEAD al momento de escribir: inject.mjs lo compara para detectar deriva.
      // Siempre con su propio intento aunque el presupuesto esté muy ajustado:
      // es el valor más barato y más esencial de todos, y git() ya no lo deja
      // exceder lo que queda.
      head: g.isRepo ? (gitHead(cwd, budget) ?? null) : null,
      // Si algún paso de gitFacts se quedó sin presupuesto, se declara aquí
      // -en un campo de hechos, no de narrative- para que el agent siguiente
      // sepa que el relevo es incompleto por diseño y no por error silencioso.
      trimmed: g.trimmed ?? [],
      commands: fusionar(mismaSesion ? previo.commands : [], t.commands),
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
      subagents: previo.subagents ?? null,
      // Tareas en segundo plano que quedan corriendo. Si cambias de CLI con
      // algo a medio ejecutar, el agent nuevo tiene que saberlo.
      backgroundTasks: liveTasks(ev),
      redactions: 0,
      event: ev.hook_event_name ?? null,
    };

    // Un corte por cuota se sella y se deja anotado: es el instante del relevo.
    if (ev.hook_event_name === 'StopFailure' && /rate.?limit/i.test(ev.error_type ?? '')) {
      estado.sealedAtLimit = { at: estado.writtenAt, motivo: ev.error_type };
    }

    const { redactions } = redact(JSON.stringify(estado.commands), config);
    estado.redactions = redactions;

    const md = render(estado);
    estado.signature = sign(md);

    // ¿Toca pedirle la narrativa al agent? Se decide ANTES de escribir, para
    // que el instante de la petición quede en el mismo estado que se guarda:
    // el hook no tiene memoria entre turnos y el debounce vive ahí.
    const motivo = ev.hook_event_name === 'Stop'
      ? shouldAsk(ev, estado, previo, config) : null;
    if (motivo) {
      estado.askedAt = estado.writtenAt;
      estado.askedReason = motivo;
    } else {
      estado.askedAt = previo.askedAt ?? null;
      estado.askedReason = previo.askedReason ?? null;
    }
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
    const narrativaNueva = (estado.narrativeWrittenAt ?? null) !== (previo.narrativeStamp ?? null);
    estado.turnsAtNarrative = narrativaNueva ? (estado.turns ?? 0) : (previo.turnsAtNarrative ?? 0);
    estado.narrativeStamp = estado.narrativeWrittenAt ?? null;

    writeAtomic(relayPath(cwd), md);
    writeAtomic(statePath(cwd), JSON.stringify(estado, null, 2));
    heartbeat(estado.agent);
    occasionalPrune(cwd, config);

    // La petición va por stdout y solo después de que el relevo esté escrito:
    // si algo de arriba fallara, se pierde la petición y no el relevo.
    //
    // El contrato lo arma `askPayload`, porque NO es el mismo en los tres:
    // Claude Code y Codex usan `decision: "block"`, Antigravity usa
    // `"continue"` y trata cualquier otro valor como permiso para parar.
    if (motivo) {
      const salida = askPayload(estado.agent, askText(motivo));
      if (salida) process.stdout.write(JSON.stringify(salida) + '\n');
    }

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
    liberar = acquireLock(cwd);
    if (!liberar) return ok(); // el padre está escribiendo; se pierde esta promoción

    const estado = readJson(statePath(cwd), null);
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

    const md = render(estado);
    estado.signature = sign(md);
    writeAtomic(relayPath(cwd), md);
    writeAtomic(statePath(cwd), JSON.stringify(estado, null, 2));
  } catch (e) {
    process.stderr.write(`chaski: promoción omitida (${e?.message ?? e})\n`);
  } finally {
    if (liberar) liberar();
  }
  return ok();
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

/** Lee el payload JSON de stdin. Cada CLI nombra sus campos distinto. */
function readPayload() {
  let bruto = '';
  try { bruto = readFileSync(0, 'utf8'); } catch {}
  let ev = {};
  try { ev = JSON.parse(bruto) || {}; } catch {}

  // Normalización defensiva: ninguno de los tres prometió estabilidad, y
  // Antigravity usa camelCase y nombres propios. Verificado contra payloads
  // reales de Claude Code y de agy.
  const ws = Array.isArray(ev.workspacePaths) ? ev.workspacePaths[0] : null;
  ev.transcript_path = ev.transcript_path ?? ev.transcriptPath ?? ev.transcript ?? null;
  ev.hook_event_name = ev.hook_event_name ?? ev.hookEventName ?? ev.event ?? process.argv[2] ?? null;
  ev.session_id = ev.session_id ?? ev.sessionId ?? ev.conversationId ?? ev.conversation_id ?? null;
  ev.cwd = ev.cwd ?? ws ?? ev.workspace ?? ev.project_dir ?? process.cwd();
  // agy manda el último prompt del usuario; sirve como pista de la tarea.
  ev.__ultimoPrompt = ev.lastUserInput ?? ev.user_prompt ?? null;
  // Normalizado aquí y no al estampar el latido: `estado.agent` es lo que
  // encabeza el relevo que lee el agent siguiente, y la grafía cambiaba según
  // el evento que lo hubiera escrito.
  ev.__agente = canonicalAgent(process.argv[3] ?? detectAgent(ev));
  return ev;
}

/**
 * Grafía única para un CLI, venga del argumento del hook o de la detección.
 *
 * Los nombres con espacio viajan con guión en la línea de comando (ver `cmd()`
 * en cli.mjs); aquí vuelven a su forma legible, que es la que lee un agent en
 * el relevo. `doctor` ya comparaba normalizando, así que esto solo cierra el
 * lado de la escritura.
 */
function canonicalAgent(agent) {
  const n = String(agent ?? '').trim().toLowerCase().replace(/-/g, ' ');
  return n === 'claude' ? 'claude code' : (n || 'desconocido');
}

function detectAgent(ev) {
  if (process.env.CLAUDECODE || ev.hook_event_name === 'StopFailure') return 'claude code';
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION) return 'codex';
  if (process.env.AGY_SESSION || process.env.ANTIGRAVITY_SESSION) return 'agy';
  return 'desconocido';
}

function loadConfig(cwd) {
  const proyecto = readJson(join(cwd, 'chaski.json'), {}) ?? {};
  const local = readJson(join(cwd, 'chaski.local.json'), {}) ?? {};
  const global = readJson(join(globalDir(), 'config.json'), {}) ?? {};
  // El techo de política del repo no se puede subir desde el archivo local:
  // una política que el individuo puede relajar no es una política.
  const merged = { ...global, ...proyecto, ...local };
  merged.redact = [...(global.redact ?? []), ...(proyecto.redact ?? []), ...(local.redact ?? [])];
  merged.excludePaths = [
    ...(global.excludePaths ?? []), ...(proyecto.excludePaths ?? []), ...(local.excludePaths ?? []),
  ];
  return merged;
}

function fusionar(previos, nuevos) {
  const out = [...(previos ?? []), ...(nuevos ?? [])];
  return out.slice(-12);
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

function gitHead(cwd, budget) { return git(cwd, ['rev-parse', '--short', 'HEAD'], { budget }); }

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
 * Limpieza de relevos de ramas borradas, una vez al día como máximo.
 *
 * No va en cada turno: listar las ramas es otro subproceso de git, y el
 * presupuesto del hook `Stop` es de 1,5 s compartido. Una vez al día alcanza
 * de sobra para algo que acumula unos KB por rama.
 */
function occasionalPrune(cwd, config) {
  try {
    const marca = join(globalDir(), 'ultima-limpieza');
    const ahora = Date.now();
    if (existsSync(marca)) {
      const previa = parseInt(readFileSync(marca, 'utf8'), 10);
      if (Number.isFinite(previa) && ahora - previa < 86_400_000) return;
    }
    writeAtomic(marca, String(ahora));
    pruneOrphanRelays(cwd, {
      factsOnly: config?.pruneAfterDays,
      withNarrative: config?.pruneNarrativeAfterDays,
    });
  } catch {}
}

/**
 * Latido por CLI: doctor avisa si alguno dejó de ejecutar su hook.
 *
 * El name llega normalizado porque un mismo CLI entraba por dos vías con dos
 * grafías: `cmd()` de cli.mjs pasa `claude-code` como argumento —con guión,
 * porque el shell parte los argumentos por espacio— y `detectAgent()`, que es
 * el camino de respaldo cuando no hay argumento, devuelve `claude code`. El
 * archivo acababa con las dos claves para la misma herramienta, y la
 * atribución del relevo cambiaba de grafía según qué evento la hubiera
 * escrito. Al escribir se funden las variantes y se conserva la más reciente,
 * para que los archivos que ya quedaron con las dos converjan solos.
 */
function heartbeat(agent) {
  try {
    const ruta = join(globalDir(), 'latidos.json');
    const l = readJson(ruta, {}) ?? {};
    const name = canonicalAgent(agent);
    const ahora = new Date().toISOString();
    for (const k of Object.keys(l)) {
      if (k !== name && canonicalAgent(k) === name) {
        if (l[k] > ahora) l[name] = l[k];
        delete l[k];
      }
    }
    l[name] = l[name] > ahora ? l[name] : ahora;
    writeAtomic(ruta, JSON.stringify(l, null, 2));
  } catch {}
}
