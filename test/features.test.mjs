// Una prueba por funcionalidad que no tenía la suya, y las guardas que
// impiden que una funcionalidad nueva entre sin prueba.
//
// Ningún test toca el HOME real (AGENTS.md): los que lanzan `cli.mjs` o los
// hooks redirigen HOME, USERPROFILE, CODEX_HOME y XDG_CONFIG_HOME a un
// directorio descartable en la misma llamada.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { statePath, relayPath, readOnlyStatePath, readOnlyRelayPath, tamboIsIgnored, branchSlug } from '../src/lib/paths.mjs';
import { outdatedProjectFiles, outdatedNotice, requestsBlock, SKILL_SOURCE } from '../src/lib/project-files.mjs';
import { otherWorktreeRelays } from '../src/lib/worktrees.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const SRC = join(RAIZ, 'src');
const limpiar = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

/**
 * CLIs falsos al frente del PATH: `init` solo configura (e instala la skill
 * y el bloque de AGENTS.md) si detecta algún CLI. En una máquina con los CLIs
 * reales pasaba igual sin esto; en el CI, sin ninguno, no instalaba nada.
 */
function fakeClis(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['claude', 'codex', 'agy', 'opencode']) {
    if (process.platform === 'win32') writeFileSync(join(dir, name + '.cmd'), '@echo off\r\nexit /b 0\r\n');
    else writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

/** Repo git descartable con un HOME descartable al lado. */
function montar(prefijo) {
  const raiz = mkdtempSync(join(tmpdir(), prefijo));
  const proyecto = join(raiz, 'proyecto');
  const casa = join(raiz, 'casa');
  mkdirSync(proyecto, { recursive: true });
  mkdirSync(casa, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: proyecto, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(proyecto, 'app.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'inicial');
  const entorno = {
    ...process.env,
    HOME: casa, USERPROFILE: casa,
    CODEX_HOME: join(casa, '.codex'),
    XDG_CONFIG_HOME: join(casa, '.config'),
  };
  const bin = fakeClis(join(raiz, 'bin'));
  const sep = process.platform === 'win32' ? ';' : ':';
  entorno.PATH = bin + sep + process.env.PATH;
  entorno.Path = bin + sep + (process.env.Path ?? process.env.PATH);
  // Las variables de una sesión real (CLAUDECODE, CLAUDE_PLUGIN_ROOT…)
  // cambiarían qué CLI cree el hook que lo llamó.
  for (const k of ['CLAUDECODE', 'CLAUDE_PLUGIN_ROOT', 'CODEX_SESSION', 'AGY_SESSION', 'ANTIGRAVITY_SESSION']) delete entorno[k];
  const correr = (...args) => execFileSync(process.execPath, [join(SRC, 'cli.mjs'), ...args],
    { cwd: proyecto, env: entorno, encoding: 'utf8' });
  const hook = (script, event, agent, payload) => spawnSync(process.execPath, [join(SRC, script), event, agent], {
    cwd: proyecto, env: entorno, encoding: 'utf8', input: JSON.stringify(payload),
  });
  return { raiz, proyecto, casa, g, entorno, correr, hook };
}

/**
 * Corre fn con HOME y USERPROFILE del proceso apuntando a `casa`: os.homedir()
 * los lee en cada llamada, y claudePluginEnabled() mira ~/.claude/settings.json.
 * Sin esto el test leía la configuración real de quien corre la suite.
 */
function conHome(casa, fn) {
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = casa;
  process.env.USERPROFILE = casa;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('archivos de chaski en el proyecto: aviso de desactualizados', () => {
  // `init` copia la skill y escribe un bloque en AGENTS.md; actualizar chaski
  // no los toca. Sin este aviso nadie se entera (pasó con 0.2.3).
  const skill = readFileSync(SKILL_SOURCE, 'utf8');

  test('recién instalado está al día; una copia editada o un bloque viejo se detectan', () => {
    const m = montar('chaski-viejos-');
    try {
      const agentsSkill = join(m.proyecto, '.agents', 'skills', 'relevo', 'SKILL.md');
      const claudeSkill = join(m.proyecto, '.claude', 'skills', 'relevo', 'SKILL.md');
      mkdirSync(dirname(agentsSkill), { recursive: true });
      mkdirSync(dirname(claudeSkill), { recursive: true });
      writeFileSync(agentsSkill, skill);
      // Fines de línea de Windows (autocrlf, un editor): no la vuelven vieja.
      writeFileSync(claudeSkill, skill.replace(/\n/g, '\r\n'));
      writeFileSync(join(m.proyecto, 'AGENTS.md'), '# Proyecto\n\n## Relevo de contexto\n\n' + requestsBlock('\n') + '\n');
      conHome(m.casa, () => {
        assert.deepEqual(outdatedProjectFiles(m.proyecto), []);
        assert.equal(outdatedNotice(m.proyecto), null);
      });

      writeFileSync(agentsSkill, skill.replace('## Reglas', '## Reglas de antes'));
      writeFileSync(join(m.proyecto, 'AGENTS.md'),
        '# Proyecto\n\n## Relevo de contexto\n\n' + requestsBlock('\n').replace(/^ {2}En un worktree.*\n.*\n/m, '') + '\n');
      conHome(m.casa, () => assert.deepEqual(outdatedProjectFiles(m.proyecto), ['.agents/skills/relevo/SKILL.md', 'AGENTS.md']));
      assert.match(conHome(m.casa, () => outdatedNotice(m.proyecto)), /`\.agents\/skills\/relevo\/SKILL\.md`, `AGENTS\.md`[\s\S]*chaski init/);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('una sección de AGENTS.md sin marcadores (instalación vieja) cuenta como desactualizada', () => {
    const m = montar('chaski-viejos-legacy-');
    try {
      writeFileSync(join(m.proyecto, 'AGENTS.md'), '# P\n\n## Relevo de contexto\n\nTexto de una versión vieja.\n');
      assert.deepEqual(outdatedProjectFiles(m.proyecto), ['AGENTS.md']);
      // Un AGENTS.md ajeno a chaski no es asunto suyo.
      writeFileSync(join(m.proyecto, 'AGENTS.md'), '# P\n\nNada de chaski aquí.\n');
      assert.deepEqual(outdatedProjectFiles(m.proyecto), []);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('con el plugin de Claude Code no avisa de la copia de .claude/skills, que init ya no actualiza', () => {
    const m = montar('chaski-viejos-plugin-');
    try {
      const claudeSkill = join(m.proyecto, '.claude', 'skills', 'relevo', 'SKILL.md');
      const agentsSkill = join(m.proyecto, '.agents', 'skills', 'relevo', 'SKILL.md');
      for (const p of [claudeSkill, agentsSkill]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'vieja'); }
      conHome(m.casa, () => {
        assert.deepEqual(outdatedProjectFiles(m.proyecto), ['.claude/skills/relevo/SKILL.md', '.agents/skills/relevo/SKILL.md']);
        writeFileSync(join(m.proyecto, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'chaski@chaski': true } }));
        assert.deepEqual(outdatedProjectFiles(m.proyecto), ['.agents/skills/relevo/SKILL.md']);
      });
    } finally {
      limpiar(m.raiz);
    }
  });

  test('doctor lo dice, el arranque de sesión se lo pasa al agente e init lo arregla', () => {
    const m = montar('chaski-viejos-e2e-');
    try {
      m.correr('init');
      assert.match(m.correr('doctor'), /skill y AGENTS\s+al día/);
      const copia = join(m.proyecto, '.agents', 'skills', 'relevo', 'SKILL.md');
      assert.ok(existsSync(copia), 'init no instaló la copia para Codex, agy y OpenCode');
      writeFileSync(copia, readFileSync(copia, 'utf8') + '\nlínea de una versión vieja\n');
      assert.match(m.correr('doctor'), /skill y AGENTS\s+DESACTUALIZADOS \(\.agents\/skills\/relevo\/SKILL\.md\) — ejecuta init/);

      // Hace falta un estado de rama para que SessionStart diga algo.
      const stop = m.hook('capture.mjs', 'Stop', 'codex', { session_id: 's1', cwd: m.proyecto, hook_event_name: 'Stop' });
      assert.equal(stop.status, 0);
      assert.equal(stop.stderr, '');
      const arranque = () => m.hook('inject.mjs', 'SessionStart', 'codex',
        { session_id: 's2', cwd: m.proyecto, hook_event_name: 'SessionStart', source: 'startup' });
      const viejo = arranque();
      assert.equal(viejo.status, 0);
      assert.match(viejo.stdout, /Archivos de chaski desactualizados[\s\S]*chaski init/);

      m.correr('init');
      assert.match(m.correr('doctor'), /skill y AGENTS\s+al día/);
      assert.doesNotMatch(arranque().stdout, /desactualizados/);
    } finally {
      limpiar(m.raiz);
    }
  });

  test('init escribe en AGENTS.md exactamente el bloque con el que se compara', () => {
    const m = montar('chaski-viejos-bloque-');
    try {
      m.correr('init');
      assert.ok(readFileSync(join(m.proyecto, 'AGENTS.md'), 'utf8').includes(requestsBlock('\n')));
    } finally {
      limpiar(m.raiz);
    }
  });
});

describe('rutas del relevo', () => {
  test('statePath y relayPath crean la carpeta de la rama; las de solo lectura no crean nada', () => {
    const m = montar('chaski-rutas-');
    try {
      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const dir = join(m.proyecto, '.tambo', 'branches', branchSlug(rama));
      assert.equal(readOnlyStatePath(m.proyecto), join(dir, 'estado.json'));
      assert.equal(readOnlyRelayPath(m.proyecto), join(dir, 'relevo.md'));
      assert.ok(!existsSync(join(m.proyecto, '.tambo')), 'una ruta de solo lectura creó .tambo/');
      assert.equal(statePath(m.proyecto), join(dir, 'estado.json'));
      assert.equal(relayPath(m.proyecto, 'feat/x'), join(m.proyecto, '.tambo', 'branches', branchSlug('feat/x'), 'relevo.md'));
      assert.ok(existsSync(dir));
      // tambo() deja su propio .gitignore: el relevo nunca entra a git (invariante 3).
      assert.equal(readFileSync(join(m.proyecto, '.tambo', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    } finally {
      limpiar(m.raiz);
    }
  });

  test('tamboIsIgnored sin git: lee el .gitignore del proyecto y el propio de .tambo/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaski-ignorado-'));
    try {
      assert.equal(tamboIsIgnored(dir), false);
      writeFileSync(join(dir, '.gitignore'), 'node_modules\n.tambo/\n');
      assert.equal(tamboIsIgnored(dir), true);
      rmSync(join(dir, '.gitignore'));
      mkdirSync(join(dir, '.tambo'));
      writeFileSync(join(dir, '.tambo', '.gitignore'), '# chaski\n*\n');
      assert.equal(tamboIsIgnored(dir), true);
    } finally {
      limpiar(dir);
    }
  });
});

describe('captura', () => {
  test('lastFile es el archivo con más cambios, no el primero del diff', () => {
    const m = montar('chaski-lastfile-');
    try {
      writeFileSync(join(m.proyecto, 'a-poco.js'), 'x\n');
      writeFileSync(join(m.proyecto, 'b-mucho.js'), 'x\n');
      m.g('add', '-A');
      m.g('commit', '-qm', 'dos archivos');
      writeFileSync(join(m.proyecto, 'a-poco.js'), 'x\ny\n');
      writeFileSync(join(m.proyecto, 'b-mucho.js'), Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n');
      const r = m.hook('capture.mjs', 'Stop', 'codex', { session_id: 's', cwd: m.proyecto, hook_event_name: 'Stop' });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      const estado = JSON.parse(readFileSync(readOnlyStatePath(m.proyecto), 'utf8'));
      assert.deepEqual(estado.facts.dirty.map((d) => d.ruta).sort(), ['a-poco.js', 'b-mucho.js']);
      assert.equal(estado.lastFile, 'b-mucho.js');
    } finally {
      limpiar(m.raiz);
    }
  });
});

describe('relevos de otros worktrees', () => {
  test('señala tres como máximo, los más recientes primero, y cuenta el resto', () => {
    const m = montar('chaski-otros-wt-');
    try {
      const base = join(m.proyecto, '.tambo', 'branches');
      const ahora = Date.now();
      for (let i = 0; i < 5; i++) {
        const dir = join(base, `HEAD-wt${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'estado.json'), JSON.stringify({
          writtenAt: new Date(ahora - i * 60_000).toISOString(), agent: 'codex',
          worktree: join(m.raiz, `wt${i}`), facts: { branch: 'HEAD' },
        }));
      }
      // Uno viejo (más de 72 h) no se señala aunque sea de otro árbol.
      const viejo = join(base, 'HEAD-viejo');
      mkdirSync(viejo);
      writeFileSync(join(viejo, 'estado.json'), JSON.stringify({
        writtenAt: new Date(ahora - 100 * 3600_000).toISOString(), agent: 'codex', worktree: join(m.raiz, 'viejo'),
      }));
      const t = new Date(ahora - 100 * 3600_000);
      utimesSync(join(viejo, 'estado.json'), t, t);

      const texto = otherWorktreeRelays(m.proyecto, null, ahora);
      const lineas = texto.split('\n');
      assert.equal(lineas.filter((l) => /^- codex/.test(l)).length, 3);
      assert.match(lineas[1], /HEAD-wt0/);
      assert.match(lineas[3], /HEAD-wt2/);
      assert.match(texto, /- y 2 más en/);
      assert.doesNotMatch(texto, /HEAD-viejo/);
      // Caso positivo de lo anterior: con la marca reciente sí aparece.
      writeFileSync(join(viejo, 'estado.json'), JSON.stringify({
        writtenAt: new Date(ahora).toISOString(), agent: 'codex', worktree: join(m.raiz, 'viejo'),
      }));
      assert.match(otherWorktreeRelays(m.proyecto, null, ahora + 1000), /HEAD-viejo/);
    } finally {
      limpiar(m.raiz);
    }
  });
});

describe('sonda', () => {
  test('redacta los secretos dentro de arreglos del payload', () => {
    const m = montar('chaski-sonda-arreglos-');
    try {
      const log = join(m.casa, 'sonda.log');
      const probeLog = new URL('../src/lib/probe-log.mjs', import.meta.url).href;
      const secreto = 'ghp_' + 'a'.repeat(36);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { captureProbe } from ${JSON.stringify(probeLog)}; captureProbe(${JSON.stringify(log)}, 'Stop', 'codex');`], {
        cwd: m.proyecto, env: m.entorno, encoding: 'utf8',
        input: JSON.stringify({ cwd: m.proyecto, items: ['texto', { token: 'x' }, [`clave ${secreto}`]] }),
      });
      assert.equal(r.status, 0);
      const escrito = readFileSync(log, 'utf8');
      assert.match(escrito, /"items":\[/);
      assert.doesNotMatch(escrito, new RegExp(secreto));
      // Caso positivo: el secreto sí estaba en la entrada.
      assert.match(JSON.stringify({ items: [[`clave ${secreto}`]] }), new RegExp(secreto));
    } finally {
      limpiar(m.raiz);
    }
  });
});

describe('guardas de la suite', () => {
  // AGENTS.md: la lista del script `test` es explícita porque `node --test
  // test/` no funciona y el glob necesita Node 22. Un archivo de tests que no
  // está en la lista no corre nunca, y la suite sigue verde.
  test('cada test/*.test.mjs está en el script test de package.json', () => {
    const script = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).scripts.test;
    const archivos = readdirSync(join(RAIZ, 'test')).filter((f) => f.endsWith('.test.mjs'));
    assert.ok(archivos.includes('features.test.mjs'));
    for (const f of archivos) assert.ok(script.includes(`test/${f}`), `test/${f} no está en el script test`);
  });

  test('cada subcomando de cli.mjs se ejecuta en al menos un test', () => {
    const cli = readFileSync(join(SRC, 'cli.mjs'), 'utf8');
    const comandos = [...cli.matchAll(/^\s*\['([a-z]+)',\s*async/gm)].map((x) => x[1]);
    assert.ok(comandos.length >= 9, `se leyeron ${comandos.length} subcomandos: cambió la forma de cli.mjs`);
    const tests = readdirSync(join(RAIZ, 'test')).filter((f) => f.endsWith('.test.mjs'))
      .map((f) => readFileSync(join(RAIZ, 'test', f), 'utf8')).join('\n');
    for (const c of comandos) {
      assert.match(tests, new RegExp(`(correr\\(|cli\\.mjs'\\),\\s*)'${c}'`), `ningún test ejecuta \`chaski ${c}\``);
    }
  });

  test('cada módulo de src/ lo importa al menos un test o un módulo probado', () => {
    // Un módulo que nadie importa no está probado ni se usa: o sobra, o le
    // falta su test. La cobertura del CI mide lo demás.
    const modulos = [];
    const recorrer = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) recorrer(p);
        else if (e.name.endsWith('.mjs')) modulos.push(p);
      }
    };
    recorrer(SRC);
    const fuentes = [...modulos, ...readdirSync(join(RAIZ, 'test')).filter((f) => f.endsWith('.mjs')).map((f) => join(RAIZ, 'test', f))]
      .map((p) => readFileSync(p, 'utf8')).join('\n');
    // Los puntos de entrada se invocan por ruta (hooks, bin, plugin).
    const entradas = new Set(['cli.mjs', 'capture.mjs', 'inject.mjs', 'statusline.mjs', 'opencode.mjs', 'capturar.mjs', 'leer.mjs']);
    for (const p of modulos) {
      const nombre = p.slice(SRC.length + 1).replace(/\\/g, '/');
      if (entradas.has(nombre)) {
        assert.ok(fuentes.includes(nombre), `nadie invoca src/${nombre}`);
        continue;
      }
      const base = nombre.split('/').pop().replace('.mjs', '');
      // `new URL(...)`: probe.mjs arma la ruta de probe-log.mjs para un subproceso.
      const importa = new RegExp(`(?:from |import\\(|new URL\\()['"][^'"]*\\b${base}\\.mjs['"]`);
      assert.ok(importa.test(fuentes), `nadie importa src/${nombre}`);
    }
  });
});
