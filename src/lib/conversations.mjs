import { isFresh, MODEL_TEXT_TTL_MS } from './time.mjs';

const MAX_CONVERSATIONS = 8;

function matches(state, agent, session, transcript) {
  if (!state || (state.agent && state.agent !== agent)) return false;
  if (transcript && state.transcript) return transcript === state.transcript;
  return Boolean(session && state.session === session);
}

function recent(state, now) {
  const entries = Array.isArray(state.conversations) ? state.conversations : [];
  return entries.filter((entry) => isFresh(entry?.writtenAt, MODEL_TEXT_TTL_MS, now)).slice(0, MAX_CONVERSATIONS);
}

export function previousConversation(state, agent, session, transcript, now = Date.now()) {
  // El estado superior permite seguir leyendo relevos de versiones anteriores.
  const same = (entry) => matches(entry, agent, session, transcript);
  return same(state) ? state : recent(state, now).find(same);
}

function checkpoint(state) {
  const { agent, session, transcript, transcriptIdentity, writtenAt, offset, turns, commands,
    turnsAtNarrative, narrativeStamp, askedAt, askedReason, askedQuotaKey, lastReply } = state;
  return { agent, session, transcript, transcriptIdentity, writtenAt, offset, turns, commands,
    turnsAtNarrative, narrativeStamp, askedAt, askedReason, askedQuotaKey, lastReply };
}

export function saveConversation(state, previous) {
  const now = Date.parse(state.writtenAt);
  const others = recent(previous, now);
  // La conversación activa ya está arriba. Solo se guarda aparte cuando otra
  // ventana toma su lugar, sin duplicar el estado del caso de una sola sesión.
  if ((previous.session || previous.transcript) && isFresh(previous.writtenAt, MODEL_TEXT_TTL_MS, now)
      && !matches(previous, state.agent, state.session, state.transcript)) {
    others.unshift(checkpoint(previous));
  }
  return others.filter((entry) => !matches(entry, state.agent, state.session, state.transcript))
    .slice(0, MAX_CONVERSATIONS);
}
