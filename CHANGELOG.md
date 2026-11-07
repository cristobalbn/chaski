# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Este proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [No publicado]

### Uso unificado del relevo
- Petición común **«relevo»** en Claude Code, Codex y agy, también mediante
  **«guarda el relevo»** y **«actualiza el relevo»**. La skill distingue guardar
  de **«continúa desde el relevo»**, que pide leer y retomar el trabajo.
- `init` actualiza un bloque delimitado de peticiones en `AGENTS.md`, incluso
  si ya existía una sección de relevo, y conserva el texto fuera de ese bloque.
- El resumen de instalación, `doctor`, el relevo sin narrativa y el README
  muestran la petición común. Los atajos nativos siguen disponibles; agy
  también admite `/relevo` directamente.

### Agregado
- Captura de hechos desde git y el transcript de la sesión, sin llamadas a
  modelos: archivos modificados, diff, exit codes de comandos, commits
  recientes y divergencia con upstream.
- Inyección del relevo al arrancar una sesión, con preámbulo de precedencia
  (el código manda sobre el texto) y delimitadores de datos.
- Relevo independiente por rama, con recuperación al volver a una rama vieja.
- Filtro de secretos antes de escribir a disco: ~20 formatos de credencial,
  cadenas de alta entropía, asignaciones sensibles, URLs con credenciales y
  cabeceras `Authorization`.
- Firma HMAC con clave local. Un relevo alterado se inyecta rotulado como no
  verificado en lugar de descartarse en silencio.
- Escritura atómica (temporal + `rename`) para sobrevivir a OneDrive, Dropbox
  e iCloud, que bloquean archivos mientras los suben.
- Lock por `mkdir` para un solo escritor, con ruptura de locks huérfanos.
- `init`, `doctor` y `uninstall`, con respaldo y reversión de cada config.
- Skill `/relevo` para que el agente en sesión escriba la narrativa.
- Adaptadores para Claude Code, Codex CLI y Antigravity CLI (`agy`).
- Al inyectar un relevo viejo, informa qué pasó desde entonces: cuántos
  commits, de quién, y —lo importante— si alguno tocó los archivos que la
  narrativa declara pendientes, con el aviso de que puede estar ya resuelto.
  Si el commit del relevo ya no existe (rebase o squash), lo dice.
- La marca de agua pertenece a una sesión: si cambia la sesión o el
  transcript, se lee desde el principio.
- Si el estado trae una narrativa que el Markdown todavía no tiene, se
  re-renderiza al inyectar en lugar de perderla.
- Limpieza de los relevos de ramas que ya no existen en git, una vez al día.
  El plazo depende de lo que se borra: 30 días si el relevo solo tiene
  hechos —reproducibles desde git— y 90 si tiene narrativa, que no se
  recupera. Configurable con `pruneAfterDays`; `0` la desactiva. Un relevo
  de rama viva no se borra nunca. Si git no responde, no se borra nada.
- CI en GitHub Actions: la suite corre en Linux, Windows y macOS por tres
  versiones de Node, y falla si se declara alguna dependencia.
- Promoción de los resultados de subagentes: al terminar, su conclusión sube
  al relevo del padre con atribución, y si no terminó por `end_turn` se avisa
  que puede no haber acabado. Su exploración se descarta.
- Suite de 95 tests con `node:test`, sin dependencias: contrato de payload y
  de transcript por CLI, corpus de 15 formatos de credencial, invariantes del
  relevo, firma, escritura atómica y lectura incremental. Los fixtures son
  sintéticos: la forma viene de capturas reales, el contenido es inventado.
- `chaski probe`: instala una sonda que vuelca el payload crudo de los hooks de
  cada CLI, para cerrar los formatos no documentados y aportar fixtures.

### Convenciones
- El código va en inglés: módulos, funciones exportadas, campos de
  `estado.json` y la API pública. La documentación, los comentarios y los
  mensajes al usuario siguen en español, y el léxico del producto también
  (`chaski`, `.tambo/`, `relevo`, `quipu`).
- Los módulos pasan a `capture.mjs`, `inject.mjs`, `cli.mjs`, `lib/paths.mjs`,
  `lib/facts.mjs`, `lib/secrets.mjs` y `lib/relay.mjs`; el estado vive en
  `.tambo/branches/<rama>/`.
- La API pública va en inglés: subcomandos, flags y claves de `chaski.json`.
  Los identificadores internos, los comentarios y los mensajes siguen en
  español, y el léxico del producto (`chaski`, `.tambo/`, `relevo`) también,
  porque es identidad. Nada de caracteres no ASCII en identificadores, claves
  ni nombres de archivo: git escapa en octal las rutas con acentos.
- `probe --ver` y `probe --limpiar` pasan a `--show` y `--clean`;
  `limpiarTrasDias` y `limpiarConNarrativaTrasDias` a `pruneAfterDays` y
  `pruneNarrativeAfterDays`.

### Corregido en la revisión del 2026-11-01
- `init` ya no reescribe una configuración que no puede parsear. Un
  `settings.json` con una coma final hacía que reemplazara el archivo entero,
  y el usuario perdía su configuración en el primer comando que corría.
- La escritura atómica ya no borra el destino para forzar el `rename`: ese
  camino podía dejar sin relevo ni original.
- Dos ramas distintas ya no comparten relevo (`feat/pagos` y `feat-pagos`).
- Un renombre es un archivo y no dos, y las rutas con acentos son legibles.
- El estado topa la lista de archivos sucios: miles hacían un `estado.json`
  de más de un megabyte reescrito en cada turno.
- `init` termina con código distinto de cero si algún CLI falló al
  configurarse. `doctor` sigue terminando siempre en 0 — ver
  [Límites conocidos](README.md#límites-conocidos) en el README.
- `doctor` ya no revienta con `LEER is not defined`: quedó una referencia a un
  nombre viejo tras la homologación a inglés. `npm run check` no lo vio porque
  solo verifica sintaxis.
- `capture.mjs` e `inject.mjs` quedan declarados puntos de entrada estables
  (invariante 8). `init` escribe su ruta absoluta en configuraciones que viven
  fuera del repositorio, así que un renombre rompe toda instalación existente.
  Hay un test que falla si cambian. El README explica que actualizar chaski
  exige volver a correr `chaski init`.

- `capturar.mjs` y `leer.mjs` vuelven como puentes de compatibilidad: una
  configuración anterior a la homologación al inglés ya no produce un volcado
  de Node en cada turno. El puente de inicio de sesión recuerda correr `init`;
  el de captura calla, porque corre en cada turno.
- Un mismo CLI dejaba dos latidos con dos grafías —`claude-code` desde el
  argumento del hook y `claude code` desde la detección— y el encabezado del
  relevo cambiaba según el evento. Se normaliza al escribir, y los archivos
  que ya tienen las dos claves convergen solos.

- El hook de captura tiene presupuesto de tiempo propio (`src/lib/budget.mjs`):
  un reloj global que cada paso consulta antes de lanzar un subproceso, más un
  timeout por llamada derivado de lo que queda. Con 5.000 archivos modificados
  el hook pasaba de 2.000 ms y Claude Code lo cancelaba, perdiendo el relevo
  entero del turno; ahora tarda ~340 ms. Se sacrifica primero lo caro y poco
  informativo —el detalle `+/-` por archivo, después el log de commits— y la
  rama, el HEAD, la lista de archivos y su total sobreviven siempre.
- El recorte se declara en el relevo en una sección propia, con qué se omitió y
  por qué. Un relevo incompleto presentado como completo es peor que uno
  recortado.
- Sin presupuesto ni para `git status`, el relevo ya no dice «árbol de trabajo
  limpio»: dice que no se pudo comprobar. Confundir «no lo sé» con «no hay
  nada» era la mentira más cara que podía contar.

- La skill del relevo se instala también en `.agents/skills/relevo/`, que es
  donde Codex y Antigravity buscan las suyas, con el mismo formato que Claude
  Code. Hasta ahora vivía solo en `.claude/skills/`: los otros dos CLIs leían
  el relevo pero no tenían cómo escribir la narrativa de vuelta, así que el
  traspaso era simétrico para los hechos y asimétrico para la intención.
- El bloque que `init` escribe en `AGENTS.md` —la vía que Codex y Antigravity
  leen siempre— mandaba editar `relevo.md` a mano. Ese archivo lo regenera
  `capture.mjs` desde `estado.json`, y la firma lo cubre: la edición se perdía
  y además disparaba un aviso de manipulación por un cambio legítimo. Ahora
  nombra los campos exactos de `estado.json` y advierte de no tocar el
  Markdown.
- Los mensajes ya no nombran `/relevo` como si existiera en los tres: cada CLI
  invoca la skill a su manera.

### Verificado contra las herramientas
- Ninguno de los tres CLIs dispara hooks en modo headless (`claude -p`,
  `codex exec`, `agy -p`). chaski es para sesiones interactivas.
- Los hooks de proyecto de Claude Code quedan inertes sin aceptar el diálogo de
  workspace trust, por eso `init` instala a nivel de usuario.
- El TOML que genera `init` para Codex parsea correctamente (`codex doctor`).
  El escapado con `JSON.stringify` es obligatorio: sin él, una ruta como
  `C:\Program Files\nodejs` hace que TOML interprete el `\n` como salto de
  línea y el comando queda destruido.
- Una ruta POSIX de Git Bash (`/tmp/...`) no resuelve cuando el hook se
  ejecuta en Windows.
- Codex y Antigravity ejecutan con `cmd /c` y re-escapan las comillas del
  archivo de configuración, así que una ruta con espacios entre comillas
  falla. Se resuelve con un script envoltorio en `~/.chaski/`, cuya ruta no
  tiene espacios. La ruta corta 8.3 de Windows no sirve: suele estar
  deshabilitada y falla en silencio.
- Codex exige conceder confianza a los hooks la primera vez, y el permiso se
  aplica desde la sesión siguiente.
- Los tres CLIs usan formatos de transcript distintos entre sí, y cada uno
  tiene su propio extractor, elegido por la forma del registro:
  - Claude Code: bloques con `tool_use` y `tool_result`.
  - Antigravity: pasos con `step_index`, `type` y `content` en texto plano.
  - Codex: envoltorio `{timestamp, ordinal, type, payload}`.
- Los tres adaptadores están validados contra payloads y transcripts reales:
  Claude Code (3 MB, 743 turnos), Antigravity (2 turnos) y Codex (119 KB,
  8 turnos).

### No implementado todavía
El documento de diseño describe estas piezas; el código no las tiene. Están
registradas como issues.

- Disparo automático de la narrativa desde los hooks. Hoy la escribe el agente
  al pedir «relevo» o al cerrar un bloque según sus instrucciones. Ver el issue #10.
- `chaski next`, `chaski cost`, `chaski why` y `chaski share`. Ver #12.
- Reserva de proveedor como `synth-only`. Ver #12.
