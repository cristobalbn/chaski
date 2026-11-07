#!/usr/bin/env node
// Puente de compatibilidad. Este archivo se llamaba así antes de que el código
// se homologara al inglés, y `capturar.mjs` pasó a ser `capture.mjs`.
//
// Por qué existe: `init` registra la RUTA ABSOLUTA de los scripts en la
// configuración de cada CLI, y esa configuración vive fuera del repositorio.
// Quien actualice chaski desde una versión anterior sin volver a correr
// `chaski init` tiene los hooks apuntando a este nombre, y sin este archivo
// recibe un volcado de Node de quince líneas en cada turno:
//
//   Error: Cannot find module '...\chaski\src\capturar.mjs'
//
// Pasó de verdad, y el error sobrevive a `chaski init` dentro de una sesión ya
// abierta, porque los CLIs leen su configuración de hooks una sola vez al
// arrancar. Así que no alcanzaba con documentar el paso: el nombre viejo tiene
// que seguir funcionando.
//
// No avisa por stderr a propósito. Este hook corre en CADA turno, y una línea
// de aviso por turno es ruido que el usuario no puede callar. El aviso lo da
// el puente de inicio de sesión (`leer.mjs`), que corre una vez por sesión.
//
// No lo borres sin un ciclo de deprecación de verdad: mientras alguien pueda
// tener una configuración vieja en disco, borrarlo le rompe cada turno.
import './capture.mjs';
