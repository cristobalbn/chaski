import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createPathFilter, createRedactor } from './secrets.mjs';
import { extractClaude } from './transcripts/claude.mjs';
import { extractAgy } from './transcripts/agy.mjs';
import { extractCodex } from './transcripts/codex.mjs';
import { extractOpencode } from './transcripts/opencode.mjs';

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * Hechos del transcript desde la marca de agua anterior.
 *
 * `path` es la ruta de un JSONL o, para CLIs que no escriben uno (OpenCode),
 * `{ id, content }`: el JSONL completo en memoria, llegado por stdin.
 */
export function transcriptFacts(path, offset = 0, config = null, budget = null, previousCommands = [], previousIdentity = null) {
  const res = { commands: previousCommands.slice(-12).map((command) => ({ ...command })), filesRead: [], lastMessage: null, offset, turns: 0, redactions: 0 };
  if (previousIdentity) res.identity = previousIdentity;
  if (!path) return res;
  if (budget?.expired()) return { ...res, trimmed: true };

  const chunk = typeof path === 'object'
    ? inlineChunk(path, offset)
    : readTranscriptChunk(path, offset, previousIdentity);
  if (!chunk) return res;
  const { buffer, from, trimmed, reset, identity } = chunk;
  res.identity = identity;
  if (reset) {
    res.commands = [];
    res.reset = true;
  }
  if (trimmed) res.trimmed = true;
  res.offset = from;
  if (!buffer.length) return res;

  const redact = createRedactor(config);
  const byId = new Map(res.commands.filter(({ id }) => id != null).map((command) => [command.id, command]));
  const lookup = {
    byId,
    recordCommand(command) {
      res.commands.push(command);
      if (command.id != null) byId.set(command.id, command);
    },
    redactCommand(command) {
      const { texto, redactions } = redact(meaningfulLine(command));
      res.redactions += redactions;
      return texto.slice(0, 160);
    },
    isExcluded: createPathFilter(config),
    pending: [],
    previousCount: res.commands.length,
  };
  let cursor = 0;
  for (let records = 0; cursor < buffer.length; records++) {
    // Un transcript con muchas llamadas puede gastar el presupuesto en
    // parseo. Se reanuda desde el siguiente registro completo.
    if (records % 64 === 0 && budget?.expired()) {
      res.trimmed = true;
      break;
    }
    const newline = buffer.indexOf(0x0a, cursor);
    const end = newline === -1 ? buffer.length : newline;
    const line = buffer.toString('utf8', cursor, end);
    let event;
    if (line.trim()) {
      try { event = JSON.parse(line); }
      catch {
        // Conserva la línea final si el productor aún la está escribiendo.
        if (newline === -1) break;
      }
    }
    if (event && typeof event === 'object' && !Array.isArray(event)) extract(event, res, lookup);
    cursor = newline === -1 ? end : end + 1;
  }
  res.offset = from + cursor;

  res.commands = res.commands.slice(-12);
  res.filesRead = [...new Set(res.filesRead)].slice(-15);
  return res;
}

/**
 * El mismo recorte que readTranscriptChunk, sobre un transcript en memoria.
 * Si la marca de agua no cae justo después de un salto de línea, el contenido
 * cambió por debajo (OpenCode permite deshacer mensajes) y se relee desde 0.
 */
function inlineChunk({ id, content }, offset) {
  if (typeof content !== 'string') return null;
  const all = Buffer.from(content, 'utf8');
  const valid = Number.isSafeInteger(offset) && offset >= 0 && offset <= all.length
    && (offset === 0 || all[offset - 1] === 0x0a);
  const start = valid ? offset : 0;
  const from = Math.max(start, all.length - MAX_TRANSCRIPT_BYTES);
  return {
    buffer: all.subarray(from), from, trimmed: from > start,
    reset: !valid, identity: `inline:${id}`,
  };
}

function readTranscriptChunk(path, offset, previousIdentity) {
  try {
    // Tamaño y lectura del mismo descriptor: si el transcript se reemplaza
    // entre ambas operaciones, no se mezclan versiones del archivo.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) return null;
      const size = Number(stat.size);
      // Un reemplazo puede conservar ruta y tamaño. BigInt evita redondear
      // identificadores de archivo de Windows antes de compararlos.
      const identity = stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
      const reset = offset > size || Boolean(identity && previousIdentity && identity !== previousIdentity);
      const start = Number.isSafeInteger(offset) && offset >= 0 && !reset ? offset : 0;
      const from = Math.max(start, size - MAX_TRANSCRIPT_BYTES);
      const buffer = Buffer.allocUnsafe(size - from);
      const read = buffer.length ? readSync(fd, buffer, 0, buffer.length, from) : 0;
      return { buffer: buffer.subarray(0, read), from, trimmed: from > start, reset, identity };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extract(event, res, lookup) {
  if (event.info && Array.isArray(event.parts)) return extractOpencode(event, res, lookup);
  if (event.step_index !== undefined || event.stepIndex !== undefined) return extractAgy(event, res, lookup);
  if (event.type === 'response_item' || event.type === 'event_msg') return extractCodex(event, res, lookup);
  return extractClaude(event, res, lookup);
}

/**
 * De un comando de varias líneas, la que dice qué se hizo.
 * Tomar la primera línea a secas dejaba el relevo lleno de `cd ...` y
 * `set -e`, que no informan nada de lo que pasó en la sesión.
 */
function meaningfulLine(comando) {
  const colapsado = String(comando)
    .replace(/<private>[\s\S]*?(?:<\/private>|$)/gi, '<private></private>')
    .replace(/-----BEGIN[A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
      '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----');
  const RUIDO = /^\s*(cd\s|set\s+-|export\s|source\s|\.\s|#|echo\s+"?===|if\s|fi$|then$|else$|done$|do$)/i;
  const lineas = colapsado.split('\n').map((l) => l.trim()).filter(Boolean);
  const util = lineas.find((l) => !RUIDO.test(l));
  let elegida = util ?? lineas[0] ?? '';
  // `cd <ruta> && comando` es el patrón más común de todos: lo que informa
  // es el comando, no el directorio.
  elegida = elegida.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i, '');
  return elegida;
}
