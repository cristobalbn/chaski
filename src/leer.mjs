#!/usr/bin/env node
// Hook de inyección. Lo ejecutan los tres CLIs al arrancar una sesión.
//
// Lo que este script imprime por stdout entra al contexto del agente, así que
// es la única parte de chaski que está en el camino crítico. Reglas:
//   - Presupuesto duro de tamaño: por encima de 10.000 caracteres el CLI
//     reemplaza el contenido por una ruta y el relevo no llega.
//   - Si no hay relevo, no imprime nada. Un agente no debe recibir ruido.
//   - Si la firma no valida, imprime igual pero rotulado: fallar en silencio
//     dejaría al usuario creyendo que funciona.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { rutaRelevo, rutaEstado, leerJson, rama, git } from './lib/rutas.mjs';
import { preambulo, CIERRE, firmaValida, MAX_CARACTERES } from './lib/relevo.mjs';

main();

function main() {
  try {
    const cwd = cwdDePayload();
    const ruta = rutaRelevo(cwd);
    if (!existsSync(ruta)) return;

    const md = readFileSync(ruta, 'utf8');
    if (!md.trim()) return;

    const estado = leerJson(rutaEstado(cwd), {}) ?? {};
    const verificado = estado.firma ? firmaValida(md, estado.firma) : false;

    const partes = [preambulo(estado, verificado), '', md];

    // Si el repo se movió desde que se escribió el relevo, hay que decirlo:
    // un relevo desactualizado presentado como verdad es peor que nada.
    const deriva = detectarDeriva(cwd, estado);
    if (deriva) partes.push('', deriva);

    partes.push('', CIERRE);

    let salida = partes.join('\n');
    if (salida.length > MAX_CARACTERES + 1200) {
      salida = salida.slice(0, MAX_CARACTERES + 1000) + '\n\n_[Recortado.]_\n' + CIERRE;
    }
    process.stdout.write(emitir(salida, process.argv[3]));
  } catch (e) {
    process.stderr.write(`chaski: no se pudo inyectar el relevo (${e?.message ?? e})\n`);
  } finally {
    process.exitCode = 0;
  }
}

function cwdDePayload() {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, 'utf8')) || {}; } catch {}
  // Antigravity usa camelCase y manda un array de rutas de workspace en vez
  // de un cwd. Documentado en su contrato de hooks.
  const ws = Array.isArray(ev.workspacePaths) ? ev.workspacePaths[0] : null;
  return ev.cwd ?? ws ?? ev.workspace ?? ev.project_dir ?? process.cwd();
}

/**
 * Cada CLI espera un formato de salida distinto en el hook de inicio:
 *
 *   - Claude Code y Codex: texto plano, que se agrega al contexto.
 *   - Antigravity: un objeto JSON con `injectSteps`. Si se le manda texto
 *     plano no inyecta nada — falla en silencio, que es el peor caso.
 */
function emitir(texto, agente) {
  if (/^agy$/i.test(agente ?? '')) {
    return JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: texto } }],
    }) + '\n';
  }
  return texto + '\n';
}

/** ¿Cambió el repo desde que se escribió el relevo? */
function detectarDeriva(cwd, estado) {
  const avisos = [];

  const ramaActual = rama(cwd);
  if (estado.hechos?.rama && ramaActual && estado.hechos.rama !== ramaActual) {
    avisos.push(`- El relevo se escribió en \`${estado.hechos.rama}\` y ahora estás en \`${ramaActual}\`.`);
  }

  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (estado.head && head && estado.head !== head) {
    avisos.push(`- Hubo commits nuevos desde que se escribió (\`${estado.head}\` → \`${head}\`).`);
  }

  const edadHoras = estado.escrito ? (Date.now() - new Date(estado.escrito).getTime()) / 3600000 : 0;
  if (edadHoras > 24) {
    avisos.push(`- Tiene más de ${Math.round(edadHoras / 24)} día(s). Verifica contra el código antes de confiar.`);
  }

  if (!avisos.length) return null;
  return ['**El repositorio cambió desde este relevo:**', ...avisos].join('\n');
}
