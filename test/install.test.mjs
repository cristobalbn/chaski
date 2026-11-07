// Tests de instalación y de concurrencia.
//
// Están aparte de core.test.mjs porque lanzan procesos y manipulan un HOME
// falso: son más lentos y tienen otra forma de montarse.
//
// Verifican dos promesas del diseño que hasta ahora no tenían prueba:
//
//   1. `uninstall` revierte cada configuración desde su respaldo. Poder sacar
//      la herramienta sin miedo es la condición para animarse a ponerla, así
//      que esa promesa necesita sostén.
//   2. El lock deja el relevo válido con varios escritores a la vez. Pasa de
//      verdad: subagents en paralelo, o dos CLIs abiertos en el mismo repo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = join(AQUI, '..', 'src');

/**
 * CLIs de mentira en un directorio propio, para poner al frente del PATH.
 *
 * `init` solo registra hooks en los CLIs que detecta instalados, y en una
 * máquina de CI no hay ninguno. Sin esto los tests pasaban solo donde el
 * desarrollador tenía los tres — exactamente la clase de dependencia del
 * entorno que el CI encontró en su primera corrida.
 */
function clisDeMentira(dir) {
  mkdirSync(dir, { recursive: true });
  const win = process.platform === 'win32';
  for (const name of ['claude', 'codex', 'agy']) {
    if (win) {
      writeFileSync(join(dir, name + '.cmd'), '@echo off\r\nexit /b 0\r\n');
    } else {
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  return dir;
}

/** Un proyecto git de usar y tirar, con su propio HOME y sus CLIs falsos. */
function montar(prefijo) {
  const raiz = mkdtempSync(join(tmpdir(), prefijo));
  const proyecto = join(raiz, 'proyecto');
  const casa = join(raiz, 'casa');
  const bin = clisDeMentira(join(raiz, 'bin'));
  mkdirSync(proyecto, { recursive: true });
  mkdirSync(casa, { recursive: true });

  const g = (...args) => execFileSync('git', args, {
    cwd: proyecto, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(proyecto, 'app.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'inicial');

  const entorno = {
    ...process.env,
    HOME: casa,
    USERPROFILE: casa,
    // Los CLIs falsos van al frente, para que `isInstalled()` los encuentre.
    PATH: bin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
    Path: bin + (process.platform === 'win32' ? ';' : ':') + (process.env.Path ?? process.env.PATH),
  };
  const correr = (...args) => execFileSync(process.execPath,
    [join(SRC, 'cli.mjs'), ...args],
    { cwd: proyecto, env: entorno, encoding: 'utf8' });

  return { raiz, proyecto, casa, bin, g, entorno, correr };
}

describe('uninstall revierte lo que init tocó', () => {
  test('restaura la configuración de Claude Code byte a byte', () => {
    const m = montar('chaski-inst-');
    try {
      // Una configuración previa con cosas del usuario que no se deben perder.
      const dirClaude = join(m.casa, '.claude');
      mkdirSync(dirClaude, { recursive: true });
      const config = join(dirClaude, 'settings.json');
      const original = JSON.stringify({
        model: 'opus',
        theme: 'dark',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'mi-propio-hook.sh' }] }],
        },
      }, null, 2);
      writeFileSync(config, original);

      m.correr('init');
      const trasInit = readFileSync(config, 'utf8');
      assert.ok(trasInit.includes('chaski'), 'init no registró nada');
      assert.ok(trasInit.includes('mi-propio-hook.sh'),
        'init pisó un hook que no era suyo');
      assert.ok(existsSync(config + '.chaski-backup'), 'no dejó respaldo');

      m.correr('uninstall');
      assert.equal(readFileSync(config, 'utf8'), original,
        'uninstall no devolvió la configuración a su estado original');
      assert.ok(!existsSync(config + '.chaski-backup'),
        'dejó el respaldo tirado después de restaurar');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('si no había configuración, uninstall no deja hooks de chaski', () => {
    const m = montar('chaski-inst2-');
    try {
      m.correr('init');
      m.correr('uninstall');
      const config = join(m.casa, '.claude', 'settings.json');
      if (existsSync(config)) {
        assert.ok(!readFileSync(config, 'utf8').includes('chaski'),
          'quedaron hooks de chaski tras desinstalar');
      }
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('init es idempotente: no duplica hooks', () => {
    const m = montar('chaski-idem-');
    try {
      m.correr('init');
      const unaVez = readFileSync(join(m.casa, '.claude', 'settings.json'), 'utf8');
      m.correr('init');
      m.correr('init');
      const tresVeces = readFileSync(join(m.casa, '.claude', 'settings.json'), 'utf8');
      const contar = (t) => (t.match(/capturar\.mjs/g) || []).length;
      assert.equal(contar(tresVeces), contar(unaVez),
        'correr init de nuevo duplicó los hooks');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('init agrega .tambo/ al .gitignore y no lo duplica', () => {
    const m = montar('chaski-ign-');
    try {
      writeFileSync(join(m.proyecto, '.gitignore'), 'node_modules/\n');
      m.correr('init');
      m.correr('init');
      const ign = readFileSync(join(m.proyecto, '.gitignore'), 'utf8');
      assert.ok(ign.includes('node_modules/'), 'pisó el .gitignore del usuario');
      assert.equal((ign.match(/^\.tambo\/$/gm) || []).length, 1,
        'duplicó la línea de .tambo/');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('no destruye una configuración que no puede parsear', () => {
    // El peor bug que tuvo el proyecto: un settings.json con una coma final,
    // un comentario o un BOM hacía que init lo reemplazara por completo. El
    // usuario perdía model, theme y permissions en el primer comando que
    // corría, y es el camino que recorre todo usuario nuevo.
    const m = montar('chaski-destruir-');
    try {
      const dir = join(m.casa, '.claude');
      mkdirSync(dir, { recursive: true });
      const config = join(dir, 'settings.json');
      // Coma final: JSON inválido, y un error de tipeo muy común.
      const original = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(npm:*)"] },\n}\n';
      writeFileSync(config, original);

      let fallo = false;
      try { m.correr('init'); } catch { fallo = true; }

      assert.equal(readFileSync(config, 'utf8'), original,
        'init modificó una configuración que no pudo parsear');
      assert.ok(fallo, 'init no avisó de que la configuración estaba mal');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('tolera un BOM en la configuración', () => {
    // Frecuente en Windows: un editor guarda el JSON con marca de orden de
    // bytes y JSON.parse no la tolera. Sin esto, init abortaría sobre una
    // configuración que en realidad es válida.
    const m = montar('chaski-bom-');
    try {
      const dir = join(m.casa, '.claude');
      mkdirSync(dir, { recursive: true });
      const config = join(dir, 'settings.json');
      writeFileSync(config, '﻿{ "model": "opus" }\n', 'utf8');

      m.correr('init');
      const tras = readFileSync(config, 'utf8');
      assert.ok(tras.includes('opus'), 'perdió la configuración del usuario');
      assert.ok(tras.includes('chaski'), 'no registró los hooks');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('doctor detecta CLIs de Windows aunque where no esté disponible', { skip: process.platform !== 'win32' }, () => {
    const m = montar('chaski-path-');
    try {
      const env = { ...m.entorno, PATH: m.bin, Path: m.bin };
      const run = () => execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'doctor'], {
        cwd: m.proyecto, env, encoding: 'utf8',
      });
      const installed = run();
      for (const name of ['claude code', 'codex', 'agy']) {
        assert.doesNotMatch(installed, new RegExp(name + '\\s+no instalado'));
      }
      rmSync(join(m.bin, 'agy.cmd'));
      assert.match(run(), /agy\s+no instalado/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('doctor no falla en un proyecto recién inicializado', () => {
    const m = montar('chaski-doc-');
    try {
      m.correr('init');
      const salida = m.correr('doctor');
      assert.match(salida, /CLIs y hooks/);
      assert.match(salida, /Qué sale de esta máquina/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('probe', () => {
  // `probe` no tenía NINGÚN test. Un identificador renombrado a medias en
  // probePath(), probeLogPath(), backupForProbe(), probeCmd(), probeShow() o
  // probeClean() revienta con ReferenceError en los tres CLIs y nadie lo
  // notaba hasta que alguien lo corría a mano. Este test ejercita cada
  // subcomando -- la rama poco transitada del instalador -- de punta a punta.
  test('instala la sonda, la muestra y la limpia sin reventar en ningún subcomando', () => {
    const m = montar('chaski-probe-');
    try {
      const salidaInstalar = m.correr('probe');
      assert.match(salidaInstalar, /sonda instalada/, 'probe no instaló la sonda en ningún CLI');

      // Antes de que algo la invoque, --show debe avisar, no reventar.
      const salidaVacio = m.correr('probe', '--show');
      assert.match(salidaVacio, /No se capturó nada/);

      // Simula exactamente lo que haría un hook real: invoca la sonda que
      // probe() acaba de escribir, con los mismos argumentos que pondría un
      // CLI (event y agent).
      const sondaPath = join(m.casa, '.chaski', 'sonda.mjs');
      assert.ok(existsSync(sondaPath), 'probe no dejó escrita la sonda en ~/.chaski/');
      execFileSync(process.execPath, [sondaPath, 'SessionStart', 'claude-code'],
        { env: m.entorno, encoding: 'utf8', input: '{"cwd":"x"}' });

      const salidaShow = m.correr('probe', '--show');
      assert.match(salidaShow, /SessionStart/, 'show no mostró el event capturado');
      assert.match(salidaShow, /claude-code/, 'show no mostró el agent capturado');

      // --clean recorre los tres formatos de config (json-claude, toml-codex,
      // json-agy): es la rama que más identificadores renombrados a medias
      // puede esconder, porque nadie la mira en el uso normal.
      const salidaLimpiar = m.correr('probe', '--clean');
      assert.match(salidaLimpiar, /sonda removida|restaurado/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('probe --show sin sonda instalada no revienta', () => {
    const m = montar('chaski-probe-show-');
    try {
      const salida = m.correr('probe', '--show');
      assert.match(salida, /No se capturó nada/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('subcomando desconocido', () => {
  test('no revienta: imprime el uso y marca error de salida', () => {
    const m = montar('chaski-sub-raro-');
    try {
      let fallo = false;
      try { m.correr('lo-que-sea'); } catch { fallo = true; }
      assert.ok(fallo, 'un subcomando inválido no marcó error de salida');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('la documentación no promete lo que no existe', () => {
  // Automatiza una revisión que hasta ahora era manual y por eso se escapaba:
  // tras renombrar `--ver` a `--show` quedaron cuatro referencias viejas en el
  // README y en la propia ayuda del comando.
  const raiz = join(AQUI, '..');
  const leer = (f) => readFileSync(join(raiz, f), 'utf8');

  test('cada comando y flag del README existe en el código', () => {
    const instalador = leer('src/cli.mjs');
    const docs = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'].map(leer).join('\n');

    const subcomandos = [...instalador.matchAll(/accion === '(\w+)'/g)].map((m) => m[1]);
    const flags = [...instalador.matchAll(/'--(\w+)'/g)].map((m) => m[1]);

    // Al revés de lo intuitivo: se parte del código y se verifica la doc. Un
    // comando sin documentar es un hueco, pero un comando documentado que no
    // existe hace perder el tiempo a quien lo copia.
    for (const sub of subcomandos) {
      assert.ok(docs.includes(`chaski ${sub}`) || docs.includes(`cli.mjs ${sub}`),
        `el subcomando "${sub}" no aparece en la documentación`);
    }

    // Y ninguna doc puede mencionar un flag que ya no existe.
    const mencionados = [...docs.matchAll(/chaski probe --(\w+)/g)].map((m) => m[1]);
    for (const f of mencionados) {
      assert.ok(flags.includes(f), `la documentación menciona --${f}, que no existe`);
    }
  });

  test('las claves de configuración del README son las que el código lee', () => {
    const fuente = ['src/capture.mjs', 'src/lib/secrets.mjs', 'src/lib/paths.mjs']
      .map(leer).join('\n');
    const readme = leer('README.md');

    // Las claves que el README documenta en su tabla de configuración.
    const documentadas = [...readme.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    const deConfig = documentadas.filter((k) =>
      /redact|exclude|prune|limpiar/i.test(k));

    assert.ok(deConfig.length >= 3, 'la tabla de configuración del README quedó vacía');
    for (const clave of deConfig) {
      assert.ok(fuente.includes(clave),
        `el README documenta la clave "${clave}" y el código no la lee`);
    }
  });

  test('la API pública no tiene caracteres fuera de ASCII', () => {
    // git escapa en octal cualquier ruta con acentos, y eso ya produjo un bug.
    // La regla vale para flags, claves y nombres de archivo generados.
    const instalador = leer('src/cli.mjs');
    const identificadores = [
      ...[...instalador.matchAll(/accion === '([^']+)'/g)].map((m) => m[1]),
      ...[...instalador.matchAll(/'--([^']+)'/g)].map((m) => m[1]),
      ...[...leer('src/capture.mjs').matchAll(/config\?\.(\w+)/g)].map((m) => m[1]),
    ];
    for (const id of identificadores) {
      assert.ok(/^[\x20-\x7e]+$/.test(id), `"${id}" tiene caracteres no ASCII`);
    }
  });
});

describe('promoción de subagents', () => {
  const montarConPadre = (prefijo) => {
    const m = montar(prefijo);
    const transcript = join(m.proyecto, 'padre.jsonl');
    writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'el padre trabajó' }] },
    }) + '\n');
    const capturar = (payload) => execFileSync(process.execPath,
      [join(SRC, 'capture.mjs'), payload.hook_event_name ?? 'Stop', 'claude-code'],
      { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: JSON.stringify(payload) });
    capturar({ cwd: m.proyecto, session_id: 'padre', transcript_path: transcript, hook_event_name: 'Stop' });
    const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
    const leerEstado = () => JSON.parse(readFileSync(
      join(m.proyecto, '.tambo', 'branches', rama, 'estado.json'), 'utf8'));
    const leerRelevo = () => readFileSync(
      join(m.proyecto, '.tambo', 'branches', rama, 'relevo.md'), 'utf8');
    return { ...m, capturar, leerEstado, leerRelevo, transcript };
  };

  test('promueve la conclusión y avisa si el subagente no terminó', () => {
    const m = montarConPadre('chaski-sub-');
    try {
      m.capturar({
        cwd: m.proyecto, session_id: 'padre', hook_event_name: 'SubagentStop',
        agent_id: 'sub-1', agent_type: 'Explore', stop_reason: 'end_turn',
        last_assistant_message: 'El bug está en refresh.ts: no invalida el token viejo.',
      });
      m.capturar({
        cwd: m.proyecto, session_id: 'padre', hook_event_name: 'SubagentStop',
        agent_id: 'sub-2', agent_type: 'general-purpose', stop_reason: 'max_turns',
        last_assistant_message: 'Convertí 3 de 12 archivos y me quedé sin turns.',
      });

      const e = m.leerEstado();
      assert.equal(e.subagents.length, 2);
      assert.equal(e.subagents[0].kind, 'Explore');
      assert.equal(e.subagents[0].reason, null, 'end_turn no debería marcarse como razón');
      assert.equal(e.subagents[1].reason, 'max_turns');

      const md = m.leerRelevo();
      assert.match(md, /Trabajo delegado/);
      assert.match(md, /refresh\.ts/);
      assert.match(md, /puede no haber acabado/,
        'no avisó de que un subagente se quedó sin turns');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('no corrompe la marca de agua del padre', () => {
    // El bug que esto previene: la captura normal leería el transcript DEL
    // SUBAGENTE y dejaría su tamaño como marca de agua del padre, que en su
    // próximo turno leería desde la posición equivocada y perdería trabajo.
    const m = montarConPadre('chaski-sub-marca-');
    try {
      const antes = m.leerEstado();

      // Un transcript de subagente mucho más grande que el del padre.
      const delHijo = join(m.proyecto, 'hijo.jsonl');
      writeFileSync(delHijo, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      }) + '\n'.repeat(1));

      m.capturar({
        cwd: m.proyecto, session_id: 'padre', hook_event_name: 'SubagentStop',
        agent_id: 'sub-1', agent_type: 'Explore', stop_reason: 'end_turn',
        transcript_path: delHijo,
        last_assistant_message: 'Listo.',
      });

      const despues = m.leerEstado();
      assert.equal(despues.offset, antes.offset,
        'la promoción movió la marca de agua del padre');
      assert.equal(despues.transcript, antes.transcript,
        'la promoción cambió el transcript de referencia del padre');
      assert.equal(despues.turns, antes.turns,
        'la promoción contó los turns del subagente como del padre');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('los eventos de subagente que no son SubagentStop se descartan', () => {
    const m = montarConPadre('chaski-sub-ruido-');
    try {
      const antes = m.leerEstado();
      m.capturar({
        cwd: m.proyecto, session_id: 'padre', hook_event_name: 'Stop',
        agent_id: 'sub-1', transcript_path: m.transcript,
      });
      const despues = m.leerEstado();
      assert.equal(despues.writtenAt, antes.writtenAt,
        'un event intermedio de subagente reescribió el relevo del padre');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('sin relevo del padre no se crea uno desde un subagente', () => {
    const m = montar('chaski-sub-huerfano-');
    try {
      m.capturar = (payload) => execFileSync(process.execPath,
        [join(SRC, 'capture.mjs'), 'SubagentStop', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: JSON.stringify(payload) });
      m.capturar({
        cwd: m.proyecto, hook_event_name: 'SubagentStop', agent_id: 'sub-1',
        last_assistant_message: 'Algo',
      });
      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      assert.ok(!existsSync(join(m.proyecto, '.tambo', 'branches', rama, 'relevo.md')),
        'creó un relevo con la conclusión de un hijo y ningún hecho');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('redacta secretos de la conclusión', () => {
    const m = montarConPadre('chaski-sub-sec-');
    try {
      const token = ['sk', '-', 'a'.repeat(32)].join('');
      m.capturar({
        cwd: m.proyecto, session_id: 'padre', hook_event_name: 'SubagentStop',
        agent_id: 'sub-1', last_assistant_message: `Usé la clave ${token} para probar.`,
      });
      const todo = m.leerRelevo() + JSON.stringify(m.leerEstado());
      assert.ok(!todo.includes(token), 'se filtró un secreto desde un subagente');
      assert.match(todo, /redactado/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('concurrencia: varios escritores a la vez', () => {
  // De dónde viene cada garantía, que no es lo que parecía:
  //
  //   - La INTEGRIDAD del archivo la da la escritura atómica, no el lock. El
  //     `rename` es atómico en los tres sistemas, así que el relevo final
  //     siempre es el de alguno de los escritores y nunca uno a medio
  //     escribir. Se comprobó quitando el lock: este test seguía pasando.
  //   - El LOCK evita trabajo redundante y que un escritor pise los commands
  //     que otro acababa de agregar, porque el estado se lee, se modifica y
  //     se escribe, y eso no es atómico.
  //
  // El test cubre la garantía observable: ningún proceso falla, el resultado
  // es válido, no quedan temporales y el lock no queda tomado.
  test('el relevo queda válido y sin temporales sueltos', async () => {
    // Pasa de verdad: subagents en paralelo, o dos CLIs en el mismo repo.
    const m = montar('chaski-conc-');
    try {
      const transcript = join(m.proyecto, 'transcript.jsonl');
      writeFileSync(transcript, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'trabajando' }] },
      }) + '\n');

      const payload = JSON.stringify({
        cwd: m.proyecto,
        session_id: 'concurrente',
        transcript_path: transcript,
        hook_event_name: 'Stop',
      });

      const lanzar = () => new Promise((resolver) => {
        const p = spawn(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'test'],
          { cwd: m.proyecto, env: m.entorno, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('close', (codigo) => resolver(codigo));
        p.stdin.end(payload);
      });

      const codigos = await Promise.all(Array.from({ length: 8 }, lanzar));

      // Ningún escritor debe terminar en error, ni siquiera el que perdió el lock.
      assert.deepEqual([...new Set(codigos)], [0],
        `algún proceso falló: ${codigos.join(', ')}`);

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const dir = join(m.proyecto, '.tambo', 'branches', rama);

      const estado = JSON.parse(readFileSync(join(dir, 'estado.json'), 'utf8'));
      assert.ok(estado.writtenAt, 'el estado quedó incompleto');
      assert.ok(readFileSync(join(dir, 'relevo.md'), 'utf8').includes('# Relevo'),
        'el relevo quedó a medio escribir');

      const sueltos = readdirSync(dir).filter((f) => f.includes('.tmp'));
      assert.deepEqual(sueltos, [], `quedaron temporales: ${sueltos.join(', ')}`);

      // Y el lock no debe quedar tomado al terminar.
      assert.ok(!existsSync(join(m.proyecto, '.tambo', '.lock')),
        'el lock quedó tomado: la próxima captura se saltearía');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// --------------------------------------------- puntos de entrada estables

describe('puntos de entrada', () => {
  // `init` escribe la ruta absoluta de estos dos archivos en la configuración
  // de cada CLI, que vive fuera del repositorio. Renombrarlos rompe todas las
  // instalaciones existentes: el usuario ve un error de módulo no encontrado
  // en cada turno hasta que vuelva a correr `chaski init`. Ya pasó una vez, al
  // homologar los nombres a inglés (`capturar.mjs` -> `capture.mjs`).
  //
  // Este test existe para que ese cambio rompa la build en lugar de la máquina
  // de alguien. Si lo estás viendo fallar: no cambies el test, deshaz el
  // renombre.
  for (const nombre of ['capture.mjs', 'inject.mjs']) {
    test(`src/${nombre} conserva su nombre`, () => {
      assert.ok(existsSync(join(SRC, nombre)),
        `src/${nombre} no existe. Es un punto de entrada registrado en ` +
        `configuraciones externas: renombrarlo rompe a todo usuario instalado.`);
    });
  }

  test('cli.mjs registra exactamente esos dos scripts', () => {
    // Si alguien agrega un tercer punto de entrada, tiene que entrar también
    // en la lista de arriba y en el invariante 8 de AGENTS.md.
    const cli = readFileSync(join(SRC, 'cli.mjs'), 'utf8');
    const registrados = [...cli.matchAll(/resolve\(AQUI, '([\w.-]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(registrados)].sort(), ['capture.mjs', 'inject.mjs']);
  });
});

// ------------------------------------- puentes de los nombres viejos

describe('compatibilidad con los nombres de archivo viejos', () => {
  // `init` graba la ruta absoluta del script en la configuración de cada CLI,
  // que vive fuera del repositorio. Quien actualizó chaski desde una versión
  // anterior a la homologación al inglés tiene los hooks apuntando a
  // `capturar.mjs` y `leer.mjs`, y veía un volcado de Node en cada turno.
  // Los puentes hacen que esos nombres sigan funcionando. No se borran sin un
  // ciclo de deprecación: mientras alguien pueda tener la config vieja en
  // disco, borrarlos le rompe cada turno.

  test('capturar.mjs escribe el relevo igual que capture.mjs', () => {
    const m = montar('chaski-compat-cap-');
    try {
      const payload = JSON.stringify({
        session_id: 'compat-1', cwd: m.proyecto, hook_event_name: 'Stop',
      });
      const salida = execFileSync(process.execPath,
        [join(SRC, 'capturar.mjs'), 'Stop', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, input: payload, encoding: 'utf8' });

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const md = join(m.proyecto, '.tambo', 'branches', rama, 'relevo.md');
      assert.ok(existsSync(md), `el puente no escribió el relevo. stdout: ${salida}`);
      assert.match(readFileSync(md, 'utf8'), /# Relevo/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('leer.mjs inyecta el relevo y avisa solo por stderr', () => {
    // El aviso NO puede ir por stdout: lo que leer.mjs imprime por stdout
    // entra al contexto del agent, y una línea de más ahí es un dato falso.
    const m = montar('chaski-compat-leer-');
    try {
      const payload = JSON.stringify({
        session_id: 'compat-2', cwd: m.proyecto, hook_event_name: 'Stop',
      });
      execFileSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, input: payload, encoding: 'utf8' });

      const r = spawnSync(process.execPath, [join(SRC, 'leer.mjs'), 'SessionStart', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
          input: JSON.stringify({ cwd: m.proyecto }) });

      assert.equal(r.status, 0, 'el puente no debe fallar nunca');
      assert.match(r.stdout, /Relevo/, 'el puente no inyectó el relevo');
      assert.match(r.stderr, /chaski init/, 'no avisó de que la config está vieja');
      assert.ok(!r.stdout.includes('chaski init'),
        'el aviso se filtró a stdout: eso entra al contexto del agent como dato');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('los dos puentes existen con su nombre exacto', () => {
    for (const n of ['capturar.mjs', 'leer.mjs']) {
      assert.ok(existsSync(join(SRC, n)),
        `src/${n} es un puente de compatibilidad: borrarlo rompe cada turno a `
        + `quien tenga una configuración anterior a la homologación al inglés.`);
    }
  });
});

describe('grafía del agent', () => {
  // Un mismo CLI entraba con dos grafías: `cmd()` pasa `claude-code` como
  // argumento (el shell parte por espacio) y `detectAgent()` devuelve
  // `claude code`. El archivo de latidos acababa con dos claves para la misma
  // herramienta, y el encabezado del relevo cambiaba según el evento.
  test('capture normaliza el name venga con guión o con espacio', () => {
    const m = montar('chaski-grafia-');
    try {
      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      for (const [i, grafia] of ['claude-code', 'claude code'].entries()) {
        execFileSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', grafia], {
          cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
          input: JSON.stringify({ session_id: 'g' + i, cwd: m.proyecto, hook_event_name: 'Stop' }),
        });
      }

      const latidos = JSON.parse(readFileSync(join(m.casa, '.chaski', 'latidos.json'), 'utf8'));
      assert.deepEqual(Object.keys(latidos), ['claude code'],
        `quedó más de una clave para el mismo CLI: ${JSON.stringify(latidos)}`);

      const md = readFileSync(join(m.proyecto, '.tambo', 'branches', rama, 'relevo.md'), 'utf8');
      assert.match(md.split('\n')[0], /claude code/, 'el relevo quedó con la grafía del argumento');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// -------------------------------------- la skill, en los tres CLIs

describe('skill del relevo', () => {
  // Hasta esta versión la skill se instalaba solo en `.claude/skills/`, así que
  // Codex y Antigravity recibían el relevo pero no tenían cómo escribir la
  // narrativa de vuelta: el traspaso era simétrico para los hechos y
  // asimétrico para la intención, que es lo contrario de lo que promete la
  // herramienta. Los dos leen `.agents/skills/` con el mismo formato que
  // Claude Code, así que un archivo copiado dos veces cubre a los tres.

  test('init la deja en .claude/skills y en .agents/skills, idénticas al origen', () => {
    const m = montar('chaski-skill-');
    try {
      m.correr('init');
      const origen = readFileSync(join(SRC, '..', 'skill', 'SKILL.md'), 'utf8');

      for (const base of [['.claude', 'skills'], ['.agents', 'skills']]) {
        const ruta = join(m.proyecto, ...base, 'relevo', 'SKILL.md');
        assert.ok(existsSync(ruta), `falta la skill en ${base.join('/')}/relevo/`);
        assert.equal(readFileSync(ruta, 'utf8'), origen,
          `la copia en ${base.join('/')} no coincide con skill/SKILL.md`);
      }
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('init actualiza las copias de una skill ya instalada', () => {
    const m = montar('chaski-skill-update-');
    try {
      m.correr('init');
      const rutas = [
        join(m.proyecto, '.claude', 'skills', 'relevo', 'SKILL.md'),
        join(m.proyecto, '.agents', 'skills', 'relevo', 'SKILL.md'),
      ];
      for (const ruta of rutas) writeFileSync(ruta, 'skill anterior\n');
      m.correr('init');
      const origen = readFileSync(join(SRC, '..', 'skill', 'SKILL.md'), 'utf8');
      for (const ruta of rutas) assert.equal(readFileSync(ruta, 'utf8'), origen);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  for (const eol of ['\n', '\r\n']) {
    test(`init actualiza las peticiones sin perder notas del proyecto (${JSON.stringify(eol)})`, () => {
      const m = montar('chaski-requests-');
      try {
        const ruta = join(m.proyecto, 'AGENTS.md');
        // Una sección de una instalación anterior podía contener texto propio.
        const original = [
          '# Mi proyecto', '', 'Conservar los fixtures originales.', '',
          '## Relevo de contexto', '',
          'Este proyecto usa chaski para pasar contexto entre sesiones y entre CLIs.',
          'La narrativa debe explicar las decisiones del equipo.', '',
          '## Despliegue', '', 'El equipo publica los viernes.', '',
        ].join(eol);
        writeFileSync(ruta, original);
        m.correr('init');
        const actualizado = readFileSync(ruta, 'utf8');
        const bloque = /<!-- chaski:requests:start -->[\s\S]*?<!-- chaski:requests:end -->/;
        assert.match(actualizado, bloque, 'una sección antigua no recibió las nuevas peticiones');
        assert.equal(actualizado.replace(eol + eol + bloque.exec(actualizado)[0], ''), original,
          'init cambió texto ajeno al bloque de peticiones');

        // Una nueva versión solo puede sustituir su bloque, no toda la sección.
        writeFileSync(ruta, actualizado.replace(bloque,
          ['<!-- chaski:requests:start -->', 'Instrucciones de una versión anterior.',
            '<!-- chaski:requests:end -->'].join(eol)));
        m.correr('init');
        assert.equal(readFileSync(ruta, 'utf8'), actualizado);
        m.correr('init');
        assert.equal(readFileSync(ruta, 'utf8'), actualizado, 'repetir init duplica instrucciones');
      } finally {
        rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }

  test('init conserva un AGENTS.md previo sin sección de relevo', () => {
    const m = montar('chaski-agents-append-');
    try {
      const ruta = join(m.proyecto, 'AGENTS.md');
      const original = '# Proyecto\n\nNo publicar sin revisar.\n';
      writeFileSync(ruta, original);
      m.correr('init');
      const actualizado = readFileSync(ruta, 'utf8');
      assert.ok(actualizado.startsWith(original), 'se alteraron las instrucciones previas');
      assert.equal(actualizado.split('## Relevo de contexto').length, 2);
      assert.ok(actualizado.includes('<!-- chaski:requests:start -->'));
      m.correr('init');
      assert.equal(readFileSync(ruta, 'utf8'), actualizado);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('init rechaza marcadores dañados sin sobrescribir AGENTS.md', () => {
    const m = montar('chaski-requests-invalid-');
    try {
      const ruta = join(m.proyecto, 'AGENTS.md');
      for (const contenido of [
        '<!-- chaski:requests:start -->\nFalta el cierre.',
        '<!-- chaski:requests:end -->\nFalta el inicio.',
        '<!-- chaski:requests:end -->\n<!-- chaski:requests:start -->',
        '<!-- chaski:requests:start -->\n<!-- chaski:requests:start -->\n<!-- chaski:requests:end -->',
      ]) {
        writeFileSync(ruta, contenido);
        const r = spawnSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'], {
          cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
        });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /marcadores/);
        assert.equal(readFileSync(ruta, 'utf8'), contenido);
      }
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('el frontmatter trae name y description, que los tres exigen', () => {
    // Sin `name` o sin `description` la skill se ignora en silencio: no hay
    // error, simplemente no aparece en el menú de ningún CLI.
    const txt = readFileSync(join(SRC, '..', 'skill', 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(txt);
    assert.ok(fm, 'el SKILL.md no empieza con frontmatter YAML');
    assert.match(fm[1], /^name:\s*relevo\s*$/m, 'falta el campo name');
    assert.match(fm[1], /^description:\s*\S/m, 'falta el campo description');
  });

  test('las instrucciones no mandan editar relevo.md a mano', () => {
    // relevo.md lo regenera capture.mjs desde estado.json, y la firma lo
    // cubre: una edición a mano se pierde Y hace que el próximo agente reciba
    // un aviso de manipulación por algo legítimo. El bloque que init escribía
    // en AGENTS.md mandaba exactamente eso.
    const m = montar('chaski-skill-doc-');
    try {
      m.correr('init');
      const agents = readFileSync(join(m.proyecto, 'AGENTS.md'), 'utf8');
      const seccion = agents.slice(agents.indexOf('## Relevo de contexto'));
      assert.match(seccion, /estado\.json/, 'no dice dónde se escribe la narrativa');
      assert.match(seccion, /narrativeWrittenAt/, 'no nombra los campos exactos');
      assert.match(seccion, /No edites `relevo\.md`/i, 'no advierte de no editar relevo.md');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('init desde una carpeta contenedora NO deja nada en la contenedora', () => {
    // Este test invierte uno anterior, que exigía la skill y el AGENTS.md en
    // las dos carpetas. Se cambió con un motivo: una carpeta contenedora suele
    // tener varios proyectos dentro, y ahí la skill aplicaría a todos y el
    // AGENTS.md le hablaría de chaski a quien esté trabajando en otro
    // proyecto. El usuario lo vio como "se me ensució la carpeta".
    //
    // El agent abierto en la contenedora no queda sin recursos: los hooks son
    // de nivel de usuario, `projectDir()` resuelve el repositorio hijo, y el
    // texto de la petición automática trae las instrucciones completas para
    // escribir la narrativa sin skill.
    const m = montar('chaski-skill-parent-');
    try {
      execFileSync(process.execPath, [join(SRC, 'cli.mjs'), 'init'],
        { cwd: m.raiz, env: m.entorno, encoding: 'utf8' });

      // En el repositorio hijo, todo.
      assert.ok(readFileSync(join(m.proyecto, '.gitignore'), 'utf8').includes('.tambo/'),
        'no configuró .gitignore en el repositorio hijo');
      for (const base of [['.claude', 'skills'], ['.agents', 'skills']]) {
        assert.ok(existsSync(join(m.proyecto, ...base, 'relevo', 'SKILL.md')),
          `falta ${base.join('/')} en el repositorio`);
      }
      assert.ok(existsSync(join(m.proyecto, 'AGENTS.md')), 'falta AGENTS.md en el repositorio');

      // En la contenedora, nada.
      for (const basura of ['.claude', '.agents', 'AGENTS.md', '.tambo']) {
        assert.ok(!existsSync(join(m.raiz, basura)),
          `init ensució la carpeta contenedora con ${basura}`);
      }
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// ------------------------- la conclusión de un subagente sobrevive

describe('trabajo delegado', () => {
  // Reportado desde fuera (issue #18): `promote()` guardaba la conclusión del
  // subagente y la captura del final del MISMO turno construía un estado nuevo
  // sin el campo, así que la sección "Trabajo delegado" duraba lo que duraba el
  // turno y una sesión nueva no la veía nunca.
  const stop = (m, payload, evento = 'Stop') => execFileSync(
    process.execPath, [join(SRC, 'capture.mjs'), evento, 'claude-code'],
    { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: JSON.stringify(payload) });

  const leer = (m) => {
    const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
    const dir = join(m.proyecto, '.tambo', 'branches', rama);
    return {
      estado: JSON.parse(readFileSync(join(dir, 'estado.json'), 'utf8')),
      md: readFileSync(join(dir, 'relevo.md'), 'utf8'),
    };
  };

  test('la captura del padre no borra lo que promovió el subagente', () => {
    const m = montar('chaski-deleg-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 2;\n');
      stop(m, { session_id: 'd1', cwd: m.proyecto, hook_event_name: 'Stop' });

      stop(m, {
        session_id: 'd1', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        agent_type: 'revisor', stop_reason: 'end_turn',
        last_assistant_message: 'Revisé la capa de auth: el refresh no rota el token viejo.',
      }, 'SubagentStop');

      assert.match(leer(m).md, /Trabajo delegado/, 'la promoción no llegó al relevo');

      // El turno del padre termina: ANTES esto borraba la sección entera.
      stop(m, { session_id: 'd1', cwd: m.proyecto, hook_event_name: 'Stop' });
      const despues = leer(m);
      assert.ok(Array.isArray(despues.estado.subagents) && despues.estado.subagents.length,
        'la captura del padre borró subagents del estado');
      assert.match(despues.md, /Trabajo delegado/, 'la sección desapareció del relevo');
      assert.match(despues.md, /refresh no rota/, 'se perdió la conclusión');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('sobrevive al cambio de sesión, que es el caso de cambiar de CLI', () => {
    // Atarlo a la sesión lo borraría en la primera captura del CLI siguiente:
    // el agent nuevo la lee al arrancar y la perdería para el que venga
    // después, que es justo lo que esta herramienta existe para evitar.
    const m = montar('chaski-deleg-ses-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 3;\n');
      stop(m, { session_id: 'vieja', cwd: m.proyecto, hook_event_name: 'Stop' });
      stop(m, {
        session_id: 'vieja', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        agent_type: 'explorador', last_assistant_message: 'Encontré el bug en el parser.',
      }, 'SubagentStop');

      stop(m, { session_id: 'NUEVA', cwd: m.proyecto, hook_event_name: 'Stop' });
      assert.match(leer(m).md, /Encontré el bug en el parser/,
        'otro CLI abriendo el proyecto perdió el trabajo delegado');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('el relevo dice cuánto hace que se promovió', () => {
    // Si sobreviven entre sesiones, su antigüedad tiene que verse: una
    // conclusión de hace tres días se lee distinto que una de hace diez
    // minutos, y sin la marca el agent no tiene cómo saberlo.
    const m = montar('chaski-deleg-edad-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 4;\n');
      stop(m, { session_id: 'e1', cwd: m.proyecto, hook_event_name: 'Stop' });
      stop(m, {
        session_id: 'e1', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        agent_type: 'revisor', last_assistant_message: 'Listo el repaso.',
      }, 'SubagentStop');
      assert.match(leer(m).md, /\*\*revisor\*\* — hace \d+ min/,
        'no muestra la antigüedad de la conclusión');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// ------------------- el bloqueo tiene que poder bloquear de verdad

describe('contrato del bloqueo por CLI', () => {
  test('el hook Stop de Codex NO se registra en segundo plano', () => {
    // La documentación de Codex: «Background hooks can't block, approve,
    // rewrite, or otherwise control the operation that triggered them». Con
    // `async = true` el `decision: block` se ignora, así que la petición
    // automática de la narrativa dejaría de existir en Codex — y Codex es
    // donde más falta, porque es a donde se pasa cuando se agota la cuota del
    // CLI principal. Si alguien devuelve el `async`, la función desaparece sin
    // ningún error: este test es el único aviso.
    const m = montar('chaski-codex-sync-');
    try {
      m.correr('init');
      const toml = readFileSync(join(m.casa, '.codex', 'config.toml'), 'utf8');
      const bloque = toml.slice(toml.indexOf('>>> chaski'), toml.indexOf('<<< chaski'));
      assert.match(bloque, /\[\[hooks\.Stop\.hooks\]\]/, 'no registró el hook Stop');
      assert.ok(!/async\s*=\s*true/.test(bloque),
        'el hook Stop quedó en segundo plano: no podrá mantener al agent un turno más');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('a agy se le manda "continue" y no "block"', () => {
    // En Antigravity la clave es "continue", y su documentación dice que
    // cualquier otro valor PERMITE parar. Mandarle el "block" de Claude Code
    // no da error: no hace nada, en silencio.
    const m = montar('chaski-agy-cont-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 9;\n');
      const salida = execFileSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'agy'], {
        cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
        input: JSON.stringify({ session_id: 'a1', cwd: m.proyecto, hook_event_name: 'Stop' }),
      });
      const o = JSON.parse(salida.trim());
      assert.equal(o.decision, 'continue', `agy recibió "${o.decision}", que lo deja parar`);
      assert.match(o.reason, /a medias/i, 'el motivo no pide el estado en vuelo');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('a claude code se le manda additionalContext, no "block"', () => {
    const m = montar('chaski-cc-block-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 10;\n');
      const salida = execFileSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'claude-code'], {
        cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
        input: JSON.stringify({ session_id: 'c1', cwd: m.proyecto, hook_event_name: 'Stop' }),
      });
      const o = JSON.parse(salida.trim());
      assert.equal(o.hookSpecificOutput?.hookEventName, 'Stop');
      assert.match(o.hookSpecificOutput?.additionalContext ?? '', /a medias/i);
      assert.ok(!('decision' in o),
        'con decision la interfaz rotula la petición como "Stop hook error"');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('el aviso corto requiere una skill accesible para el CLI', () => {
  for (const agent of ['claude-code', 'codex', 'agy']) {
    const propia = agent === 'claude-code' ? '.claude' : '.agents';
    const ajena = propia === '.claude' ? '.agents' : '.claude';
    for (const [caso, base, ubicacion, corto] of [
      ['skill propia en la raíz', propia, 'raiz', true],
      ['solo la skill de otro CLI', ajena, 'raiz', false],
      ['sesión abierta en la carpeta contenedora', propia, 'contenedor', false],
      ['sesión abierta en una subcarpeta', propia, 'subcarpeta', true],
    ]) {
      test(`${agent}: ${caso}`, () => {
        const m = montar('chaski-aviso-');
        try {
          const skillDir = join(m.proyecto, base, 'skills', 'relevo');
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(join(skillDir, 'SKILL.md'),
            readFileSync(join(SRC, '..', 'skill', 'SKILL.md')));
          writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 42;\n');
          const cwd = ubicacion === 'contenedor' ? m.raiz
            : ubicacion === 'subcarpeta' ? join(m.proyecto, 'src') : m.proyecto;
          mkdirSync(cwd, { recursive: true });
          const r = spawnSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', agent], {
            cwd, env: m.entorno, encoding: 'utf8',
            input: JSON.stringify({ cwd, session_id: 'aviso', hook_event_name: 'Stop' }),
          });
          assert.equal(r.status, 0);
          assert.equal(r.stderr, '', 'el hook ocultó un error propio');
          const salida = JSON.parse(r.stdout);
          const texto = salida.hookSpecificOutput?.additionalContext ?? salida.reason;
          if (corto) {
            assert.equal(texto.split('\n').length, 1);
            assert.ok(texto.length <= 200, 'el aviso volvió a crecer');
            assert.match(texto, /skill `relevo`/);
            assert.doesNotMatch(texto, /narrativeWrittenAt|estado\.json|\.tambo/);
          } else {
            assert.match(texto, /narrative`, `narrativeAuthor` y `narrativeWrittenAt/);
            assert.match(texto, /estado\.json/);
            assert.doesNotMatch(texto, /Usa la skill/);
          }
        } finally {
          rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      });
    }
  }
});

describe('el hook no se traga errores propios', () => {
  // Este test existe por un bug que acabó de pasar: una función se usó sin
  // importarla, y el fallo fue invisible por tres vías a la vez. `node --check`
  // pasa, porque es un error de ejecución y no de sintaxis. Los tests pasaban,
  // porque la excepción ocurría DESPUÉS de escribir el relevo. Y el hook la
  // atrapaba, escribía «captura omitida» en stderr y salía con código 0,
  // cumpliendo el invariante de no fallar nunca.
  //
  // Ese try/catch es correcto y no se toca: un hook que revienta le arruina la
  // sesión al usuario. Lo que faltaba era mirar stderr. En el camino normal,
  // «captura omitida» significa que algo se rompió por dentro.
  for (const agent of ['claude-code', 'codex', 'agy']) {
    test(`una captura normal con ${agent} no deja nada en stderr`, () => {
      const m = montar(`chaski-stderr-${agent}-`);
      try {
        writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 42;\n');
        const r = spawnSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', agent], {
          cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
          input: JSON.stringify({ session_id: 's', cwd: m.proyecto, hook_event_name: 'Stop' }),
        });
        assert.equal(r.status, 0, 'el hook nunca debe fallar');
        assert.ok(!/captura omitida/.test(r.stderr),
          `el hook se tragó un error propio: ${r.stderr.trim()}`);
      } finally {
        rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }
});

describe('la confianza de los hooks de Codex sobrevive a init', () => {
  // Codex guarda la confianza concedida a cada hook en un `[hooks.state]` con
  // un `trusted_hash`, y lo escribe a continuación del hook al que pertenece:
  // dentro del bloque delimitado de chaski. `init` reescribía ese bloque y se
  // lo llevaba, así que cada actualización obligaba al usuario a volver a
  // aceptar los hooks y a abrir Codex dos veces, porque el permiso recién se
  // aplica en la sesión siguiente.
  test('un init idempotente conserva el trusted_hash', () => {
    const m = montar('chaski-codex-trust-');
    try {
      m.correr('init');
      const ruta = join(m.casa, '.codex', 'config.toml');

      // Codex escribe su estado dentro del bloque, justo antes de la marca final.
      const antes = readFileSync(ruta, 'utf8');
      const fin = '# <<< chaski <<<';
      const falso = [
        '', '[hooks.state]', '',
        "[hooks.state.'fake:stop:0:0']",
        'trusted_hash = "sha256:0123456789abcdef"', '',
      ].join('\n');
      writeFileSync(ruta, antes.replace(fin, falso + fin));

      m.correr('init');
      const despues = readFileSync(ruta, 'utf8');
      assert.match(despues, /trusted_hash = "sha256:0123456789abcdef"/,
        'init borró la confianza: el usuario tendrá que aceptar los hooks otra vez');
      // Y el bloque sigue siendo válido: un solo par de marcas, un solo Stop.
      assert.equal(despues.split('>>> chaski').length - 1, 1, 'duplicó el bloque');
      assert.equal(despues.split('[[hooks.Stop]]').length - 1, 1, 'duplicó el hook Stop');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('sin estado de confianza previo, el TOML queda limpio', () => {
    const m = montar('chaski-codex-sin-trust-');
    try {
      m.correr('init');
      const toml = readFileSync(join(m.casa, '.codex', 'config.toml'), 'utf8');
      assert.ok(!/hooks\.state/.test(toml), 'inventó un bloque de estado que Codex no escribió');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('el contador de la narrativa, en el hook real', () => {
  // El test unitario de la política no cubre esto: le pasa el `previo` a mano,
  // y el bug vivía en el cableado de capture.mjs, no en la política.
  //
  // El transcript tiene que CRECER entre las dos capturas. Sin eso el defecto
  // no se manifiesta: solo aparece cuando el contador se queda atrás de un
  // `turns` que avanza, que es el caso real —se vio con el contador en 0 y
  // `turns` en 2.049— y la primera versión de este test pasaba con el bug
  // presente justamente por no hacer crecer el transcript.
  test('una narrativa escrita fuera de banda pone el contador al día', () => {
    const m = montar('chaski-stamp-');
    try {
      const trozo = readFileSync(join(AQUI, 'fixtures', 'claude-code.transcript.jsonl'), 'utf8');
      const transcript = join(m.raiz, 'transcript.jsonl');
      writeFileSync(transcript, trozo);

      const corre = () => execFileSync(process.execPath,
        [join(SRC, 'capture.mjs'), 'Stop', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
          input: JSON.stringify({
            session_id: 's1', transcript_path: transcript,
            cwd: m.proyecto, hook_event_name: 'Stop',
          }) });

      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 7;\n');
      corre();

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const ruta = join(m.proyecto, '.tambo', 'branches', rama, 'estado.json');
      const turnsAntes = JSON.parse(readFileSync(ruta, 'utf8')).turns;

      // La skill escribe la narrativa DIRECTO en estado.json, igual que en
      // producción: por eso el previo de la captura siguiente ya trae la marca
      // nueva, y comparar `narrativeWrittenAt` contra sí mismo dejaba el
      // contador clavado para siempre.
      const e = JSON.parse(readFileSync(ruta, 'utf8'));
      e.narrative = 'lo que estaba haciendo';
      e.narrativeAuthor = 'claude code';
      e.narrativeWrittenAt = new Date().toISOString();
      writeFileSync(ruta, JSON.stringify(e, null, 2));

      // Más trabajo en la sesión: el transcript crece y `turns` avanza.
      writeFileSync(transcript, trozo + trozo);
      corre();

      const d = JSON.parse(readFileSync(ruta, 'utf8'));
      assert.ok(d.turns > turnsAntes, 'el transcript no creció: el test no prueba nada');
      assert.equal(d.narrativeStamp, e.narrativeWrittenAt,
        'no contabilizó la marca de la narrativa nueva');
      assert.equal(d.turnsAtNarrative, d.turns,
        `el contador quedó en ${d.turnsAtNarrative} con turns en ${d.turns}: `
        + 'la política va a creer que pasaron todos los turnos de la sesión');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('no promover lo que no es un subagente', () => {
  // Pasó en producción. La sección "Trabajo delegado" del relevo quedó con
  // cuatro MENSAJES DEL USUARIO —"dale, abre el issue", "ya, gracias, ahora
  // vuelvo"— presentados como conclusiones de subagentes y con la etiqueta
  // vacía, que se renderizaba como `****`.
  //
  // Algún CLI dispara el evento con el último mensaje de la conversación,
  // que puede ser el del usuario, donde Claude Code pone el del subagente. Y
  // lo que llegaba no era el campo ausente sino el campo VACÍO, así que el
  // `??` del código no lo cubría.
  //
  // Un relevo que afirma que alguien concluyó algo que nunca pasó es peor que
  // uno sin la sección: es justo la clase de mentira que esta herramienta
  // existe para no cometer. Y desde el #28 esas entradas sobreviven entre
  // sesiones, así que se arrastraban.
  const promover = (m, payload) => execFileSync(process.execPath,
    [join(SRC, 'capture.mjs'), 'SubagentStop', 'claude-code'],
    { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: JSON.stringify(payload) });

  const relevo = (m) => {
    const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
    return readFileSync(join(m.proyecto, '.tambo', 'branches', rama, 'relevo.md'), 'utf8');
  };

  const conPadre = (prefijo, fn) => {
    const m = montar(prefijo);
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 5;\n');
      execFileSync(process.execPath, [join(SRC, 'capture.mjs'), 'Stop', 'claude-code'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
          input: JSON.stringify({ session_id: 'p', cwd: m.proyecto, hook_event_name: 'Stop' }) });
      return fn(m);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };

  test('un agent_type vacío no se promueve', () => {
    conPadre('chaski-nopromo-', (m) => {
      promover(m, {
        session_id: 'p', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        agent_type: '', last_assistant_message: 'dale, abre el issue',
      });
      const md = relevo(m);
      assert.ok(!/Trabajo delegado/.test(md),
        'promovió algo sin identidad de subagente');
      assert.ok(!/dale, abre el issue/.test(md),
        'el mensaje del usuario quedó en el relevo como conclusión de un subagente');
    });
  });

  test('un agent_type real sí se promueve, con su nombre', () => {
    conPadre('chaski-sipromo-', (m) => {
      promover(m, {
        session_id: 'p', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        agent_type: 'revisor', last_assistant_message: 'El refresh no rota el token viejo.',
      });
      const md = relevo(m);
      assert.match(md, /Trabajo delegado/);
      assert.match(md, /\*\*revisor\*\*/, 'perdió el nombre del subagente');
      assert.ok(!/\*\*\*\*/.test(md), 'quedó una etiqueta vacía');
    });
  });

  test('sin el campo, se acepta con un nombre genérico', () => {
    // Un CLI puede no mandarlo y la promoción sigue siendo legítima: la huella
    // del defecto era el campo presente y vacío, no su ausencia.
    conPadre('chaski-generico-', (m) => {
      promover(m, {
        session_id: 'p', cwd: m.proyecto, hook_event_name: 'SubagentStop',
        last_assistant_message: 'Revisé los tres adaptadores.',
      });
      assert.match(relevo(m), /\*\*subagente\*\*/);
    });
  });
});

describe('comandos next, cost, why y share', () => {
  const capturar = (m, agente, payload) => execFileSync(process.execPath,
    [join(SRC, 'capture.mjs'), payload.hook_event_name ?? 'Stop', agente],
    { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: JSON.stringify(payload) });

  test('next reporta CLIs agotados, sugiere el siguiente disponible y resume lo pendiente', () => {
    const m = montar('chaski-next-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 99;\n');
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop',
      });

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const rutaEstado = join(m.proyecto, '.tambo', 'branches', rama, 'estado.json');
      const est = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      est.narrative = '**Objetivo:** Rotar refresh tokens.\n**Pendiente:** Terminar refresh.ts:41.';
      est.narrativeAuthor = 'claude code';
      est.narrativeWrittenAt = new Date().toISOString();
      writeFileSync(rutaEstado, JSON.stringify(est, null, 2));

      // Se agota la cuota de Claude Code vía StopFailure.
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto,
        hook_event_name: 'StopFailure', error_type: 'rate_limit',
        error_message: 'You hit your limit',
      });

      const salida = m.correr('next');
      assert.match(salida, /claude code\s+agotado/, 'no marcó claude code como agotado');
      assert.match(salida, /→\s+codex\s+disponible/, 'no sugirió codex como siguiente CLI disponible');
      assert.match(salida, /1 archivo\(s\) sin commitear/, 'no mostró los archivos sucios');
      assert.match(salida, /Terminar refresh\.ts:41/, 'no mostró el paso pendiente de la narrativa');

      // Cuando Claude Code vuelve a completar un Stop normal, sale de agotados.
      capturar(m, 'claude-code', {
        session_id: 's2', cwd: m.proyecto, hook_event_name: 'Stop',
      });
      const salidaRecuperada = m.correr('next');
      assert.match(salidaRecuperada, /claude code\s+disponible/, 'no limpió el agotamiento tras un Stop normal');
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('cost reporta $0.00 de gasto externo y contabiliza peticiones y narrativas por CLI', () => {
    const m = montar('chaski-cost-');
    try {
      writeFileSync(join(m.proyecto, 'app.js'), 'export const a = 42;\n');
      // Primer turno con trabajo sucio y sin narrativa: dispara petición automática.
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop',
      });

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const rutaEstado = join(m.proyecto, '.tambo', 'branches', rama, 'estado.json');
      const est = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      est.narrative = 'Se decidió usar cookies HttpOnly para el refresh token.';
      est.narrativeAuthor = 'codex';
      est.narrativeWrittenAt = new Date().toISOString();
      writeFileSync(rutaEstado, JSON.stringify(est, null, 2));

      // La captura siguiente contabiliza la narrativa nueva escrita por codex.
      capturar(m, 'codex', {
        session_id: 's2', cwd: m.proyecto, hook_event_name: 'Stop',
      });

      const salida = m.correr('cost');
      assert.match(salida, /0 tokens · \$0\.00/);
      assert.match(salida, /peticiones\s+1 en 7d · 1 total/);
      assert.match(salida, /narrativas\s+1 en 7d · 1 total/);
      assert.match(salida, /claude code\s+0 narrativa\(s\) en 7d \(0 total\) · 1 petición\(es\)/);
      assert.match(salida, /codex\s+1 narrativa\(s\) en 7d \(1 total\)/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('why recupera narrativas archivadas en .tambo/historia/ aunque el relevo activo haya cambiado', () => {
    const m = montar('chaski-why-');
    try {
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop',
      });
      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const rutaEstado = join(m.proyecto, '.tambo', 'branches', rama, 'estado.json');

      // Primera narrativa: habla de GraphQL.
      let est = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      est.narrative = 'Descartamos GraphQL porque complica el caché HTTP en el CDN.';
      est.narrativeAuthor = 'claude code';
      est.narrativeWrittenAt = '2026-11-01T10:00:00.000Z';
      writeFileSync(rutaEstado, JSON.stringify(est, null, 2));
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop',
      });

      // Segunda narrativa: reemplaza la anterior en estado.json con otro tema.
      est = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      est.narrative = 'Ahora estamos migrando las colas a SQLite con WAL.';
      est.narrativeAuthor = 'agy';
      est.narrativeWrittenAt = '2026-11-02T12:00:00.000Z';
      writeFileSync(rutaEstado, JSON.stringify(est, null, 2));
      capturar(m, 'agy', {
        session_id: 's2', cwd: m.proyecto, hook_event_name: 'Stop',
      });

      // La narrativa de GraphQL ya no está en estado.json, pero sigue en historia/.
      const actual = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      assert.ok(!actual.narrative.includes('GraphQL'));

      const encontrado = m.correr('why', 'graphql');
      assert.match(encontrado, /Descartamos GraphQL/);
      assert.match(encontrado, /\(historia\)/);

      const sinMatch = m.correr('why', 'kubernetes');
      assert.match(sinMatch, /No encontré decisiones/);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('share redacta secretos, exige confirmación y escribe archivos únicos en decisiones/', () => {
    const m = montar('chaski-share-');
    try {
      capturar(m, 'claude-code', {
        session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop',
      });
      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const rutaEstado = join(m.proyecto, '.tambo', 'branches', rama, 'estado.json');
      const tokenFalso = 'ghp_1234567890abcdefghijklmnopqrstuvwxAB';
      const est = JSON.parse(readFileSync(rutaEstado, 'utf8'));
      est.narrative = `Elegimos cookies HttpOnly. Token de prueba: ${tokenFalso}`;
      est.narrativeAuthor = 'claude code';
      est.narrativeWrittenAt = new Date().toISOString();
      writeFileSync(rutaEstado, JSON.stringify(est, null, 2));

      // Caso positivo de control: el token está en estado.json antes de share.
      assert.ok(readFileSync(rutaEstado, 'utf8').includes(tokenFalso));

      // Sin confirmación ('n' en stdin), share no escribe nada y sale con error.
      const rechazado = spawnSync(process.execPath,
        [join(SRC, 'cli.mjs'), 'share', 'refresh en cookie'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: 'n\n' });
      assert.notEqual(rechazado.status, 0, 'share sin confirmación debería salir con código != 0');
      assert.ok(!existsSync(join(m.proyecto, 'decisiones')),
        'share creó decisiones/ a pesar de haber sido cancelado');

      // Con --yes escribe decisiones/YYYY-MM-DD-refresh-en-cookie.md y redacta el secreto.
      const publicado1 = m.correr('share', 'refresh en cookie', '--yes');
      assert.match(publicado1, /Publicado en decisiones\//);
      const archivos1 = readdirSync(join(m.proyecto, 'decisiones'));
      assert.equal(archivos1.length, 1);
      assert.match(archivos1[0], /^\d{4}-\d{2}-\d{2}-refresh-en-cookie\.md$/);

      const textoPublicado = readFileSync(join(m.proyecto, 'decisiones', archivos1[0]), 'utf8');
      assert.ok(!textoPublicado.includes(tokenFalso), 'share filtró un secreto al archivo compartido');
      assert.match(textoPublicado, /\[redactado:/, 'no dejó marca de redacción');

      // Segunda corrida con el mismo tema: append-only con sufijo -2, sin pisar el primero.
      const confirmadoStdin = spawnSync(process.execPath,
        [join(SRC, 'cli.mjs'), 'share', 'refresh en cookie'],
        { cwd: m.proyecto, env: m.entorno, encoding: 'utf8', input: 's\n' });
      assert.equal(confirmadoStdin.status, 0);
      const archivos2 = readdirSync(join(m.proyecto, 'decisiones')).sort();
      assert.equal(archivos2.length, 2);
      assert.ok(archivos2.some((f) => /-refresh-en-cookie-2\.md$/.test(f)),
        `no creó el archivo con sufijo -2: ${archivos2.join(', ')}`);
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('contrato de empaquetado npm y sincronización con GitHub', () => {
  const raiz = join(AQUI, '..');
  const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'));

  test('npm run check verifica todos los archivos .mjs de src/ y src/lib/', () => {
    const checkCmd = pkg.scripts?.check ?? '';
    const mjsRaiz = readdirSync(SRC).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`);
    const mjsLib = readdirSync(join(SRC, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `src/lib/${f}`);
    for (const rel of [...mjsRaiz, ...mjsLib]) {
      assert.ok(checkCmd.includes(rel),
        `package.json scripts.check no verifica "${rel}"`);
    }
  });

  test('los puntos de entrada con shebang usan LF y nunca CRLF', () => {
    // Si se publica a npm desde Windows con CRLF en la primera línea, Linux y
    // macOS fallan al ejecutar el binario con "env: 'node\r': No such file".
    for (const f of ['cli.mjs', 'capture.mjs', 'inject.mjs']) {
      const contenido = readFileSync(join(SRC, f), 'utf8');
      assert.ok(contenido.startsWith('#!/usr/bin/env node\n'),
        `src/${f} debe iniciar con #!/usr/bin/env node y salto LF (no CRLF)`);
    }
    const gitattributes = readFileSync(join(raiz, '.gitattributes'), 'utf8');
    assert.match(gitattributes, /eol=lf/);
  });

  test('package.json, CHANGELOG.md y workflows protegen la publicación en GitHub y npm', () => {
    assert.equal(pkg.scripts?.prepublishOnly, 'npm run check && npm test');
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes('src') && pkg.files.includes('skill'));
    assert.ok(!pkg.files.includes('test') && !pkg.files.includes('.tambo'));

    const changelog = readFileSync(join(raiz, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## [${pkg.version}]`),
      `CHANGELOG.md no tiene una sección ## [${pkg.version}] para la versión actual de package.json`);

    const releaseYml = readFileSync(join(raiz, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(releaseYml, /npm publish/);
    assert.match(releaseYml, /gh release create/);

    const testYml = readFileSync(join(raiz, '.github', 'workflows', 'test.yml'), 'utf8');
    assert.match(testYml, /npm view chaski version/);
  });

  test('chaski version y --version devuelven la versión exacta de package.json', () => {
    const m = montar('chaski-ver-');
    try {
      assert.equal(m.correr('version').trim(), `chaski ${pkg.version}`);
      assert.equal(m.correr('--version').trim(), `chaski ${pkg.version}`);
      assert.match(m.correr('doctor'), new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
    } finally {
      rmSync(m.raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
