import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function* modulesIn(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* modulesIn(file);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) yield file;
  }
}

const root = fileURLToPath(new URL('../', import.meta.url));
for (const subdir of ['src', 'test', 'scripts']) {
  for (const file of modulesIn(join(root, subdir))) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
if (pkg.dependencies || pkg.devDependencies) {
  console.error('chaski: package.json no puede declarar dependencies ni devDependencies (invariante 1)');
  process.exit(1);
}
if (pkg.version !== plugin.version) {
  console.error(`chaski: version desfasada entre package.json (${pkg.version}) y .claude-plugin/plugin.json (${plugin.version})`);
  process.exit(1);
}
