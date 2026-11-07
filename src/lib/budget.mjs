// Presupuesto de tiempo del hook.
//
// El hook `Stop` de Claude Code comparte 1,5 s con los demás hooks del mismo
// evento, que no controlamos. Antes de este módulo no existía ningún reloj:
// el único timeout era el de cada llamada a `git()` (4.000 ms), mayor que el
// presupuesto entero, así que no protegía nada — una sola llamada cara (un
// `diff --numstat` sobre miles de archivos) podía agotar el hook completo sin
// que nada se lo impidiera, y el relevo del turno se perdía entero.
//
// La solución es doble a propósito, y las dos mitades son necesarias:
//   - Un reloj GLOBAL desde el arranque del hook, contra el que cada paso
//     consulta cuánto queda ANTES de lanzar un subproceso. Esto es lo que
//     permite decidir qué omitir cuando no cabe todo (ver gitFacts en
//     facts.mjs), y es barato: un Date.now(), nada de spawnear nada.
//   - Un timeout por llamada DERIVADO de lo que queda del reloj global. Es
//     la red de seguridad para cuando la estimación de costo de un paso
//     resultó optimista (disco lento, antivirus, OneDrive bloqueando el
//     archivo): ninguna llamada individual puede ya exceder el presupuesto
//     completo, porque su timeout nunca es mayor que lo que queda.
export const STOP_HOOK_BUDGET_MS = 1100; // de 1.500 ms compartidos, deja ~400 ms (27%) para los demás hooks del evento

// inject.mjs no tiene un presupuesto compartido documentado como el de Stop,
// pero es "el único código en el camino crítico" (ver inject.mjs): el usuario
// espera a que termine antes de poder escribir. Medido: sus llamadas a git
// son baratas por construcción (usan `--name-only`, nunca `--numstat`, así
// que no escalan con el tamaño del diff) incluso con 3.000 commits o 10.000
// archivos cambiados en un rango. Este presupuesto es la misma red de
// seguridad por si el día de mañana aparece un caso que sí escale mal -- no
// es una resta de un límite externo conocido, como sí lo es el de Stop.
export const SESSION_START_BUDGET_MS = 800;

// Una llamada a la que le queda menos que esto no vale la pena intentarla:
// el costo fijo de spawnear git (medido: 20-40 ms en Windows) ya se la come.
export const MIN_GIT_CALL_MS = 60;

/** Reloj de un solo uso para un presupuesto de `ms` desde este instante. */
export function createBudget(ms) {
  const inicio = Date.now();
  const limite = inicio + ms;
  return {
    remaining() { return limite - Date.now(); },
    expired() { return Date.now() >= limite; },
    elapsed() { return Date.now() - inicio; },
  };
}

/** ¿Queda tiempo suficiente para intentar un paso de costo mínimo `piso`? */
export function hasTime(budget, piso = MIN_GIT_CALL_MS) {
  return !budget || budget.remaining() > piso;
}

/**
 * El timeout que de verdad debe usar una llamada: nunca más que lo que queda
 * del presupuesto global, aunque quien llama haya pedido más.
 *
 * Separado de `git()` a propósito, para poder probarlo sin spawnear nada: la
 * alternativa (reintroducir el bug a mano para verificar el test) necesitaría
 * un comando real lo bastante lento como para notar la diferencia, lo que
 * vuelve el test lento y frágil entre máquinas. Esta función aislada se
 * prueba con un presupuesto falso, sin spawnear ni esperar nada.
 */
export function effectiveTimeout(timeout, budget) {
  return budget ? Math.min(timeout, budget.remaining()) : timeout;
}
