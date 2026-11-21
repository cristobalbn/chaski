import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectDir } from '../lib/paths.mjs';

export function projectContext() {
  const workspace = process.cwd();
  return { workspace, cwd: projectDir(workspace) };
}

/**
 * Por qué el relevo vive donde vive, cuando no es la carpeta desde la que se
 * corrió el comando o no hay repo. Líneas vacías en el caso normal (se corrió
 * en la raíz de un repo), que no necesita explicación.
 *
 * Los tres casos los reportó quien usó chaski de verdad (#47): la redirección
 * al repo hijo era invisible, cada subcarpeta sin git tenía su propio relevo
 * sin que nada lo dijera, y crear un repo hijo a mitad de una tarea cambiaba
 * de relevo en silencio.
 */
export function projectRootNote(cwd, workspace) {
  const rel = relative(cwd, workspace);
  const esRepo = existsSync(join(cwd, '.git'));
  if (cwd !== workspace && rel.startsWith('..')) {
    return [
      'La carpeta actual no es un repo git y tiene un único repo hijo: el relevo',
      'y los archivos de proyecto van ahí, y un CLI abierto en la carpeta actual',
      'también usará el relevo de ese repo hijo.',
    ];
  }
  if (cwd !== workspace) {
    return [`Estás en una subcarpeta: se usa la raíz del repo, ${cwd}.`];
  }
  if (!esRepo) {
    return [
      'Esta carpeta no es un repo git: el relevo vive en .tambo/branches/sin-rama/.',
      'Cada carpeta sin git desde la que abras un CLI tiene su propio relevo, y si',
      'después creas un único repo dentro de ella, el relevo pasa a ese repo.',
    ];
  }
  return [];
}
