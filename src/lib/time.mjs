// Tiempos y vencimientos compartidos.
//
// Estaban repetidos: el mismo «hace N min / h / día(s)» en tres lugares y el
// mismo vencimiento de 72 h en otros tres. Repetidos, divergen: un cambio en
// uno deja al relevo y a los avisos hablando de antigüedad con reglas
// distintas.

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Vencimiento de lo que escribió un modelo y se inyecta en cada arranque:
 * conclusiones de subagentes, la última respuesta del agente, marcas de turno
 * abierto. Lo bastante largo para sobrevivir a un fin de semana, y no tanto
 * como para que un texto viejo (o hostil) quede para siempre.
 */
export const MODEL_TEXT_TTL_MS = 72 * HOUR_MS;

/**
 * Antigüedad legible: «5 min», «3 h», «2 día(s)». Se redondea a la unidad
 * grande porque lo que cambia la lectura es «hace minutos» contra «hace
 * días», no la precisión. Cadena vacía si la marca no es una fecha.
 *
 * El formato lo reconoce onlyNarrativeChanged() en relay.mjs para ignorar el
 * reloj al comparar: si cambias las unidades, cambia también esa expresión.
 */
export function ageText(marca, ahora = Date.now()) {
  const t = typeof marca === 'number' ? marca : Date.parse(marca ?? '');
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((ahora - t) / MINUTE_MS));
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} día(s)`;
}

/** ¿La marca es una fecha de menos de `ttl` atrás (y no del futuro lejano)? */
export function isFresh(marca, ttl, ahora = Date.now()) {
  const t = typeof marca === 'number' ? marca : Date.parse(marca ?? '');
  return Number.isFinite(t) && ahora - t < ttl && t <= ahora + MINUTE_MS;
}
