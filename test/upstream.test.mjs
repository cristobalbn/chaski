// Tests del vigilante de cambios upstream (scripts/upstream.mjs) y de la
// matriz de versiones (scripts/upstream.json). Sin red: solo las funciones
// puras y la coherencia entre el manifiesto y el código.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVersion, compareVersions, changelogSections, releaseSections, relevantLines, lifecycle, renderReport,
} from '../scripts/upstream.mjs';
import { OPENCODE_MIN } from '../src/commands/hook-config.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(AQUI, '..', 'scripts', 'upstream.json'), 'utf8'));
const DAY = 86_400_000;

describe('versiones', () => {
  test('parseVersion acepta v, prefijos de tag y rechaza prereleases', () => {
    assert.deepEqual(parseVersion('1.19.6'), [1, 19, 6]);
    assert.deepEqual(parseVersion('v2.4.2'), [2, 4, 2]);
    assert.deepEqual(parseVersion('rust-v0.172.0', 'rust-v'), [0, 172, 0]);
    assert.equal(parseVersion('rust-v0.174.0-alpha.9', 'rust-v'), null);
    assert.equal(parseVersion('process-daemon-v0.6.0', 'v'), null);
  });

  test('compareVersions ordena numéricamente, no como texto', () => {
    assert.ok(compareVersions([1, 10, 0], [1, 9, 9]) > 0);
    assert.equal(compareVersions([2, 0, 0], [2, 0, 0]), 0);
  });
});

describe('notas de cambios', () => {
  const md = '# Changelog\n\n## 2.1.332\n\n- Added a `Foo` hook event\n- Fixed a hook freeze\n\n## 2.1.331\n\n- Added statusline field\n\n## 2.1.316\n\n- Viejo: hook removido\n';

  test('changelogSections corta en la versión verificada', () => {
    const s = changelogSections(md, [2, 1, 316]);
    assert.deepEqual(s.map((x) => x.version.join('.')), ['2.1.332', '2.1.331']);
    assert.doesNotMatch(s.map((x) => x.body).join(''), /Viejo/);
  });

  test('releaseSections filtra por prefijo, mayor, prerelease y versión', () => {
    const rel = [
      { tag_name: 'v2.4.2', body: 'b' }, { tag_name: 'v1.19.7', body: 'a' }, { tag_name: 'v1.19.6', body: 'x' },
      { tag_name: 'v1.20.0', prerelease: true, body: 'p' }, { tag_name: 'process-daemon-v0.6.0', body: 'd' },
    ];
    assert.deepEqual(releaseSections(rel, 'v', [1, 19, 6], 1).map((r) => r.version.join('.')), ['1.19.7']);
    assert.deepEqual(releaseSections(rel, 'v', [2, 4, 0], 2).map((r) => r.version.join('.')), ['2.4.2']);
  });

  test('relevantLines separa contrato de oportunidad y descarta los arreglos', () => {
    const r = relevantLines(changelogSections(md, [2, 1, 316]), manifest.keywords);
    const contrato = r.contrato.map((l) => l.text);
    assert.ok(contrato.some((t) => /Foo` hook event/.test(t)), 'no detectó un hook nuevo');
    // Caso positivo del filtro: «Fixed a hook freeze» menciona «hook» pero es un arreglo.
    assert.ok(/hook/i.test('Fixed a hook freeze'));
    assert.ok(!contrato.some((t) => /^Fixed/.test(t)), 'un arreglo entró como posible ruptura');
    assert.ok(r.oportunidad.some((l) => /statusline/.test(l.text)));
  });

  test('relevantLines excluye líneas de IDE aunque nombren un hook', () => {
    const s = [{ version: [1, 0, 0], body: '- [VSCode] Added a hook panel\n- Added a `Bar` hook\n' }];
    const textos = relevantLines(s, manifest.keywords).contrato.map((l) => l.text);
    assert.deepEqual(textos, ['Added a `Bar` hook']);
  });
});

describe('ciclo de vida de una línea', () => {
  const ahora = Date.parse('2026-11-27T00:00:00Z');
  test('avisa de una mayor nueva, de una línea sin publicar y del fin de la gracia', () => {
    assert.deepEqual(lifecycle({ verified: [1, 19, 6], latest: [2, 0, 0] }, manifest, ahora), ['new-major']);
    const vieja = new Date(ahora - (manifest.staleAfterDays + 1) * DAY).toISOString();
    assert.deepEqual(lifecycle({ lastPublished: vieja }, manifest, ahora), ['stale']);
    const sucesor = new Date(ahora - (manifest.successorGraceDays + 1) * DAY).toISOString();
    assert.deepEqual(lifecycle({ successorSince: sucesor }, manifest, ahora), ['successor-grace']);
    assert.deepEqual(lifecycle({ verified: [1, 0, 0], latest: [1, 0, 1], lastPublished: new Date(ahora).toISOString() }, manifest, ahora), []);
  });

  test('renderReport marca relevante solo si hay algo que atender', () => {
    const track = { id: 't', cli: 'x', line: '1.x' };
    const base = { track, verified: [1, 0, 0], notes: [], errors: [], relevant: {}, published: new Date().toISOString() };
    assert.equal(renderReport([{ ...base, latest: [1, 0, 0] }], manifest).relevant, false);
    assert.equal(renderReport([{ ...base, latest: [1, 0, 1] }], manifest).relevant, true);
    assert.equal(renderReport([{ ...base, latest: [1, 0, 0], errors: ['HTTP 500'] }], manifest).relevant, true);
  });
});

describe('matriz de versiones (scripts/upstream.json)', () => {
  test('cada línea tiene id único, versión verificada válida y estado conocido', () => {
    const ids = new Set();
    for (const t of manifest.tracks) {
      assert.ok(!ids.has(t.id), `id repetido: ${t.id}`);
      ids.add(t.id);
      assert.ok(parseVersion(t.verified), `${t.id}: verified inválida`);
      assert.ok(['supported', 'deprecated', 'dropped'].includes(t.status), `${t.id}: status desconocido`);
      assert.ok(t.npm || t.notes?.changelog || t.notes?.github, `${t.id}: sin fuente de versiones`);
    }
  });

  test('el mínimo de OpenCode del código es el de la matriz', () => {
    const oc1 = manifest.tracks.find((t) => t.id === 'opencode-1');
    assert.equal(oc1.minSupported, OPENCODE_MIN.join('.'),
      'OPENCODE_MIN (src/commands/hook-config.mjs) y scripts/upstream.json dicen cosas distintas');
  });

  test('ninguna línea verificada está por debajo de su mínimo soportado', () => {
    for (const t of manifest.tracks.filter((x) => x.minSupported)) {
      assert.ok(compareVersions(parseVersion(t.verified), parseVersion(t.minSupported)) >= 0, t.id);
    }
  });
});
