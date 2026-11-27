// Tests de la integración con OpenCode.
//
// OpenCode es distinto de los otros tres: no corre hooks de shell, carga un
// plugin JS dentro de su proceso, y no escribe transcript en disco. Por eso
// el contrato tiene dos partes: la forma de los mensajes que devuelve
// `client.session.messages()` (fixture `opencode.messages.json`) y la de los
// eventos y hooks que recibe el plugin (`opencode.events.json`). Ambas se
// tomaron de OpenCode 1.19.6 con contenido inventado; ver fixtures/README.md.
//
// Los tests que lanzan init o hooks usan un HOME descartable, con HOME,
// USERPROFILE y XDG_CONFIG_HOME redirigidos (AGENTS.md: ningún test toca el
// HOME real).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { transcriptFacts } from '../src/lib/transcript.mjs';
import { reduceMessages, reduceMessagesV2, chaskiPlugin, chaskiPluginV2, chaskiDefinition } from '../src/opencode.mjs';
import { promptPayload, PROMPT_HOOK_EVENTS } from '../src/lib/ask.mjs';
import { canonicalAgent } from '../src/lib/payload.mjs';
import { opencodeSupported } from '../src/commands/hook-config.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = join(AQUI, '..', 'src');
const FIX = join(AQUI, 'fixtures');
const mensajes = JSON.parse(readFileSync(join(FIX, 'opencode.messages.json'), 'utf8'));
const eventos = JSON.parse(readFileSync(join(FIX, 'opencode.events.json'), 'utf8'));
// OpenCode 2.x (verificado con 2.4.2): otra API de plugins y otra forma de mensajes.
const contextoV2 = JSON.parse(readFileSync(join(FIX, 'opencode-v2.context.json'), 'utf8'));
const eventosV2 = JSON.parse(readFileSync(join(FIX, 'opencode-v2.events.json'), 'utf8'));
const limpiar = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

describe('contrato de mensajes: OpenCode', () => {
  const jsonl = reduceMessages(mensajes);
  const r = transcriptFacts({ id: 'opencode:ses_fixture', content: jsonl }, 0, {});

  test('un mensaje por línea, y el asistente sin terminar no entra', () => {
    const lineas = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lineas.length, 4, 'entró el mensaje del asistente que todavía corre');
    assert.deepEqual(lineas.map((l) => l.info.role), ['user', 'assistant', 'assistant', 'user']);
  });

  test('la reducción no arrastra salidas de herramientas ni razonamiento', () => {
    assert.doesNotMatch(jsonl, /On branch main|2 failing|export function firmar/, 'se coló stdout de una herramienta');
    assert.doesNotMatch(jsonl, /Voy a correr los tests/, 'se coló el razonamiento');
    // Caso positivo de lo anterior: esas cadenas sí están en el fixture.
    assert.match(JSON.stringify(mensajes), /On branch main/);
    assert.match(JSON.stringify(mensajes), /Voy a correr los tests/);
  });

  test('la reducción es determinista: misma entrada, mismos bytes', () => {
    assert.equal(reduceMessages(structuredClone(mensajes)), jsonl);
  });

  test('extrae los comandos bash con su código de salida', () => {
    assert.deepEqual(r.commands.map((c) => [c.cmd, c.exit]), [['git status', 0], ['npm test -- auth', 1]]);
  });

  test('cuenta turnos por mensaje escrito, no por parte sintética', () => {
    assert.equal(r.turns, 2);
    const soloSintetico = reduceMessages([{ info: { id: 'u', role: 'user' }, parts: [{ type: 'text', text: 'x', synthetic: true }] }]);
    assert.equal(transcriptFacts({ id: 'x', content: soloSintetico }, 0, {}).turns, 0);
  });

  test('registra los archivos leídos y la última respuesta', () => {
    assert.deepEqual(r.filesRead, ['/proyecto/src/auth/jwt.ts']);
    assert.match(r.lastMessage ?? '', /no rota el token/);
  });

  test('la marca de agua avanza y la segunda lectura no repite nada', () => {
    assert.equal(r.offset, Buffer.byteLength(jsonl));
    const otra = transcriptFacts({ id: 'opencode:ses_fixture', content: jsonl }, r.offset, {}, null, r.commands);
    assert.equal(otra.turns, 0);
    assert.equal(otra.commands.length, 2);
    assert.ok(!otra.reset);
  });

  test('si el contenido cambió por debajo (deshacer), relee desde 0', () => {
    const corto = reduceMessages(mensajes.slice(0, 1));
    const fuera = transcriptFacts({ id: 'x', content: corto }, r.offset, {});
    assert.ok(fuera.reset, 'una marca más allá del final no reinició');
    const desalineada = transcriptFacts({ id: 'x', content: jsonl }, 5, {});
    assert.ok(desalineada.reset, 'una marca a mitad de línea no reinició');
    assert.equal(desalineada.turns, 2);
  });

  test('redacta secretos en los comandos', () => {
    const conSecreto = reduceMessages([{
      info: { id: 'a', role: 'assistant', time: { completed: 1 } },
      parts: [{ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', input: { command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"' }, metadata: { exit: 0 } } }],
    }]);
    const facts = transcriptFacts({ id: 'x', content: conSecreto }, 0, {});
    // Caso positivo: el secreto estaba en la entrada.
    assert.match(conSecreto, /sk-ant-api03-abcdef/);
    assert.doesNotMatch(facts.commands[0].cmd, /sk-ant-api03-abcdef/);
    assert.ok(facts.redactions > 0);
  });
});

describe('contrato de mensajes: OpenCode 2.x', () => {
  const jsonl = reduceMessagesV2(contextoV2);
  const r = transcriptFacts({ id: 'opencode:ses_v2', content: jsonl }, 0, {});

  test('produce el mismo JSONL común: usuario y asistente, sin `idle` ni el turno en curso', () => {
    const lineas = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lineas.map((l) => l.info.role), ['user', 'assistant', 'assistant', 'assistant', 'user']);
  });

  test('extrae los comandos de la herramienta `shell` con su código de salida', () => {
    assert.deepEqual(r.commands.map((c) => [c.cmd, c.exit]), [['git status', 0], ['npm test -- auth', 1]]);
  });

  test('read usa `input.path` y queda como archivo leído', () => {
    assert.deepEqual(r.filesRead, ['/proyecto/src/auth/jwt.ts']);
  });

  test('turnos y última respuesta, sin salidas de herramientas ni razonamiento', () => {
    assert.equal(r.turns, 2);
    assert.match(r.lastMessage ?? '', /no rota el token/);
    assert.doesNotMatch(jsonl, /On branch main|2 failing|Voy a correr/);
    // Caso positivo: esas cadenas sí están en el fixture.
    assert.match(JSON.stringify(contextoV2), /On branch main/);
  });

  test('la reducción es determinista', () => {
    assert.equal(reduceMessagesV2(structuredClone(contextoV2)), jsonl);
  });
});

describe('contrato de eventos: OpenCode 2.x', () => {
  test('el fin de turno es session.execution.succeeded con data.sessionID', () => {
    assert.equal(eventosV2['session.execution.succeeded'].data.sessionID, 'ses_v2');
  });

  test('una sesión hija trae parentID en ctx.session.get()', () => {
    assert.equal(eventosV2['session.get.child'].parentID, 'ses_v2');
    assert.equal(eventosV2['session.get'].parentID, undefined);
  });

  test('context y compaction traen system como lista de partes de texto', () => {
    for (const h of ['hook.context', 'hook.compaction']) {
      assert.ok(eventosV2[h].system.every((p) => p.type === 'text' && typeof p.text === 'string'), h);
    }
  });

  test('la definición sirve a las dos APIs: id + setup para 2.x, server para 1.x', () => {
    const d = chaskiDefinition({ node: process.execPath });
    assert.equal(d.id, 'chaski');
    assert.equal(typeof d.setup, 'function');
    assert.equal(typeof d.server, 'function');
  });
});

describe('contrato de eventos: OpenCode', () => {
  test('session.created trae el id de la sesión y, en un subagente, parentID', () => {
    assert.equal(eventos['session.created'].event.properties.info.id, 'ses_fixture');
    assert.equal(eventos['session.created.child'].event.properties.info.parentID, 'ses_fixture');
  });

  test('session.idle trae sessionID: es el Stop', () => {
    assert.equal(typeof eventos['session.idle'].event.properties.sessionID, 'string');
  });

  test('chat.message y system.transform traen sessionID, y system es un arreglo', () => {
    assert.equal(typeof eventos['chat.message'].input.sessionID, 'string');
    assert.ok(Array.isArray(eventos['experimental.chat.system.transform'].output.system));
  });

  test('la petición de narrativa usa el formato de UserPromptSubmit', () => {
    assert.equal(canonicalAgent('opencode'), 'opencode');
    assert.equal(PROMPT_HOOK_EVENTS.opencode, 'UserPromptSubmit');
    assert.equal(promptPayload('opencode', 'x').hookSpecificOutput.additionalContext, 'x');
  });
});

/** Proyecto git y HOME de usar y tirar. */
function montar(prefijo, version = '1.19.6') {
  const raiz = mkdtempSync(join(tmpdir(), prefijo));
  const proyecto = join(raiz, 'proyecto');
  const casa = join(raiz, 'casa');
  const bin = join(raiz, 'bin');
  for (const d of [proyecto, casa, bin]) mkdirSync(d, { recursive: true });
  const win = process.platform === 'win32';
  // Un OpenCode falso que solo sabe responder `--version`.
  if (win) writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\necho ${version}\r\nexit /b 0\r\n`);
  else writeFileSync(join(bin, 'opencode'), `#!/bin/sh\necho ${version}\nexit 0\n`, { mode: 0o755 });
  const g = (...args) => execFileSync('git', args, { cwd: proyecto, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(proyecto, 'app.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'inicial');
  const sep = win ? ';' : ':';
  const entorno = {
    ...process.env,
    HOME: casa,
    USERPROFILE: casa,
    CODEX_HOME: join(casa, '.codex'),
    XDG_CONFIG_HOME: join(casa, '.config'),
    PATH: bin + sep + process.env.PATH,
    Path: bin + sep + (process.env.Path ?? process.env.PATH),
  };
  const plugin = join(casa, '.config', 'opencode', 'plugins', 'chaski.js');
  return { raiz, proyecto, casa, entorno, plugin };
}

describe('instalación del plugin de OpenCode', () => {
  test('init lo instala, es idempotente, doctor lo reconoce y uninstall lo quita', () => {
    const m = montar('chaski-oc-init-');
    try {
      const correr = (...a) => execFileSync(process.execPath, [join(SRC, 'cli.mjs'), ...a], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      assert.match(correr('init'), /opencode\s+plugin instalado/);
      const texto = readFileSync(m.plugin, 'utf8');
      assert.match(texto, /import \{ chaskiDefinition \} from "file:/);
      assert.ok(!existsSync(m.plugin + '.chaski-backup'), 'dejó un respaldo en la carpeta de plugins');
      assert.match(correr('init'), /opencode\s+ya configurado/);
      assert.match(correr('doctor'), /opencode\s+registrado \(SessionStart, UserPromptSubmit, Stop, PreCompact\)/);
      correr('uninstall');
      assert.ok(!existsSync(m.plugin), 'uninstall no quitó el plugin');
    } finally {
      limpiar(m.raiz);
    }
  });

  test('con un OpenCode anterior al mínimo no instala y doctor lo dice', () => {
    const m = montar('chaski-oc-viejo-', '1.18.28');
    try {
      const correr = (...a) => execFileSync(process.execPath, [join(SRC, 'cli.mjs'), ...a], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      assert.match(correr('init'), /opencode\s+1\.18\.28 no soportada \(mínimo 1\.18\.29\)/);
      assert.ok(!existsSync(m.plugin), 'instaló un plugin que esa versión no puede cargar');
      const doc = correr('doctor');
      assert.match(doc, /opencode\s+1\.18\.28 no soportada/);
      assert.doesNotMatch(doc, /opencode: hooks registrados pero nunca ejecutados/);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('con OpenCode 2.x instala el mismo plugin (la definición sirve a las dos APIs)', () => {
    // Formato de `opencode --version` en 2.x: «opencode v2.4.2».
    const m = montar('chaski-oc-v2-', 'opencode v2.4.2');
    try {
      const correr = (...a) => execFileSync(process.execPath, [join(SRC, 'cli.mjs'), ...a], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      assert.match(correr('init'), /opencode\s+plugin instalado/);
      assert.match(readFileSync(m.plugin, 'utf8'), /^export default chaskiDefinition\(/m);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('opencodeSupported compara contra 1.18.29 y acepta una versión ilegible', () => {
    assert.equal(opencodeSupported([1, 18, 28]), false);
    assert.equal(opencodeSupported([1, 18, 29]), true);
    assert.equal(opencodeSupported([1, 19, 0]), true);
    assert.equal(opencodeSupported([1, 9, 99]), false);
    assert.equal(opencodeSupported([2, 0, 0]), true);
    assert.equal(opencodeSupported(null), true);
  });

  test('no pisa ni borra un chaski.js que no generó chaski', () => {
    const m = montar('chaski-oc-ajeno-');
    try {
      mkdirSync(dirname(m.plugin), { recursive: true });
      const ajeno = 'export const Mio = async () => ({});\n';
      writeFileSync(m.plugin, ajeno);
      const r = spawnSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /opencode\s+FALLÓ: .*no lo generó chaski/);
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'uninstall'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      assert.equal(readFileSync(m.plugin, 'utf8'), ajeno);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('una captura normal con opencode no deja nada en stderr', () => {
    const m = montar('chaski-oc-stderr-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 42;\n');
      const r = spawnSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'opencode'], {
        cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'ses_fixture', cwd: m.proyecto, transcript_inline: reduceMessages(mensajes) }),
      });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '', `el hook se tragó un error propio: ${r.stderr.trim()}`);
    } finally {
      limpiar(m.raiz);
    }
  });
});

describe('el plugin de punta a punta, con un cliente falso', () => {
  // El plugin lanza `node` con el entorno del proceso: el HOME descartable se
  // pone en process.env mientras dura el test y se devuelve al terminar.
  async function conEntorno(m, fn) {
    const claves = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'XDG_CONFIG_HOME'];
    const antes = Object.fromEntries(claves.map((k) => [k, process.env[k]]));
    for (const k of claves) process.env[k] = m.entorno[k];
    try {
      return await fn();
    } finally {
      for (const k of claves) {
        if (antes[k] === undefined) delete process.env[k];
        else process.env[k] = antes[k];
      }
    }
  }

  const cliente = (msgs, padres = {}) => ({
    session: {
      messages: async () => ({ data: msgs }),
      get: async ({ path }) => ({ data: { id: path.id, ...(padres[path.id] ? { parentID: padres[path.id] } : {}) } }),
    },
  });

  test('Stop escribe el relevo y el siguiente arranque lo inyecta en el system prompt', async () => {
    const m = montar('chaski-oc-e2e-');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      // El archivo que init generó, importado como lo haría OpenCode.
      const Chaski = (await import(pathToFileURL(m.plugin).href + '?t=' + Date.now())).default.server;
      await conEntorno(m, async () => {
        const hooks = await Chaski({ client: cliente(mensajes), directory: m.proyecto });
        await hooks.event(eventos['session.idle']);

        const ramas = readdirSync(join(m.proyecto, '.tambo', 'branches'));
        const estado = JSON.parse(readFileSync(join(m.proyecto, '.tambo', 'branches', ramas[0], 'estado.json'), 'utf8'));
        assert.equal(estado.agent, 'opencode');
        assert.equal(estado.transcript, 'opencode:ses_fixture');
        assert.deepEqual(estado.commands.map((c) => c.cmd), ['git status', 'npm test -- auth']);
        assert.equal(estado.turns, 2);

        // Sesión nueva: el relevo llega al system prompt, y no a la llamada del título.
        const nueva = await Chaski({ client: cliente(mensajes), directory: m.proyecto });
        await nueva.event({ event: { type: 'session.created', properties: { info: { id: 'ses_nueva' } } } });
        const salida = { system: ['base'] };
        await nueva['experimental.chat.system.transform']({ sessionID: 'ses_nueva' }, salida);
        // Un solo mensaje system (opencode#34243), con el texto de OpenCode delante.
        assert.equal(salida.system.length, 1, 'agregó un segundo mensaje system');
        assert.match(salida.system[0], /^base\n\n<<<RELEVO-CHASKI/);
        assert.match(salida.system[0], /npm test -- auth/);
        const titulo = structuredClone(eventos['experimental.chat.system.transform.title'].output);
        const original = titulo.system[0];
        await nueva['experimental.chat.system.transform']({ sessionID: 'ses_nueva' }, titulo);
        assert.deepEqual(titulo.system, [original], 'metió el relevo en la llamada que genera el título');
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  test('un subagente (sesión hija) ni recibe el relevo ni lo escribe', async () => {
    const m = montar('chaski-oc-hijo-');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      const Chaski = (await import(pathToFileURL(m.plugin).href + '?t=' + Date.now())).default.server;
      await conEntorno(m, async () => {
        const hooks = await Chaski({ client: cliente(mensajes, { ses_child: 'ses_fixture' }), directory: m.proyecto });
        await hooks.event(eventos['session.created.child']);
        await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
        assert.ok(!existsSync(join(m.proyecto, '.tambo', 'branches')), 'el subagente escribió un relevo');
        const salida = { system: ['base'] };
        await hooks['experimental.chat.system.transform']({ sessionID: 'ses_child' }, salida);
        assert.deepEqual(salida.system, ['base']);
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  test('la compactación recibe la instrucción de conservar el porqué', async () => {
    const m = montar('chaski-oc-compact-');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      const Chaski = (await import(pathToFileURL(m.plugin).href + '?t=' + Date.now())).default.server;
      await conEntorno(m, async () => {
        const hooks = await Chaski({ client: cliente(mensajes), directory: m.proyecto });
        const salida = structuredClone(eventos['experimental.session.compacting'].output);
        await hooks['experimental.session.compacting'](eventos['experimental.session.compacting'].input, salida);
        assert.equal(salida.context.length, 1);
        assert.match(salida.context[0], /^chaski: al resumir, conserva/);
        assert.match(salida.context[0], /qué se decidió/, 'se rompió la codificación de la salida');
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  /**
   * Bus de eventos falso con la forma de `ctx.event.subscribe()` de 2.x.
   * `emitir` se resuelve cuando el plugin terminó de procesar el evento: el
   * generador recién vuelve a pedir el siguiente después de eso.
   */
  function busFalso() {
    const pendientes = [];
    let tomar = null;
    let procesado = null;
    async function* subscribe() {
      while (true) {
        if (procesado) { const ok = procesado; procesado = null; ok(); }
        const ev = pendientes.length ? pendientes.shift() : await new Promise((r) => { tomar = r; });
        yield ev;
      }
    }
    const emitir = (ev) => new Promise((ok) => {
      procesado = ok;
      if (tomar) { const t = tomar; tomar = null; t(ev); } else pendientes.push(ev);
    });
    return { subscribe, emitir };
  }

  function ctxFalso(directorio, padres = {}) {
    const hooks = {};
    const bus = busFalso();
    const ctx = {
      location: { directory: directorio },
      session: {
        hook: async (nombre, fn) => { hooks[nombre] = fn; return { dispose: async () => {} }; },
        context: async () => structuredClone(contextoV2),
        get: async ({ sessionID }) => (padres[sessionID] ? { id: sessionID, parentID: padres[sessionID] } : { id: sessionID }),
      },
      event: { subscribe: bus.subscribe },
    };
    return { ctx, hooks, emitir: bus.emitir };
  }

  test('2.x: el fin de turno escribe el relevo, y context y compaction lo entregan', async () => {
    const m = montar('chaski-oc-v2e2e-', 'opencode v2.4.2');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      const def = (await import(pathToFileURL(m.plugin).href + '?t=' + Date.now())).default;
      await conEntorno(m, async () => {
        const a = ctxFalso(m.proyecto);
        await def.setup(a.ctx);
        assert.deepEqual(Object.keys(a.hooks).sort(), ['compaction', 'context', 'prompt']);
        await a.emitir(eventosV2['session.execution.succeeded']);

        const ramas = readdirSync(join(m.proyecto, '.tambo', 'branches'));
        const estado = JSON.parse(readFileSync(join(m.proyecto, '.tambo', 'branches', ramas[0], 'estado.json'), 'utf8'));
        assert.equal(estado.agent, 'opencode');
        assert.equal(estado.transcript, 'opencode:ses_v2');
        assert.deepEqual(estado.commands.map((c) => [c.cmd, c.exit]), [['git status', 0], ['npm test -- auth', 1]]);

        // Sesión nueva: el relevo llega como una parte de texto más, al final.
        const b = ctxFalso(m.proyecto);
        await def.setup(b.ctx);
        const antes = eventosV2['hook.context'].system.length;
        const ev2 = { ...structuredClone(eventosV2['hook.context']), sessionID: 'ses_nueva' };
        await b.hooks.context(ev2);
        assert.equal(ev2.system.length, antes + 1);
        assert.equal(ev2.system.at(-1).type, 'text');
        assert.match(ev2.system.at(-1).text, /<<<RELEVO-CHASKI[\s\S]*npm test -- auth/);

        const comp = { ...structuredClone(eventosV2['hook.compaction']), sessionID: 'ses_nueva' };
        await b.hooks.compaction(comp);
        assert.match(comp.system.at(-1).text, /^chaski: al resumir, conserva/);
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  test('2.x: una sesión hija ni recibe ni escribe el relevo', async () => {
    const m = montar('chaski-oc-v2hijo-', 'opencode v2.4.2');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], { cwd: m.proyecto, env: m.entorno, encoding: 'utf8' });
      const def = (await import(pathToFileURL(m.plugin).href + '?t=' + Date.now())).default;
      await conEntorno(m, async () => {
        const a = ctxFalso(m.proyecto, { ses_v2_child: 'ses_v2' });
        await def.setup(a.ctx);
        await a.emitir({ type: 'session.execution.succeeded', data: { sessionID: 'ses_v2_child' } });
        assert.ok(!existsSync(join(m.proyecto, '.tambo', 'branches')), 'el subagente escribió un relevo');
        const ev = { ...structuredClone(eventosV2['hook.context']), sessionID: 'ses_v2_child' };
        await a.hooks.context(ev);
        assert.equal(ev.system.length, eventosV2['hook.context'].system.length);
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  test('2.x: setup no lanza con un contexto incompleto', async () => {
    await chaskiPluginV2({ node: process.execPath })({});
    await chaskiPluginV2({ node: process.execPath })({ session: { hook: async () => { throw new Error('x'); } }, event: {} });
    await chaskiPluginV2({})({ session: { hook: async () => {} } });
    assert.ok(true);
  });

  test('los hooks no lanzan con entradas raras', async () => {
    const hooks = await chaskiPlugin({ node: process.execPath })({ client: {}, directory: tmpdir() });
    await hooks.event({});
    await hooks.event({ event: { type: 'session.idle', properties: {} } });
    await hooks['chat.message']({});
    await hooks['experimental.chat.system.transform']({ sessionID: 3 }, null);
    await hooks['experimental.session.compacting']({}, {});
    assert.deepEqual(await chaskiPlugin({})({}), {}, 'sin ruta de node el plugin debe quedar inerte');
  });
});
