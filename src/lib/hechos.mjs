// Capa de hechos: todo lo que se puede derivar de git y del transcript sin
// llamar a ningún modelo. Cero tokens, milisegundos, y exacto por construcción.
//
// Invariante del proyecto: el modelo NO puede escribir en estos campos.
// El estado de los tests sale del exit code y de ningún otro lado.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { git, rama } from './rutas.mjs';
import { rutaExcluida, redactar } from './secretos.mjs';

/** Hechos de git: rama, archivos sin commitear, diff y divergencia con upstream. */
export function hechosGit(cwd, config) {
  const h = { rama: rama(cwd), esRepo: false, sucios: [], commits: [], upstream: null };
  if (h.rama === null) return h;
  h.esRepo = true;

  // Archivos modificados, con su diff. --numstat da números, no texto del diff:
  // nunca leemos contenido de archivos, así que no hay riesgo de arrastrar secretos.
  const numstat = git(cwd, ['diff', 'HEAD', '--numstat']) ?? '';
  const porArchivo = new Map();
  for (const linea of numstat.split('\n').filter(Boolean)) {
    const [mas, menos, bruto] = linea.split('\t');
    const ruta = destinoDeRenombre(bruto);
    if (!ruta || rutaExcluida(ruta, config)) continue;
    porArchivo.set(ruta, { ruta, mas: num(mas), menos: num(menos) });
  }

  // Sin trackear: aparecen en status pero no en diff HEAD.
  // El parseo NO usa columnas fijas: el stdout llega sin el espacio inicial de
  // la primera línea, así que un slice(3) cortaría un carácter del nombre.
  const status = git(cwd, ['status', '--porcelain']) ?? '';
  for (const linea of status.split('\n')) {
    const m = /^\s*(\S{1,2})\s+(.+?)\s*$/.exec(linea);
    if (!m) continue;
    const ruta = m[2].replace(/^"|"$/g, '').split(' -> ').pop();
    if (!ruta || rutaExcluida(ruta, config)) continue;
    if (!porArchivo.has(ruta)) {
      porArchivo.set(ruta, { ruta, mas: null, menos: null, nuevo: m[1].includes('?') });
    }
  }
  // Tope deliberado. El relevo muestra 20, pero el estado guardaba todos: en
  // un repo con miles de archivos sucios —tras un `npm install` sin
  // gitignore, o al generar código— el estado.json pasaba del megabyte y se
  // reescribía completo en cada turno. Se guarda un margen sobre lo que se
  // muestra y el total aparte, que es lo único que el relevo necesita.
  const todos = [...porArchivo.values()];
  h.sucios = todos.slice(0, 50);
  h.sucioTotal = todos.length;

  // Últimos commits, para que el relevo sepa qué ya quedó cerrado.
  const log = git(cwd, ['log', '-5', '--format=%h %s']) ?? '';
  h.commits = log.split('\n').filter(Boolean);

  h.upstream = divergenciaUpstream(cwd, h.sucios.map((s) => s.ruta));
  return h;
}

/**
 * Qué hicieron los demás en los archivos que estás tocando.
 * Sale de la información que git ya tiene local: no hace fetch, no usa red.
 */
function divergenciaUpstream(cwd, misArchivos) {
  const up = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!up) return null;

  const cuenta = git(cwd, ['rev-list', '--count', `HEAD..${up}`]);
  const adelante = parseInt(cuenta ?? '0', 10) || 0;
  if (adelante === 0) return { ref: up, adelante: 0, colisiones: [] };

  const tocados = git(cwd, ['diff', '--name-only', `HEAD..${up}`]) ?? '';
  const suyos = new Set(tocados.split('\n').filter(Boolean));
  const colisiones = misArchivos.filter((r) => suyos.has(r));
  return { ref: up, adelante, colisiones };
}

/**
 * Comandos ejecutados y su resultado, leídos del transcript desde la marca de
 * agua anterior. Solo se lee el delta: el costo no crece con la sesión.
 */
export function hechosTranscript(rutaTranscript, desdeOffset = 0, config = null) {
  const res = { comandos: [], archivosLeidos: [], ultimoMensaje: null, offset: desdeOffset, turnos: 0 };
  if (!rutaTranscript) return res;

  let bruto;
  try {
    const st = statSync(rutaTranscript);
    // Si el archivo se truncó o rotó, se relee desde el principio.
    const inicio = desdeOffset > st.size ? 0 : desdeOffset;
    const largo = st.size - inicio;
    res.offset = st.size;
    if (largo <= 0) return res;

    // Techo de lectura: un transcript enorme no puede hacernos pasar el
    // presupuesto de 1,5 s del hook Stop.
    const MAX = 8 * 1024 * 1024;
    const desde = largo > MAX ? st.size - MAX : inicio;
    const buf = Buffer.alloc(st.size - desde);
    const fd = openSync(rutaTranscript, 'r');
    try { readSync(fd, buf, 0, buf.length, desde); } finally { closeSync(fd); }
    bruto = buf.toString('utf8');
  } catch {
    return res;
  }

  for (const linea of bruto.split('\n')) {
    if (!linea.trim()) continue;
    let ev;
    try { ev = JSON.parse(linea); } catch { continue; }
    extraer(ev, res, config);
  }

  // Solo los últimos, para no inflar el relevo.
  res.comandos = res.comandos.slice(-12);
  res.archivosLeidos = [...new Set(res.archivosLeidos)].slice(-15);
  return res;
}

/**
 * Extrae de un evento del transcript. Defensivo a propósito: cada CLI tiene
 * su propia forma y ninguno prometió mantenerla entre versiones. Ante un
 * formato desconocido se ignora el evento en lugar de fallar.
 */
function extraer(ev, res, config) {
  // Antigravity: pasos con step_index, type y content en texto plano.
  if (ev.step_index !== undefined || ev.stepIndex !== undefined) {
    return extraerPaso(ev, res, config);
  }
  // Codex: envoltorio {timestamp, ordinal, type, payload}.
  if (ev.payload !== undefined && ev.ordinal !== undefined) {
    return extraerRollout(ev, res, config);
  }

  const tipo = ev.type ?? ev.role ?? ev.kind;
  if (tipo === 'assistant' || tipo === 'user') res.turnos++;

  const bloques = [];
  const msg = ev.message ?? ev;
  if (Array.isArray(msg?.content)) bloques.push(...msg.content);
  else if (Array.isArray(ev.content)) bloques.push(...ev.content);

  for (const b of bloques) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'tool_use' && b.name) {
      const inp = b.input ?? {};
      if (/^bash$|^shell$|^run/i.test(b.name) && inp.command) {
        const { texto } = redactar(lineaSignificativa(String(inp.command)), config);
        res.comandos.push({ cmd: texto, id: b.id, exit: null });
      } else if (/^read$|^view$/i.test(b.name) && (inp.file_path ?? inp.path)) {
        const r = String(inp.file_path ?? inp.path);
        if (!rutaExcluida(r, config)) res.archivosLeidos.push(r);
      }
    }

    // Resultado del comando: se busca el exit code, nunca el stdout.
    if (b.type === 'tool_result') {
      const c = res.comandos.find((x) => x.id === b.tool_use_id);
      if (c) c.exit = b.is_error ? 1 : exitDe(b) ?? 0;
    }

    if (b.type === 'text' && typeof b.text === 'string' && tipo === 'assistant') {
      res.ultimoMensaje = b.text;
    }
  }

  if (typeof ev.last_assistant_message === 'string') res.ultimoMensaje = ev.last_assistant_message;
}

/**
 * Un paso del transcript de Antigravity.
 *
 * Formato verificado contra una sesión real: cada línea es un paso con
 * step_index, source, type, status, created_at y content. Los tipos vistos son
 * USER_INPUT, PLANNER_RESPONSE y los de herramientas (run_command y afines).
 * El contenido es texto plano, no bloques estructurados, así que los comandos
 * se extraen del texto en lugar de leer campos.
 */
function extraerPaso(ev, res, config) {
  const tipo = String(ev.type ?? '').toUpperCase();
  const contenido = typeof ev.content === 'string' ? ev.content : '';

  if (tipo === 'USER_INPUT' || tipo === 'PLANNER_RESPONSE') res.turnos++;

  if (tipo === 'PLANNER_RESPONSE' && contenido) {
    res.ultimoMensaje = contenido;
  }

  if (/RUN_COMMAND|COMMAND|TERMINAL/.test(tipo)) {
    // El comando aparece como CommandLine en el contenido, o como primera
    // línea útil si viene en texto libre.
    const m = /"?CommandLine"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    const bruto = m ? m[1] : contenido;
    const { texto } = redactar(lineaSignificativa(bruto), config);
    if (texto) {
      const fallo = /FAILED|ERROR/.test(String(ev.status ?? '')) || /exit (?:code )?[1-9]/i.test(contenido);
      res.comandos.push({ cmd: texto, id: ev.step_index ?? null, exit: fallo ? 1 : 0 });
    }
  }

  if (/VIEW_FILE|READ_FILE/.test(tipo)) {
    const m = /"?(?:AbsolutePath|path|file)"?\s*[:=]\s*"?([^"\n]+)/i.exec(contenido);
    if (m && !rutaExcluida(m[1], config)) res.archivosLeidos.push(m[1].trim());
  }
}

/**
 * Un registro del rollout de Codex.
 *
 * Formato verificado contra una sesión real: cada línea envuelve un payload
 * en {timestamp, ordinal, type, payload}. Los tipos que informan son
 * `response_item` (mensajes y llamadas a herramientas) y `event_msg`
 * (task_started, item_completed, task_complete).
 */
function extraerRollout(ev, res, config) {
  const p = ev.payload ?? {};
  const tipo = String(p.type ?? '');

  if (ev.type === 'event_msg' && tipo === 'task_started') res.turnos++;

  if (ev.type === 'event_msg' && tipo === 'task_complete' && p.last_agent_message) {
    res.ultimoMensaje = String(p.last_agent_message);
  }

  if (ev.type === 'response_item' && tipo === 'message') {
    res.turnos++;
    if (p.role === 'assistant') {
      const txt = textoDe(p.content);
      if (txt) res.ultimoMensaje = txt;
    }
  }

  // Llamadas a herramientas: aparecen como response_item con tipos de
  // function/tool call, o anidadas en item_completed.
  const item = tipo === 'item_completed' ? (p.item ?? {}) : p;
  const nombre = String(item.name ?? item.type ?? '');

  if (/shell|command|exec|bash/i.test(nombre)) {
    const args = item.arguments ?? item.input ?? item.command ?? '';
    const bruto = typeof args === 'string' ? args : JSON.stringify(args);
    const m = /"?command"?\s*:\s*(\[[^\]]*\]|"[^"]*")/i.exec(bruto);
    let linea = bruto;
    if (m) {
      try {
        const v = JSON.parse(m[1]);
        linea = Array.isArray(v) ? v.join(' ') : String(v);
      } catch { linea = m[1]; }
    }
    const { texto } = redactar(lineaSignificativa(linea), config);
    if (texto) {
      const fallo = /error|fail/i.test(String(item.status ?? ''));
      res.comandos.push({ cmd: texto, id: item.id ?? ev.ordinal, exit: fallo ? 1 : 0 });
    }
  }
}

function textoDe(contenido) {
  if (typeof contenido === 'string') return contenido;
  if (!Array.isArray(contenido)) return null;
  for (const b of contenido) {
    if (typeof b === 'string') return b;
    if (b && typeof b.text === 'string') return b.text;
  }
  return null;
}

function exitDe(b) {
  const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
  const m = /exit (?:code|status)[: ]+(\d+)/i.exec(txt);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * De un comando de varias líneas, la que dice qué se hizo.
 * Tomar la primera línea a secas dejaba el relevo lleno de `cd ...` y
 * `set -e`, que no informan nada de lo que pasó en la sesión.
 */
function lineaSignificativa(comando) {
  const RUIDO = /^\s*(cd\s|set\s+-|export\s|source\s|\.\s|#|echo\s+"?===|if\s|fi$|then$|else$|done$|do$)/i;
  const lineas = comando.split('\n').map((l) => l.trim()).filter(Boolean);
  const util = lineas.find((l) => !RUIDO.test(l));
  let elegida = util ?? lineas[0] ?? '';
  // `cd <ruta> && comando` es el patrón más común de todos: lo que informa
  // es el comando, no el directorio.
  elegida = elegida.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/i, '');
  return elegida.slice(0, 160);
}

/**
 * El archivo de destino, cuando git informa un renombre.
 *
 * `--numstat` usa `viejo.txt => nuevo.txt`, y con prefijo común
 * `src/{viejo.txt => nuevo.txt}`. Sin desarmarlo, el relevo mostraba el
 * renombre como un archivo llamado "viejo.txt => nuevo.txt" **y además**
 * el destino por separado: dos entradas para un solo archivo, una con un
 * nombre que no existe.
 */
function destinoDeRenombre(bruto) {
  if (!bruto) return null;
  const s = bruto.trim();
  if (!s.includes('=>')) return s;

  // Forma con llaves: prefijo{antes => después}sufijo
  const conLlaves = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(s);
  if (conLlaves) {
    const [, pre, , despues, post] = conLlaves;
    return (pre + despues + post).replace(/\/{2,}/g, '/');
  }
  // Forma simple: antes => después
  return s.split('=>').pop().trim();
}

function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
