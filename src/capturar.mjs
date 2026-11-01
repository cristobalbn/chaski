#!/usr/bin/env node
// Hook de captura. Lo ejecutan Claude Code, Codex y agy al terminar cada turno.
//
// Reglas que gobiernan este archivo:
//   - Nunca falla. Cualquier error sale por exit 0 con un aviso a stderr: un
//     hook que revienta le arruina la sesión al usuario.
//   - Nunca llama a un modelo. Cero tokens, cero red, cero términos de uso.
//   - Nunca tarda. El presupuesto del hook Stop de Claude Code es de 1,5 s
//     COMPARTIDO con los demás hooks del evento; apuntamos a menos de 50 ms.
//   - Nunca escribe fuera de .tambo/ del proyecto y ~/.chaski/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rutaEstado, rutaRelevo, leerJson, tomarLock, dirGlobal, git, limpiarRelevosHuerfanos, existsSync } from './lib/rutas.mjs';
import { hechosGit, hechosTranscript } from './lib/hechos.mjs';
import { render, escribirAtomico, firmar } from './lib/relevo.mjs';
import { redactar } from './lib/secretos.mjs';

main();

function main() {
  let liberar = null;
  try {
    const ev = leerPayload();
    const cwd = ev.cwd || process.cwd();

    const config = cargarConfig(cwd);

    // Un subagente que termina promueve su conclusión al relevo del padre, y
    // nada más. Tiene camino propio porque la captura normal haría dos daños:
    // leería el transcript DEL SUBAGENTE y dejaría su tamaño como marca de
    // agua del padre —que en su próximo turno leería desde la posición
    // equivocada— y derivaría los hechos de git del árbol del hijo, que puede
    // ser otro worktree.
    if (ev.hook_event_name === 'SubagentStop') {
      return promover(ev, cwd, config);
    }

    // Los demás eventos de un subagente se descartan: su exploración
    // contaminaría el relevo con cien lecturas de archivos y tres caminos
    // abandonados que a nadie le sirven mañana.
    if (ev.agent_id) return ok();

    // Un solo escritor. Si otro proceso tiene el lock, este turno se saltea:
    // el siguiente lo recupera, porque la marca de agua no avanzó.
    liberar = tomarLock(cwd);
    if (!liberar) return ok();

    const previo = leerJson(rutaEstado(cwd), {}) ?? {};

    // La marca de agua pertenece a UNA sesión y a UN transcript. Si cambia
    // cualquiera de los dos, se lee desde el principio: arrastrar el offset
    // de ayer a un transcript nuevo haría que se saltee todo el trabajo de
    // hoy hasta ese byte. El caso aparece al volver a trabajar al día
    // siguiente, que es justo cuando el relevo importa.
    const mismaSesion = previo.sesion && ev.session_id && previo.sesion === ev.session_id;
    const mismoTranscript = previo.transcript && ev.transcript_path
      && previo.transcript === ev.transcript_path;
    const desde = (mismaSesion && mismoTranscript) ? (previo.offset ?? 0) : 0;

    const t = hechosTranscript(ev.transcript_path, desde, config);
    const g = hechosGit(cwd, config);

    const estado = {
      version: 1,
      escrito: new Date().toISOString(),
      agente: ev.__agente ?? 'desconocido',
      sesion: ev.session_id ?? null,
      // La ruta del transcript se guarda para poder invalidar la marca de agua.
      transcript: ev.transcript_path ?? null,
      offset: t.offset,
      // Los turnos se acumulan dentro de una sesión; en una nueva se reinician,
      // o el relevo diría "1.200 turnos" de trabajo que ya no está en contexto.
      turnos: (mismaSesion ? (previo.turnos ?? 0) : 0) + t.turnos,
      hechos: g,
      // HEAD al momento de escribir: leer.mjs lo compara para detectar deriva.
      head: g.esRepo ? (gitHead(cwd) ?? null) : null,
      comandos: fusionar(mismaSesion ? previo.comandos : [], t.comandos),
      ultimoArchivo: ultimoTocado(g, previo),
      // La narrativa es del agente, no de este script. Se preserva tal cual.
      narrativa: previo.narrativa ?? null,
      narrativaAutor: previo.narrativaAutor ?? null,
      narrativaEscrita: previo.narrativaEscrita ?? null,
      // Tareas en segundo plano que quedan corriendo. Si cambias de CLI con
      // algo a medio ejecutar, el agente nuevo tiene que saberlo.
      enSegundoPlano: tareasVivas(ev),
      redacciones: 0,
      evento: ev.hook_event_name ?? null,
    };

    // Un corte por cuota se sella y se deja anotado: es el instante del relevo.
    if (ev.hook_event_name === 'StopFailure' && /rate.?limit/i.test(ev.error_type ?? '')) {
      estado.selladoEnCorte = { cuando: estado.escrito, motivo: ev.error_type };
    }

    const { redacciones } = redactar(JSON.stringify(estado.comandos), config);
    estado.redacciones = redacciones;

    const md = render(estado);
    estado.firma = firmar(md);

    escribirAtomico(rutaRelevo(cwd), md);
    escribirAtomico(rutaEstado(cwd), JSON.stringify(estado, null, 2));
    latido(estado.agente);
    limpiezaOcasional(cwd, config);
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
 * Beneficio secundario: como es mecánico, diez subagentes no multiplican por
 * diez el costo. No hay síntesis aquí; solo el padre sintetiza, una vez, sobre
 * resultados ya condensados.
 *
 * El diseño original proponía un quipu hijo efímero en `.tambo/sub/<id>.json`.
 * Resultó innecesario: el payload de `SubagentStop` ya trae la conclusión, así
 * que un archivo intermedio solo agregaría algo que limpiar.
 */
function promover(ev, cwd, config) {
  let liberar = null;
  try {
    liberar = tomarLock(cwd);
    if (!liberar) return ok(); // el padre está escribiendo; se pierde esta promoción

    const estado = leerJson(rutaEstado(cwd), null);
    // Sin relevo del padre no hay dónde promover. Crear uno desde un subagente
    // dejaría un relevo con la conclusión de un hijo y ningún hecho.
    if (!estado) return ok();

    const { texto } = redactar(String(ev.last_assistant_message ?? '').trim(), config);
    const conclusion = resumirConclusion(texto);
    if (!conclusion) return ok();

    const entrada = {
      tipo: ev.agent_type ?? 'subagente',
      conclusion,
      cuando: new Date().toISOString(),
      // `stop_reason` distinto de end_turn suele significar que no terminó
      // lo que estaba haciendo, y eso es justamente lo que hay que avisar.
      razon: ev.stop_reason && ev.stop_reason !== 'end_turn' ? ev.stop_reason : null,
    };

    const previas = (estado.subagentes ?? []).filter((s) => s.conclusion !== conclusion);
    // Presupuesto: el relevo tiene techo de tamaño y los subagentes compiten
    // con los hechos por ese espacio.
    estado.subagentes = [...previas, entrada].slice(-6);
    estado.escrito = new Date().toISOString();

    const md = render(estado);
    estado.firma = firmar(md);
    escribirAtomico(rutaRelevo(cwd), md);
    escribirAtomico(rutaEstado(cwd), JSON.stringify(estado, null, 2));
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
function resumirConclusion(texto) {
  if (!texto) return null;
  const limpio = texto
    .replace(/```[\s\S]*?```/g, '[bloque de código]') // el código ya está en el diff
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!limpio) return null;
  return limpio.length > 400 ? limpio.slice(0, 400).trimEnd() + '…' : limpio;
}

/** Lee el payload JSON de stdin. Cada CLI nombra sus campos distinto. */
function leerPayload() {
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
  ev.__agente = process.argv[3] ?? detectarAgente(ev);
  return ev;
}

function detectarAgente(ev) {
  if (process.env.CLAUDECODE || ev.hook_event_name === 'StopFailure') return 'claude code';
  if (process.env.CODEX_HOME || process.env.CODEX_SESSION) return 'codex';
  if (process.env.AGY_SESSION || process.env.ANTIGRAVITY_SESSION) return 'agy';
  return 'desconocido';
}

function cargarConfig(cwd) {
  const proyecto = leerJson(join(cwd, 'chaski.json'), {}) ?? {};
  const local = leerJson(join(cwd, 'chaski.local.json'), {}) ?? {};
  const global = leerJson(join(dirGlobal(), 'config.json'), {}) ?? {};
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

function ultimoTocado(g, previo) {
  // Solo archivos: un directorio sin trackear no es "el último archivo tocado".
  const cand = (g.sucios ?? []).filter((s) => !s.ruta.endsWith('/'));
  if (!cand.length) return previo.ultimoArchivo ?? null;
  // Aproximación: el que acumula más cambios. El orden del diff no indica
  // recencia, así que no sirve para esto.
  const conCambios = cand.filter((s) => s.mas !== null);
  if (conCambios.length) {
    return conCambios.sort((a, b) => (b.mas + b.menos) - (a.mas + a.menos))[0].ruta;
  }
  return cand[0].ruta;
}

function gitHead(cwd) { return git(cwd, ['rev-parse', '--short', 'HEAD']); }

/**
 * Tareas en segundo plano todavía corriendo, del payload del hook.
 * Confirmado en el payload real de Claude Code: campo `background_tasks`,
 * con id, status y description. Los otros CLIs pueden no enviarlo.
 */
function tareasVivas(ev) {
  const tareas = ev.background_tasks ?? ev.backgroundTasks ?? [];
  if (!Array.isArray(tareas)) return [];
  return tareas
    .filter((t) => t && /running|pending|in_progress/i.test(t.status ?? ''))
    .map((t) => ({
      descripcion: String(t.description ?? t.id ?? 'sin descripción').slice(0, 120),
      tipo: t.type ?? null,
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
function limpiezaOcasional(cwd, config) {
  try {
    const marca = join(dirGlobal(), 'ultima-limpieza');
    const ahora = Date.now();
    if (existsSync(marca)) {
      const previa = parseInt(readFileSync(marca, 'utf8'), 10);
      if (Number.isFinite(previa) && ahora - previa < 86_400_000) return;
    }
    escribirAtomico(marca, String(ahora));
    limpiarRelevosHuerfanos(cwd, {
      soloHechos: config?.limpiarTrasDias,
      conNarrativa: config?.limpiarConNarrativaTrasDias,
    });
  } catch {}
}

/** Latido por CLI: doctor avisa si alguno dejó de ejecutar su hook. */
function latido(agente) {
  try {
    const ruta = join(dirGlobal(), 'latidos.json');
    const l = leerJson(ruta, {}) ?? {};
    l[agente] = new Date().toISOString();
    escribirAtomico(ruta, JSON.stringify(l, null, 2));
  } catch {}
}
