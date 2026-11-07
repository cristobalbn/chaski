#!/usr/bin/env node
// Puente de compatibilidad. Este archivo se llamaba así antes de que el código
// se homologara al inglés, y `leer.mjs` pasó a ser `inject.mjs`.
//
// El motivo completo está en `capturar.mjs`, el otro puente. En resumen: los
// hooks guardan la ruta absoluta del script en una configuración que vive
// fuera del repositorio, así que quien actualiza chaski sin volver a correr
// `chaski init` sigue invocando este nombre.
//
// Este sí avisa, porque corre una vez por sesión y no una vez por turno. El
// aviso va por stderr y NUNCA por stdout: lo que este script imprime por
// stdout entra al contexto del agent, y una línea de más ahí es ruido que el
// agent trata como dato.
process.stderr.write(
  'chaski: tus hooks apuntan a un nombre de archivo antiguo (leer.mjs). '
  + 'Funciona igual, pero ejecuta `chaski init` para actualizarlos.\n',
);

await import('./inject.mjs');
