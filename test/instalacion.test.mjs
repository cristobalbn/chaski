// Tests de instalación y de concurrencia.
//
// Están aparte de chaski.test.mjs porque lanzan procesos y manipulan un HOME
// falso: son más lentos y tienen otra forma de montarse.
//
// Verifican dos promesas del diseño que hasta ahora no tenían prueba:
//
//   1. `uninstall` revierte cada configuración desde su respaldo. Poder sacar
//      la herramienta sin miedo es la condición para animarse a ponerla, así
//      que esa promesa necesita sostén.
//   2. El lock deja el relevo válido con varios escritores a la vez. Pasa de
//      verdad: subagentes en paralelo, o dos CLIs abiertos en el mismo repo.
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

/** Un proyecto git de usar y tirar, con su propio HOME. */
function montar(prefijo) {
  const raiz = mkdtempSync(join(tmpdir(), prefijo));
  const proyecto = join(raiz, 'proyecto');
  const casa = join(raiz, 'casa');
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

  const entorno = { ...process.env, HOME: casa, USERPROFILE: casa };
  const correr = (...args) => execFileSync(process.execPath,
    [join(SRC, 'instalar.mjs'), ...args],
    { cwd: proyecto, env: entorno, encoding: 'utf8' });

  return { raiz, proyecto, casa, g, entorno, correr };
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

describe('concurrencia: varios escritores a la vez', () => {
  // De dónde viene cada garantía, que no es lo que parecía:
  //
  //   - La INTEGRIDAD del archivo la da la escritura atómica, no el lock. El
  //     `rename` es atómico en los tres sistemas, así que el relevo final
  //     siempre es el de alguno de los escritores y nunca uno a medio
  //     escribir. Se comprobó quitando el lock: este test seguía pasando.
  //   - El LOCK evita trabajo redundante y que un escritor pise los comandos
  //     que otro acababa de agregar, porque el estado se lee, se modifica y
  //     se escribe, y eso no es atómico.
  //
  // El test cubre la garantía observable: ningún proceso falla, el resultado
  // es válido, no quedan temporales y el lock no queda tomado.
  test('el relevo queda válido y sin temporales sueltos', async () => {
    // Pasa de verdad: subagentes en paralelo, o dos CLIs en el mismo repo.
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
        const p = spawn(process.execPath, [join(SRC, 'capturar.mjs'), 'Stop', 'test'],
          { cwd: m.proyecto, env: m.entorno, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('close', (codigo) => resolver(codigo));
        p.stdin.end(payload);
      });

      const codigos = await Promise.all(Array.from({ length: 8 }, lanzar));

      // Ningún escritor debe terminar en error, ni siquiera el que perdió el lock.
      assert.deepEqual([...new Set(codigos)], [0],
        `algún proceso falló: ${codigos.join(', ')}`);

      const rama = m.g('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const dir = join(m.proyecto, '.tambo', 'ramas', rama);

      const estado = JSON.parse(readFileSync(join(dir, 'estado.json'), 'utf8'));
      assert.ok(estado.escrito, 'el estado quedó incompleto');
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
