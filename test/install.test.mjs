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
import { execFileSync, spawn } from 'node:child_process';

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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
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
      rmSync(m.raiz, { recursive: true, force: true });
    }
  });
});
