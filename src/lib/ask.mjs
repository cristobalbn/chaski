// Cuándo pedirle al agent que escriba la narrativa, y cómo pedírselo.
//
// El modo manual tiene un defecto estructural, no de disciplina del usuario:
// la narrativa la escribe el agent, así que **necesita cuota**. Quien espera a
// estar al límite descubre que el momento en que más la necesita es justo
// aquel en que ya no se puede generar. Y el corte por cuota es abrupto: deja
// una tarea a medias y un relevo que solo tiene hechos, sin el porqué ni el
// siguiente paso, que es lo único que no se deriva de git.
//
// La solución no es recordárselo mejor al usuario: es pedirla **temprano y
// repartida**, cuando todavía hay cuota de sobra. Así nunca depende del final.
//
// Cómo: el hook `Stop` de Claude Code acepta `{decision:"block", reason}`, que
// mantiene al agent trabajando con una instrucción más. No se invoca ningún
// modelo por fuera —los términos de los tres proveedores lo prohíben para
// suscripciones de consumidor, ver el invariante 5— sino que se le pide al
// agent que YA está en sesión. Es uso interactivo, y además es técnicamente
// mejor que una llamada externa: ese agent tiene la conversación en contexto y
// en caché, así que sabe lo que ningún proceso aparte podría reconstruir.
//
// El costo es real y hay que respetarlo: cada disparo agrega un turno a la
// conversación del usuario. Un hook que bloqueara en cada `Stop` duplicaría
// sus turnos y sería insufrible, así que el debounce no es un ajuste fino sino
// una condición de usabilidad.
import { canonicalAgent } from './payload.mjs';

/** Minutos mínimos entre dos peticiones, para no agregar un turno cada rato. */
export const DEBOUNCE_MIN = 12;

/** Turnos de trabajo mínimos desde la última narrativa antes de volver a pedir. */
export const TURNOS_MIN = 8;

/**
 * El umbral de turnos efectivo: `askNarrativeAfterTurns` si es un entero
 * positivo, `TURNOS_MIN` en cualquier otro caso. Un valor inválido no apaga
 * la petición —para eso está `askNarrative: false`—, porque un error de
 * tipeo en la config no debería dejar a nadie sin narrativa sin saberlo.
 */
export function turnsThreshold(config) {
  const n = config?.askNarrativeAfterTurns;
  return Number.isInteger(n) && n >= 1 ? n : TURNOS_MIN;
}

/**
 * Minutos que una narrativa se considera fresca. Mientras lo sea, no se vuelve
 * a pedir ni aunque haya commits nuevos.
 *
 * Sin esto, una sesión que mergea tres PR seguidos recibía una petición por
 * merge: cada uno mueve el HEAD, y "hay commits nuevos" disparaba aunque la
 * narrativa fuera de hace un minuto y siguiera siendo exacta. El usuario lo
 * vio como un mensaje después de cada prompt, que es justo el modo de fallo
 * que el debounce existe para evitar.
 */
export const NARRATIVA_FRESCA_MIN = 20;

/**
 * ¿Hay que pedir la narrativa en este `Stop`?
 *
 * Devuelve `null` si no, o el motivo (string corto) si sí. El motivo entra en
 * el texto que lee el agent, así que explica POR QUÉ se le pide ahora.
 *
 * @param ev      payload del hook
 * @param estado  el estado que se acaba de calcular para este turno
 * @param previo  el estado del turno anterior
 * @param config  configuración mezclada del proyecto
 * @param ahora   Date.now() inyectable, para poder probar sin esperar
 * @param cuota   presión de cuota de quotaPressure(), o null (#82)
 */
export function shouldAsk(ev, estado, previo, config, ahora = Date.now(), cuota = null) {
  // Apagable. Quien no quiera un turno extra nunca, pone `askNarrative: false`.
  if (config?.askNarrative === false) return null;

  // Los tres soportan mantener al agent un turno más, pero NO con el mismo
  // contrato (ver `askPayload`). Un CLI desconocido no se intenta.
  if (!askPayload(estado.agent, '')) return null;

  // Protección contra bucles. Sin esto, un hook que bloquea vuelve a
  // bloquear en el turno que él mismo provocó, y no termina nunca.
  //
  // Claude Code y Codex traen `stop_hook_active` justamente para esto.
  // Antigravity no documenta nada equivalente: trae `executionNum`, que
  // cuenta las vueltas del bucle del agent, y un tope propio de
  // continuaciones forzadas cuyo valor no está documentado. Así que ahí la
  // protección la pone chaski: solo se pide en la primera vuelta.
  if (ev.stop_hook_active) return null;
  if (Number(ev.executionNum ?? 1) > 1) return null;
  // agy 1.5.6 agregó el equivalente explícito: `continuation_active` es true
  // mientras el agente trabaja en una continuación que pidió un Stop anterior.
  // Lo detectó el informe de scripts/upstream.mjs (2026-11-27).
  if (ev.continuation_active === true || ev.continuationActive === true) return null;

  // Un `Stop` sin trabajo detrás no necesita narrativa: no hay nada que
  // contar y el turno extra sería puro ruido.
  const hechos = estado.facts ?? {};
  const sucios = Array.isArray(hechos.dirty) ? hechos.dirty.length : 0;
  const commitsNuevos = previo?.head && estado.head && previo.head !== estado.head;
  if (!sucios && !commitsNuevos && !estado.commands?.length) return null;

  // Debounce. Se guarda en el estado, así que sobrevive al reinicio del
  // proceso: el hook corre de cero en cada turno y no tiene memoria propia.
  const ultima = previo?.askedAt ? Date.parse(previo.askedAt) : 0;
  if (ultima && (ahora - ultima) / 60000 < DEBOUNCE_MIN) return null;

  // Sin narrativa todavía: es el caso que más duele, porque un corte deja el
  // relevo con hechos y sin intención.
  if (!estado.narrative) return 'el relevo todavía no tiene narrativa';

  // Una narrativa recién escrita no se vuelve a pedir, pase lo que pase. Es
  // el corte más fuerte y va primero: lo que hace insufrible a esta función no
  // es pedirla de más en una sesión larga, es pedirla dos veces seguidas.
  const edadNarrativa = estado.narrativeWrittenAt
    ? (ahora - Date.parse(estado.narrativeWrittenAt)) / 60000 : Infinity;
  if (edadNarrativa < NARRATIVA_FRESCA_MIN) return null;

  // Narrativa que quedó atrás. Se mide en turnos de trabajo y en commits, no
  // en tiempo: una sesión larga sin cambios no necesita reescribirla.
  // Si cambió la sesión o el contador previo quedó por encima del actual tras
  // un reinicio de sesión, la cuenta parte desde cero en la sesión nueva.
  //
  // Si capture.mjs ya calculó la base de este turno (`estado.turnsAtNarrative`),
  // manda esa: es la misma cuenta y así las dos no pueden divergir. El cálculo
  // desde `previo` queda para quien llame sin ella (los tests de esta función).
  const mismaSesion = !previo?.session || !estado?.session || previo.session === estado.session;
  const baseTurns = Number.isFinite(estado.turnsAtNarrative) ? estado.turnsAtNarrative
    : mismaSesion && (previo?.turnsAtNarrative ?? 0) <= (estado.turns ?? 0)
      ? (previo?.turnsAtNarrative ?? 0) : 0;
  const turnosDesde = (estado.turns ?? 0) - baseTurns;
  // La cuota se acaba (#82): es la razón de pedir la narrativa temprano, así
  // que va antes que los motivos por turnos. Una vez por ventana: si ya se
  // pidió en esta (misma `key`), no se repite aunque la cuota siga subiendo.
  // Y solo si hubo trabajo después de la última narrativa.
  if (cuota && cuota.key !== (previo?.askedQuotaKey ?? null) && turnosDesde >= 1) {
    return `la cuota de ${cuota.window} va en ${cuota.pct} %`;
  }
  if (commitsNuevos) return 'hay commits nuevos desde la última narrativa';
  if (turnosDesde >= turnsThreshold(config)) return `van ${turnosDesde} turnos desde la última narrativa`;

  return null;
}

/**
 * El texto de la petición.
 *
 * Tiene DOS lectores con necesidades opuestas, y ahí estaba el problema: el
 * agent necesita saber cómo escribir la narrativa, y el usuario —que lo ve en
 * pantalla, porque el CLI lo muestra— solo necesita saber qué está pasando.
 * Mezclarlo le dejaba al usuario nombres de campo y rutas de archivo que no le
 * sirven de nada. Sus palabras: «queda como raro, muy técnico para el
 * usuario».
 *
 * Así que el cómo se delega a la skill, que es del agent y no se ve en
 * pantalla. El mensaje visible queda en una línea legible.
 *
 * La parte técnica solo aparece cuando el agent no tiene la skill disponible
 * en su sesión, porque ahí es la única forma de que la petición sea accionable.
 * Es el caso raro pagando su propio costo, en vez de que lo pague el normal.
 *
 * Nada de marcos tipo «orden del sistema»: la documentación de los hooks avisa
 * que un texto así puede activar las defensas contra inyección de prompts del
 * propio modelo.
 */
export function askText(motivo, haySkill = true, rutaEstado = null, { beforeReply = false } = {}) {
  // Diferida (#73), la petición llega junto con el mensaje siguiente del
  // usuario, y el agente tiene que saber dos cosas: que el relevo es del
  // trabajo ANTERIOR, no del mensaje nuevo, y que después responde con
  // normalidad. Sin lo segundo, contestaría «guardé el relevo» y nada más.
  const linea = beforeReply
    ? `chaski: antes de responder este mensaje, guarda el relevo del trabajo anterior — ${motivo}. Después responde con normalidad.`
    : `chaski: antes de cerrar, guarda el relevo de este trabajo — ${motivo}.`;
  if (haySkill) {
    const destino = beforeReply && rutaEstado ? ` Guarda la narrativa en \`${rutaEstado}\`.` : '';
    return `${linea} Usa la skill \`relevo\`.${destino}`;
  }
  // La ruta va absoluta y resuelta (#48). La plantilla `<rama>` + "en la raíz
  // del repositorio" dejaba al agent adivinando justo en los casos en que no
  // tiene skill: sin repo (la carpeta es `sin-rama`), con el repo en una
  // carpeta hija de la sesión, o con una rama con `/`, cuyo slug lleva hash.
  // capture.mjs ya la calculó con statePath(); repetirla cuesta una línea.
  const destino = rutaEstado
    ? `\`${rutaEstado}\``
    : '`.tambo/branches/<rama>/estado.json` en la raíz del repositorio';
  return [
    linea,
    'Anota qué quedó a medias y dónde, qué descartaste y el siguiente paso, en',
    'los campos `narrative`, `narrativeAuthor` y `narrativeWrittenAt` de',
    `${destino}. No edites \`relevo.md\`.`,
  ].join('\n');
}

/**
 * El objeto que hay que imprimir por stdout para que el agent siga un turno
 * más, en el contrato de SU CLI. Devuelve `null` para un CLI desconocido.
 *
 * Los tres lo soportan, y ninguno igual. La diferencia que más importa es la
 * de Antigravity: su clave es `"continue"`, y su documentación dice que
 * **cualquier otro valor permite parar**. Así que imprimirle el `"block"` de
 * Claude Code no da error — simplemente no hace nada, en silencio, que es el
 * peor modo de fallo posible para esta herramienta. Por eso la salida se arma
 * por CLI y no se comparte.
 *
 * Verificado contra la documentación de cada uno, no en vivo: la primera
 * sesión real de cada CLI es la verificación de verdad. El riesgo de
 * equivocarse es bajo y asimétrico: si el contrato estuviera mal, el agent
 * termina el turno como siempre y se pierde la petición, no el relevo.
 */
export function askPayload(agent, reason) {
  const a = canonicalAgent(agent);

  // Claude Code: `additionalContext` y NO `decision: "block"`.
  //
  // Los dos mantienen al agent un turno más y los dos respetan
  // `stop_hook_active` y el tope de continuaciones. La diferencia es cómo se
  // presenta: con `block`, la interfaz rotula la respuesta como **«Stop hook
  // error»** —la misma palabra que usa para un hook que de verdad falló— y el
  // usuario ve un error en cada petición. Con `additionalContext` el rótulo es
  // «Stop hook feedback». La documentación lo llama literalmente «non-error
  // feedback for Claude».
  //
  // El usuario lo reportó dos veces: «la palabra error no es bonita verla en
  // ninguno caso y menos para un usuario». Y tenía razón más allá de la
  // estética: en una herramienta publicada, un error aparente en cada turno
  // dice que está rota.
  //
  // No se combinan los dos campos: la documentación no dice qué rótulo saldría.
  if (a === 'claude code') {
    return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } };
  }

  // Codex: `decision: "block"`, y el `reason` se convierte en el prompt de
  // continuación. Su documentación no describe un equivalente de
  // `additionalContext` para `Stop`, así que aquí el formato se queda.
  if (a === 'codex') return { decision: 'block', reason };

  // Antigravity: `continue` bloquea el stop y reentra al bucle; el `reason` se
  // inyecta como mensaje de sistema. Su documentación dice que **cualquier otro
  // valor permite parar**, así que mandarle el `"block"` de Claude Code no
  // daría error: no haría nada, en silencio, el peor modo de fallo posible.
  if (a === 'agy') return { decision: 'continue', reason };
  return null;
}

// ----------------------------------------------------------- petición diferida
//
// #73: en Claude Code, la petición en `Stop` llega DESPUÉS de la respuesta, y
// las llamadas de herramientas con que el agente guarda el relevo se pintan
// debajo y la empujan fuera de la pantalla. La documentación de hooks cierra
// las otras salidas: `suppressOutput` en `Stop` «Has no effect», `SessionEnd`
// no puede hacer actuar al modelo y un hook `async` entrega en el turno
// siguiente igual. Lo que sí es invisible es el contexto de
// `UserPromptSubmit`: «Neither channel produces a visible transcript entry».
//
// Así que en `Stop` solo se anota la petición, y el hook de
// `UserPromptSubmit` (inject.mjs) se la entrega al agente con el mensaje
// siguiente del usuario: el guardado ocurre ANTES de la respuesta, y la
// respuesta queda al final, que es donde el usuario la busca.
//
// El riesgo es que no haya mensaje siguiente (se cierra la sesión, se acaba
// la cuota). Lo cubre `lastReply` en capture.mjs: la última respuesta del
// agente queda en el relevo sin que intervenga ningún modelo.
//
// Los tres CLIs tienen un evento previo a la respuesta, cada uno con su
// contrato (ver PROMPT_HOOK_EVENTS y promptPayload):
//   - Claude Code: `UserPromptSubmit` con `hookSpecificOutput.additionalContext`.
//   - Codex: `UserPromptSubmit`, mismo formato; su documentación dice que ese
//     texto «is added as extra developer context».
//   - Antigravity: `PreInvocation` con `injectSteps`. Corre antes de CADA
//     llamada al modelo, no una vez por mensaje, así que la anotación se borra
//     al entregarla y la petición sale una sola vez.

/** Evento que entrega la petición anotada, por CLI. */
export const PROMPT_HOOK_EVENTS = Object.freeze({
  'claude code': 'UserPromptSubmit',
  codex: 'UserPromptSubmit',
  agy: 'PreInvocation',
  // Lo traduce el plugin (src/opencode.mjs): `chat.message` lanza inject.mjs
  // con este evento y agrega el `additionalContext` al system prompt.
  opencode: 'UserPromptSubmit',
});

/**
 * Cuánto vale la prueba de vida del hook de entrega.
 *
 * Diferir solo es seguro si ese hook CORRE, y estar registrado no lo prueba:
 * Codex no ejecuta un hook nuevo hasta que el usuario lo marca como
 * confiable, y una configuración puede quedar a medio actualizar. Diferir
 * sin quien entregue deja el relevo sin narrativa sin que nadie se entere.
 * Como el hook corre al empezar cada turno, uno que funciona tiene una marca
 * de minutos al llegar el `Stop`; 12 h solo cubre pausas largas.
 */
export const PROMPT_HOOK_FRESH_MS = 12 * 3600 * 1000;

/** ¿El hook de entrega de este CLI dio señales de vida hace poco? */
export function promptHookAlive(registro, agent, ahora = Date.now()) {
  const a = canonicalAgent(agent);
  if (!PROMPT_HOOK_EVENTS[a]) return false;
  for (const [k, v] of Object.entries(registro ?? {})) {
    if (canonicalAgent(k) !== a) continue;
    const t = Date.parse(v ?? '');
    if (Number.isFinite(t) && ahora - t < PROMPT_HOOK_FRESH_MS && t <= ahora + 60_000) return true;
  }
  return false;
}

/** Una petición anotada vale un rato: después ya no es «el trabajo anterior». */
export const PENDING_TTL_MS = 12 * 3600 * 1000;

/**
 * ¿La anotación es de esta conversación? Por id de sesión o por transcript:
 * al retomar, Claude Code cambia el id y la conversación sigue en el mismo
 * transcript, así que comparando solo el id la petición anotada antes de un
 * reinicio no se entregaba nunca (y el debounce impedía volver a pedirla).
 */
export function samePendingConversation(pending, sessionId, transcript = null) {
  if (sessionId && pending?.session === sessionId) return true;
  // Por transcript, solo si la sesión que la anotó ya terminó (SessionEnd).
  // Si sigue viva, el «mismo transcript» puede ser solo el archivo más
  // reciente de la carpeta (resolveTranscript) mientras otra sesión, nueva y
  // todavía sin transcript propio, manda su primer mensaje: le entregaría el
  // pedido ajeno y la haría narrar una conversación que no tuvo.
  return Boolean(pending?.sessionEnded && transcript && pending?.transcript && pending.transcript === transcript);
}

/**
 * ¿Hay que entregar la petición anotada con este mensaje?
 *
 * Solo en la MISMA sesión: en otra, el agente no tiene la conversación que
 * tendría que resumir y escribiría una narrativa inventada. Y no si ya hay
 * una narrativa posterior a la anotación: sería pedirla dos veces.
 */
export function shouldDeliverPending(pending, sessionId, estado, ahora = Date.now(), transcript = null) {
  if (!pending || typeof pending !== 'object' || !pending.reason) return false;
  if (!samePendingConversation(pending, sessionId, transcript)) return false;
  const at = Date.parse(pending.at ?? '');
  if (!Number.isFinite(at) || ahora - at > PENDING_TTL_MS || at > ahora + 60_000) return false;
  const narrada = Date.parse(estado?.narrativeWrittenAt ?? '');
  // Un resumen de una ventana distinta no contesta este pedido. Las entradas
  // de versiones anteriores conservan la lógica previa hasta que se consuman.
  const narrativeSession = (estado?.narrativeWrittenAt ?? null) === (estado?.narrativeStamp ?? null)
    ? (estado?.narrativeSession ?? estado?.session)
    : estado?.session;
  const attributed = !pending.agent || (narrativeSession === pending.session
    && (!estado.narrativeAuthor || canonicalAgent(estado.narrativeAuthor) === canonicalAgent(pending.agent)));
  if (attributed && Number.isFinite(narrada) && narrada >= at) return false;
  return true;
}

/**
 * La salida del hook de entrega, en el contrato de cada CLI. `null` para uno
 * desconocido.
 *
 * Antigravity no acepta `hookSpecificOutput`: igual que en `SessionStart`,
 * un formato ajeno no da error, se ignora en silencio. Su `systemMessage`
 * va anidado en otro objeto, como exige su contrato.
 */
export function promptPayload(agent, texto) {
  const a = canonicalAgent(agent);
  if (a === 'agy') return { injectSteps: [{ systemMessage: { systemMessage: texto } }] };
  const evento = PROMPT_HOOK_EVENTS[a];
  if (!evento) return null;
  return { hookSpecificOutput: { hookEventName: evento, additionalContext: texto } };
}

/**
 * Instrucción para el resumen de compactación de Claude Code (hook
 * PreCompact). Pide lo mismo que la narrativa porque cumple el mismo papel:
 * después de compactar, el agente sigue con el resumen y nada más. Los hechos
 * no se piden: chaski los guarda solo y los vuelve a inyectar en el
 * SessionStart que sigue a la compactación.
 */
export const COMPACT_HINT = [
  'chaski: al resumir, conserva lo que un relevo necesita y no se deduce de git:',
  'qué se está intentando lograr; qué se decidió y qué se descartó, con su porqué;',
  'qué quedó a medias, con rutas y líneas; y el siguiente paso concreto.',
  'Los archivos tocados, los commits y los comandos los guarda chaski y no hace falta repetirlos.',
].join(' ');

// ----------------------------------------------------------- cuota (#82)

/** Umbral por defecto de `askNarrativeAtQuota`, en porcentaje de la ventana. */
export const QUOTA_THRESHOLD = 80;

/** Un dato de cuota más viejo que esto ya no describe la sesión actual. */
export const USAGE_FRESH_MS = 15 * 60 * 1000;

/**
 * ¿La cuota de este CLI está por acabarse? Devuelve
 * `{ window, pct, resetsAt, key }` de la ventana más gastada que pasa el
 * umbral, o null.
 *
 * `uso` es la entrada de ese CLI en ~/.chaski/usage.json. Solo vale si es
 * reciente (la statusline la renueva con cada mensaje) y si la ventana no se
 * renovó ya (`resetsAt` en el pasado). `askNarrativeAtQuota: false` (o 0) lo
 * apaga; un valor fuera de 1..100 usa el de defecto.
 */
function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validResetSeconds(value) {
  const n = finiteNumber(value);
  return n !== null && n > 0 && n * 1000 <= 8.64e15 ? n : null;
}

export function quotaPressure(uso, config, ahora = Date.now()) {
  const conf = config?.askNarrativeAtQuota;
  if (conf === false || conf === 0) return null;
  const umbral = Number.isInteger(conf) && conf >= 1 && conf <= 100 ? conf : QUOTA_THRESHOLD;
  const at = Date.parse(uso?.at ?? '');
  if (!Number.isFinite(at) || ahora - at > USAGE_FRESH_MS || at > ahora + 60_000) return null;
  const candidatas = [['5 h', uso.fiveHour], ['7 días', uso.sevenDay]]
    .map(([window, w]) => {
      const pct = finiteNumber(w?.usedPercentage);
      return { window, pct: pct === null || pct < 0 ? NaN : Math.round(pct), resetsAt: validResetSeconds(w?.resetsAt) };
    })
    .filter((c) => Number.isFinite(c.pct) && c.pct >= umbral)
    .filter((c) => !(c.resetsAt !== null && c.resetsAt * 1000 <= ahora))
    .sort((a, b) => b.pct - a.pct);
  if (!candidatas.length) return null;
  const c = candidatas[0];
  return { ...c, key: `${c.window}:${c.resetsAt ?? 'sin-fecha'}` };
}

/** Una línea legible de la cuota, para `chaski next` y `doctor`. null si no hay dato reciente. */
export function usageSummary(uso, ahora = Date.now(), frescura = 6 * 3600 * 1000) {
  const at = Date.parse(uso?.at ?? '');
  if (!Number.isFinite(at) || ahora - at > frescura || at > ahora + 60_000) return null;
  const partes = [];
  for (const [nombre, w] of [['5 h', uso.fiveHour], ['7 días', uso.sevenDay]]) {
    const pct = finiteNumber(w?.usedPercentage);
    if (pct === null || pct < 0) continue;
    const resets = validResetSeconds(w?.resetsAt);
    const vencida = resets !== null && resets * 1000 <= ahora;
    if (vencida && Number.isFinite(frescura)) continue;
    const vence = resets !== null && resets * 1000 > ahora
      ? `, se renueva ${new Date(resets * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
      : (vencida ? ' (ya renovada)' : '');
    partes.push(`${nombre} al ${Math.round(pct)} %${vence}`);
  }
  if (!partes.length) return null;
  const min = Math.max(0, Math.round((ahora - at) / 60000));
  return `cuota ${partes.join(' · ')} (dato de hace ${min} min)`;
}
