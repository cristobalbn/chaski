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
  const turnosDesde = (estado.turns ?? 0) - (previo?.turnsAtNarrative ?? 0);
  if (commitsNuevos) return 'hay commits nuevos desde la última narrativa';
  if (turnosDesde >= TURNOS_MIN) return `van ${turnosDesde} turnos desde la última narrativa`;

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
export function askText(motivo, haySkill = true) {
  const linea = `chaski: antes de cerrar, guarda el relevo de este trabajo — ${motivo}.`;
  if (haySkill) return `${linea} Usa la skill \`relevo\`.`;
  return [
    linea,
    'Anota qué quedó a medias y dónde, qué descartaste y el siguiente paso, en',
    'los campos `narrative`, `narrativeAuthor` y `narrativeWrittenAt` de',
    '`.tambo/branches/<rama>/estado.json` en la raíz del repositorio. No edites `relevo.md`.',
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
