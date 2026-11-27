// Archivos que `init` escribe DENTRO del proyecto, y si están al día.
//
// `init` copia la skill `relevo` a `.agents/skills/` y `.claude/skills/` y
// escribe un bloque en `AGENTS.md`. Actualizar chaski (npm, plugin o `git
// pull`) no los toca: quedan con instrucciones viejas hasta que alguien
// vuelva a correr `init`, y nadie se entera. Pasó con la nota de worktrees de
// 0.2.3: Codex trabajó con la skill anterior y dedujo la ruta leyendo el
// código. Este módulo los compara con los del paquete para que `doctor` y el
// arranque de sesión lo digan.
//
// Es liviano a propósito: inject.mjs lo importa en el camino crítico, y el
// instalador completo cuesta ~200 ms en imports (ver AGENTS.md, invariante 8).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRoot, claudePluginEnabled } from './paths.mjs';

export const SKILL_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'SKILL.md');
export const REQUESTS_START = '<!-- chaski:requests:start -->';
export const REQUESTS_END = '<!-- chaski:requests:end -->';
export const AGENTS_HEADING = '## Relevo de contexto';

/** Copias de la skill que `init` instala, relativas a la raíz del proyecto. */
export const SKILL_COPIES = [
  ['.claude', 'skills', 'relevo', 'SKILL.md'],
  ['.agents', 'skills', 'relevo', 'SKILL.md'],
];

/** Bloque de peticiones que `init` mantiene en `AGENTS.md`, con su fin de línea. */
export function requestsBlock(eol = '\n') {
  return [
    REQUESTS_START,
    'Peticiones comunes en Claude Code, Codex, agy y OpenCode:',
    '- Si el usuario escribe **«relevo»**, **«guarda el relevo»** o',
    '  **«actualiza el relevo»**, usa la skill `relevo` para guardar la narrativa.',
    '  Lee `.agents/skills/relevo/SKILL.md` o `.claude/skills/relevo/SKILL.md`.',
    // Las dos copias no se versionan, así que un worktree de git no las tiene
    // (Codex trabaja en los suyos): sin esta línea el agente deducía la ruta
    // leyendo el código de chaski.
    '  En un worktree de git están en el árbol principal: la carpeta padre de',
    '  `git rev-parse --path-format=absolute --git-common-dir`.',
    '- Si pide **«continúa desde el relevo»**, lee el relevo de la rama actual,',
    '  contrástalo con el código y retoma el siguiente paso pendiente.',
    '  Esa petición no solicita guardar ni sobrescribir la narrativa.',
    '- Una consulta sobre Chaski o el relevo no es una petición de guardado.',
    REQUESTS_END,
  ].join(eol);
}

// git con autocrlf, o un editor de Windows, cambia los fines de línea de una
// copia sin cambiar su contenido: eso no la vuelve vieja.
const normalize = (text) => String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd();
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/**
 * Rutas (relativas a la raíz del proyecto, con `/`) de los archivos que
 * `init` escribió y que ya no coinciden con esta versión de chaski. Solo mira
 * los que existen: un proyecto sin `init` no tiene nada desactualizado. Nunca
 * lanza.
 */
export function outdatedProjectFiles(cwd) {
  try {
    const root = stateRoot(cwd);
    const out = [];
    const skill = read(SKILL_SOURCE);
    if (skill !== null) {
      // Con el plugin de Claude Code, init no copia a `.claude/skills/` (la
      // skill viaja con el plugin) y una copia vieja de antes no se
      // actualizaría nunca: avisar de ella sería un aviso inapagable.
      const viaPlugin = claudePluginEnabled(root);
      for (const parts of SKILL_COPIES) {
        if (viaPlugin && parts[0] === '.claude') continue;
        const copy = read(join(root, ...parts));
        if (copy !== null && normalize(copy) !== normalize(skill)) out.push(parts.join('/'));
      }
    }
    const agents = read(join(root, 'AGENTS.md'));
    if (agents !== null) {
      const text = normalize(agents);
      const start = text.indexOf(REQUESTS_START);
      const end = text.indexOf(REQUESTS_END);
      if (start !== -1 && end > start) {
        if (text.slice(start, end + REQUESTS_END.length) !== requestsBlock('\n')) out.push('AGENTS.md');
      } else if (new RegExp(`^${AGENTS_HEADING}$`, 'm').test(text)) {
        // Sección de una instalación anterior a los marcadores: init la completa.
        out.push('AGENTS.md');
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Aviso para el agente al arrancar, o null si todo está al día. */
export function outdatedNotice(cwd) {
  const files = outdatedProjectFiles(cwd);
  if (!files.length) return null;
  return [
    `Archivos de chaski desactualizados en este proyecto: ${files.map((f) => '`' + f + '`').join(', ')}.`,
    'Son de una versión anterior de chaski y pueden dar instrucciones viejas. Díselo al usuario:',
    'se actualizan corriendo `chaski init` en la raíz del proyecto.',
  ].join('\n');
}
