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
 */
export function shouldAsk(ev, estado, previo, config, ahora = Date.now()) {
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
  const mismaSesion = !previo?.session || !estado?.session || previo.session === estado.session;
  const baseTurns = mismaSesion && (previo?.turnsAtNarrative ?? 0) <= (estado.turns ?? 0)
    ? (previo?.turnsAtNarrative ?? 0) : 0;
  const turnosDesde = (estado.turns ?? 0) - baseTurns;
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
  if (haySkill) return `${linea} Usa la skill \`relevo\`.`;
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
  const a = String(agent ?? '').toLowerCase();

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
  if (/^claude/.test(a)) {
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
  if (a === 'agy' || a === 'antigravity') return { decision: 'continue', reason };
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

/** Una petición anotada vale un rato: después ya no es «el trabajo anterior». */
export const PENDING_TTL_MS = 12 * 3600 * 1000;

/**
 * ¿Hay que entregar la petición anotada con este mensaje?
 *
 * Solo en la MISMA sesión: en otra, el agente no tiene la conversación que
 * tendría que resumir y escribiría una narrativa inventada. Y no si ya hay
 * una narrativa posterior a la anotación: sería pedirla dos veces.
 */
export function shouldDeliverPending(pending, sessionId, estado, ahora = Date.now()) {
  if (!pending || typeof pending !== 'object' || !pending.reason) return false;
  if (!sessionId || pending.session !== sessionId) return false;
  const at = Date.parse(pending.at ?? '');
  if (!Number.isFinite(at) || ahora - at > PENDING_TTL_MS || at > ahora + 60_000) return false;
  const narrada = Date.parse(estado?.narrativeWrittenAt ?? '');
  if (Number.isFinite(narrada) && narrada >= at) return false;
  return true;
}

/** Salida de `UserPromptSubmit` en Claude Code: contexto que no se pinta. */
export function promptPayload(texto) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texto } };
}
