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
  // contrato (ver `blockPayload`). Un CLI desconocido no se intenta.
  if (!blockPayload(estado.agent, '')) return null;

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

  // Narrativa que quedó atrás. Se mide en turnos de trabajo y en commits, no
  // en tiempo: una sesión larga sin cambios no necesita reescribirla.
  const turnosDesde = (estado.turns ?? 0) - (previo?.turnsAtNarrative ?? 0);
  if (commitsNuevos) return 'hay commits nuevos desde la última narrativa';
  if (turnosDesde >= TURNOS_MIN) return `van ${turnosDesde} turnos desde la última narrativa`;

  return null;
}

/**
 * El texto que lee el agent cuando se le pide la narrativa.
 *
 * Es una instrucción, no datos: a diferencia del relevo, esto sí le dice al
 * agent qué hacer. Pide explícitamente el estado del trabajo EN VUELO, porque
 * ese es el caso que motiva todo: una tarea cortada a mitad, con código sin
 * terminar, que el agent siguiente tiene que poder retomar sin rehacerla.
 */
export function askText(motivo) {
  return [
    `chaski: ${motivo}.`,
    '',
    'Antes de terminar, guarda la narrativa del relevo con la skill `relevo`.',
    'Es para el agent que retome este trabajo si se corta la sesión o se agota',
    'la cuota, así que lo que más importa es el estado EN VUELO:',
    '',
    '- qué estabas haciendo y para qué;',
    '- qué quedó a medias, con la ruta y la línea: un archivo editado sin',
    '  terminar, una función a medio escribir, un test que falla por eso y no',
    '  por otra cosa;',
    '- qué decidiste y qué descartaste, para que nadie reabra lo ya cerrado;',
    '- el siguiente paso concreto, uno solo.',
    '',
    'No repitas los hechos: los archivos, el diff y los commits ya están en el',
    'relevo. Escribe solo lo que no se deduce del código. 120-200 palabras.',
    'Después de guardarla, termina el turno sin hacer nada más.',
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
export function blockPayload(agent, reason) {
  const a = String(agent ?? '').toLowerCase();
  // Claude Code y Codex comparten formato: `decision: "block"`, y el `reason`
  // se convierte en el prompt de continuación.
  if (/^claude/.test(a) || a === 'codex') return { decision: 'block', reason };
  // Antigravity: `continue` bloquea el stop y reentra al bucle; el `reason` se
  // inyecta como mensaje de sistema.
  if (a === 'agy' || a === 'antigravity') return { decision: 'continue', reason };
  return null;
}
