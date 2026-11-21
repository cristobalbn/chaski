import { join } from 'node:path';
import { globalDir, readOnlyGlobalDir, readJson, promptHookPath } from './paths.mjs';
import { canonicalAgent } from './payload.mjs';
import { PROMPT_HOOK_EVENTS } from './ask.mjs';
import { withFileLock } from './lock.mjs';
import { writeAtomic } from './atomic.mjs';
import { MINUTE_MS } from './time.mjs';

function readActivity(path) {
  const data = readJson(path, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function recent(value, now, ttl) {
  const time = Date.parse(value ?? '');
  return time <= now && now - time < ttl;
}

function record(path, agent, ttl, migrateAliases = false) {
  const now = Date.now();
  const aliases = (data) => migrateAliases
    ? Object.keys(data).filter((key) => key !== agent && canonicalAgent(key) === agent) : [];
  const unchanged = (data, oldKeys) => recent(data[agent], now, ttl) && !oldKeys.length;
  try {
    const previous = readActivity(path);
    if (unchanged(previous, aliases(previous))) return;
    globalDir();
    withFileLock(path, () => {
      const data = readActivity(path);
      const oldKeys = aliases(data);
      if (unchanged(data, oldKeys)) return;
      let timestamp = now;
      for (const key of [agent, ...oldKeys]) {
        const at = Date.parse(data[key] ?? '');
        if (at > timestamp && at - now < MINUTE_MS) timestamp = at;
      }
      for (const key of oldKeys) delete data[key];
      writeAtomic(path, JSON.stringify({ ...data, [agent]: new Date(timestamp).toISOString() }, null, 2));
    }, 40);
  } catch {}
}

/** Doctor muestra el latido con granularidad de minutos. */
export function recordCaptureActivity(agent) {
  record(join(readOnlyGlobalDir(), 'latidos.json'), canonicalAgent(agent), MINUTE_MS, true);
}

/** El primer mensaje confirma que el hook de entrega está activo. */
export function recordPromptActivity(agent) {
  if (Object.hasOwn(PROMPT_HOOK_EVENTS, agent)) record(promptHookPath(), agent, 10 * MINUTE_MS);
}
