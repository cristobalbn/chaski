import { readSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { cwdOf } from './payload.mjs';
import { loadConfig } from './paths.mjs';
import { anonymize, createRedactor } from './secrets.mjs';
import { withFileLock } from './lock.mjs';
import { writeAtomic } from './atomic.mjs';

const INPUT_BYTES = 64 * 1024;
const RECORD_BYTES = 64 * 1024;
const LOG_BYTES = 256 * 1024;
const DEPTH_LIMIT = 32;
const REDACTED_FIELD = '[redactado: campo sensible]';
const RECORD_START = '\n===== ';
const SENSITIVE_FIELDS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'apitoken', 'bearertoken', 'secret',
  'clientsecret', 'password', 'passwd', 'passphrase', 'privatekey', 'apikey',
  'authorization', 'cookie', 'setcookie', 'credentials',
]);

function readInput() {
  const buffer = Buffer.allocUnsafe(INPUT_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const size = readSync(0, buffer, length, buffer.length - length, null);
    if (!size) break;
    length += size;
  }
  if (length > INPUT_BYTES) return { status: 'input-too-large' };
  try {
    return { payload: JSON.parse(buffer.toString('utf8', 0, length)) };
  } catch {
    return { status: 'invalid-json' };
  }
}

function sensitiveField(key) {
  return SENSITIVE_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function scrub(value, mask, depth = 0, sensitive = false) {
  if (typeof value === 'string') return sensitive ? REDACTED_FIELD : mask(value);
  if (value === null || typeof value !== 'object') return sensitive && value !== null ? REDACTED_FIELD : value;
  if (depth >= DEPTH_LIMIT) return { status: 'depth-limit' };

  if (Array.isArray(value)) return value.map((entry) => scrub(entry, mask, depth + 1, sensitive));
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const base = mask(key);
    let name = base;
    for (let suffix = 2; Object.hasOwn(result, name); suffix++) name = base + '_' + suffix;
    result[name] = scrub(entry, mask, depth + 1, sensitive || sensitiveField(key));
  }
  return result;
}

function probePayload() {
  const input = readInput();
  if (input.status) return JSON.stringify(input);
  const redact = createRedactor(loadConfig(cwdOf(input.payload)));
  const home = homedir();
  const mask = (text) => anonymize(redact(text).texto, { home }).texto;
  const json = JSON.stringify(scrub(input.payload, mask));
  return Buffer.byteLength(json) <= RECORD_BYTES ? json : '{"status":"record-too-large"}';
}

function boundedLog(path, entry) {
  let previous = '';
  try {
    if (statSync(path).size <= LOG_BYTES) previous = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bytes = Buffer.from(previous + entry);
  if (bytes.length <= LOG_BYTES) return bytes;
  const start = bytes.indexOf(RECORD_START, bytes.length - LOG_BYTES);
  return start === -1 ? Buffer.from(entry) : bytes.subarray(start);
}

export function captureProbe(path, event, agent) {
  try {
    const label = (value) => String(value ?? '').replace(/[^A-Za-z0-9 .-]/g, '').slice(0, 64) || '?';
    const head = RECORD_START + label(event) + ' | ' + label(agent) + ' | ' + new Date().toISOString();
    const entry = head + '\n' + probePayload() + '\n';
    withFileLock(path, () => writeAtomic(path, boundedLog(path, entry), { mode: 0o600 }));
  } catch {
    // Tampoco un fallo del diagnóstico debe interrumpir a un CLI.
  }
}
