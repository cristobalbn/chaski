# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Este proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [No publicado]

### Corregido
- La sonda de Codex convive con los hooks normales. `probe --clean`
  conserva los cambios hechos en la configuración desde que se activó la sonda.
- Al desinstalar la statusline se guarda primero la restauración en
  Claude Code para que un fallo de escritura permita volver a intentarlo.
- Los pedidos y las marcas de turno se actualizan bajo un lock breve para
  que dos hooks simultáneos conserven cambios de ambas sesiones.
- Con varias ventanas abiertas en el mismo proyecto, el pedido de narrativa
  de una pisaba el de la otra, que no se entregaba nunca: había un solo
  espacio por proyecto. Ahora hay uno por sesión (se sigue leyendo el formato
  anterior).

### Interno
- Se separa la lectura de transcripts de los hechos de git. La marca de
  agua conserva el registro incompleto y se informa cuando la lectura
  alcanza el tope de 8 MB.
- Los informes comparten la configuración con los hooks. El diagnóstico
  detecta cada CLI y lee sus eventos una sola vez.
- Los subcomandos de la CLI pasan a módulos de instalación, diagnóstico,
  sonda e informes. El chequeo de sintaxis descubre los módulos nuevos
  automáticamente.
- Refactor: la normalización del payload (`lib/payload.mjs`), los tiempos y
  vencimientos (`lib/time.mjs`), los pedidos de narrativa (`lib/pending.mjs`),
  los turnos abiertos (`lib/turns.mjs`) y la historia (`lib/history.mjs`)
  salen de los hooks a módulos propios. Sin cambios de comportamiento fuera de
  lo anotado; latencia de los hooks medida sin cambios.

## [0.1.10] - 2026-11-20

### Agregado
- Si la narrativa más reciente es de una rama que ya no existe (típico tras un
  squash-merge y borrar la rama) y es más nueva que la de la rama actual, el
  relevo la muestra aparte y rotulada. Antes, de vuelta en `main`, se veía la
  narrativa vieja de `main` y la última quedaba en el relevo huérfano.

### Corregido
- Hallazgos de una auditoría de los cambios del 2026-11-20:
  - `inject.mjs` podía salir con código 1 ante un payload con un `cwd` que no
    era texto (la comprobación del plugin estaba fuera del `try`).
  - Un pedido de narrativa podía entregarse a otra sesión abierta en paralelo
    en el mismo proyecto. Ahora, por transcript, solo se entrega si la sesión
    que lo anotó ya terminó.
  - `init --statusline` no reparaba una statusline de chaski con rutas viejas
    (tras actualizar Node o mover chaski), y tomaba por chaski cualquier
    statusline llamada `statusline.mjs`: no la envolvía y `uninstall` la
    borraba. Se agregó además una protección contra que la statusline se
    llame a sí misma.
  - `init` quitaba los hooks globales de Claude Code aunque el plugin
    estuviera activo solo en un proyecto.
  - `chaski share` anonimizaba de más: rompía URLs (`/home/` dentro de una
    URL), rutas del repo (`src/Users/`) y URLs de git (`git@host:`).
  - La narrativa de una rama borrada podía atribuirse a una rama «HEAD»
    (detached HEAD), o afirmarse borrada cuando git solo había fallado.
  - `chaski why` mostraba la narrativa de `estado.json` sin redactar.
  - El aviso de turno cortado aclara que puede seguir en curso en otra
    ventana.
- Un pedido de narrativa anotado antes de reiniciar Claude Code no se
  entregaba nunca: quedaba atado al id de sesión, que cambia al retomar, y el
  debounce impedía volver a pedirlo. Ahora se ata también al transcript.
- Abrir una sesión, o correr `doctor`, `next` o `why`, creaba `.tambo/` en
  proyectos donde chaski nunca había capturado; con el plugin, en todos los
  repos que se abrían. Leer ya no crea nada.
- En Claude Code, un «turno» contaba cada línea del transcript, incluidos los
  resultados de herramientas: una conversación real tenía 1.220 «turnos» y 34
  mensajes del usuario, así que «van 8 turnos» eran dos o tres mensajes y la
  narrativa se pedía mucho más seguido de lo diseñado. Ahora un turno es un
  mensaje del usuario, como ya contaban Codex y Antigravity.

## [0.1.9] - 2026-11-20

### Corregido
- Después de retomar una conversación en Claude Code, chaski no leía nada del
  transcript (ni comandos, ni turnos, ni la última respuesta) y seguía
  repitiendo el relevo: al retomar, Claude Code pasa a los hooks un
  `transcript_path` con el id nuevo que no existe, y sigue escribiendo en el
  archivo original. Si la ruta no existe, chaski usa el `.jsonl` escrito más
  recientemente de esa carpeta (en los últimos 15 min). La 0.1.8 no lo
  resolvía: comparaba esa ruta inexistente.

## [0.1.8] - 2026-11-20

### Corregido
- La 0.1.7 seguía repitiendo el relevo al retomar una sesión en Claude Code:
  comparaba el `session_id`, y al retomar Claude Code le da a la conversación un
  id nuevo y sigue escribiendo en el mismo transcript. Ahora la conversación se
  reconoce por su transcript, tanto al inyectar como al capturar. De paso, una
  sesión retomada ya no relee su transcript entero en la primera captura.

## [0.1.7] - 2026-11-20

### Corregido
- Al retomar una sesión (`resume`) cuyo relevo escribió ella misma, ya no se
  le repite ese relevo: el agente tiene el historial completo y el relevo solo
  podía estar más atrasado. Solo se avisa lo que la conversación no puede
  saber (commits de otros, turnos cortados en otras sesiones); si no hay nada,
  no se imprime nada.
- Cuando cambiaba la sesión que captura (una sesión retomada, o dos que
  alternan en el mismo proyecto), el contador de turnos desde la narrativa
  volvía a 0 mientras el transcript se releía entero: una narrativa de hacía
  minutos aparecía con mil turnos de atraso, el relevo mostraba «Última
  respuesta del agente» de más y la petición creía que iban mil turnos. Ahora
  la base es la cuenta del momento del cambio.

## [0.1.6] - 2026-11-20

### Agregado
- **La narrativa se pide antes de que se acabe la cuota** (#82, Claude Code,
  planes Pro, Max y Ultra). `chaski init --statusline` instala una statusline
  que envuelve la tuya (la sigue mostrando) y anota cuánto llevas de las
  ventanas de 5 h y 7 días; cuando una pasa del 80 % (`askNarrativeAtQuota`),
  `Stop` pide la narrativa, una vez por ventana. `chaski next` y `doctor`
  muestran la cuota; `uninstall` devuelve tu statusline.
- chaski se puede instalar como **plugin de Claude Code** (#80): el repositorio
  es a la vez el marketplace y el plugin (`/plugin marketplace add
  cristobalbn/chaski` y `/plugin install chaski@chaski`). Los hooks y la skill
  viajan con el plugin y se actualizan con él, sin rutas absolutas en
  `settings.json`. Con el plugin activo, `init` no registra los hooks de
  Claude Code y quita los que hubiera; si quedaron los dos, los de `init` se
  callan solos para no inyectar el relevo dos veces. Codex y Antigravity
  siguen con `init`.
- `.tambo/` trae su propio `.gitignore` con `*`, así que queda fuera de git
  aunque no se haya corrido `init` (como con el plugin solo).

## [0.1.5] - 2026-11-20

### Cambiado
- `chaski cost` separa las peticiones de narrativa en `Stop` (cada una agrega
  un turno) de las diferidas al turno siguiente (sin turno extra). Antes las
  contaba a todas como turnos extra.

### Agregado
- Etiquetas `<private>…</private>`: lo que el usuario marca así llega al disco
  como `[privado]`, en el relevo, la narrativa, la última respuesta, los
  comandos y `chaski share`. Una etiqueta sin cerrar tapa hasta el final.
- Aviso de turno cortado: si un turno empezó y no terminó (interrupción,
  ventana cerrada, cuelgue) después de la última captura, la sesión siguiente
  lo dice al arrancar, con el CLI y hace cuánto, y pide revisar `git status`
  antes de seguir. Usa el hook de entrega de la 0.1.4, así que funciona en los
  tres CLIs.
- En Claude Code, el hook `PreCompact` le indica al resumen de compactación
  que conserve lo que un relevo necesita: la tarea, lo decidido y lo
  descartado con su porqué, lo que quedó a medias con rutas y el siguiente
  paso. Compactar pierde contexto igual que cambiar de agente.
- `chaski share` anonimiza antes de publicar en `decisiones/`: la carpeta
  personal (con el nombre de usuario) pasa a `~` y los correos a `[correo]`.
  El relevo local no se toca.

## [0.1.4] - 2026-11-20

### Cambiado
- La petición de narrativa ya no aparece debajo de la respuesta (#73), en
  ninguno de los tres CLIs. Al terminar el turno solo se anota, y un hook nuevo
  se la entrega al agente al empezar el turno siguiente, para que guarde el
  relevo antes de responder: `UserPromptSubmit` en Claude Code y Codex,
  `PreInvocation` en Antigravity. Hace falta volver a correr `chaski init`
  (y en Codex, confiar en el hook nuevo). Mientras el hook de entrega no dé
  señales de vida, se sigue pidiendo en `Stop`.

### Agregado
- El relevo guarda la última respuesta del agente (`lastReply`), redactada y
  con vencimiento de 72 h, y la muestra si hubo trabajo después de la última
  narrativa. Cubre la sesión que se cierra antes de que se entregue la
  petición.
- Clave `askNarrativeAfterTurns` para cambiar cuántos turnos esperar antes de
  volver a pedir la narrativa (por defecto 8).
- `chaski doctor` dice, por CLI, si la petición de narrativa llega antes o
  después de la respuesta, y qué falta para que llegue antes (correr `init`,
  confiar en el hook en Codex o abrir una sesión).

## [0.1.3] - 2026-11-14

### Corregido
- `uninstall` ya no restaura el respaldo `.chaski-backup` encima de la config
  actual: eso borraba todo lo que el usuario había cambiado después del primer
  `init` (y la confianza de hooks de Codex). Ahora siempre quita solo lo de
  chaski, deja el respaldo en su sitio e imprime su ruta.
- `init` y `uninstall` reconocen sus hooks de Claude Code por la forma exacta
  del comando (script de entrada, evento y agente, o un wrapper de
  `~/.chaski/`), no porque el grupo contenga la palabra «chaski»: antes también
  borraban hooks del usuario con esa palabra en la ruta. `probe` hace lo mismo
  con la sonda, y `uninstall` ahora la quita también.
- Las notas del GitHub Release se cortaban en la primera «z»: la regex de
  `release.yml` usaba `\z`, que en JavaScript es una «z» literal. Ahora usa un
  fin de texto real.
- `pruneNarrativeAfterDays: 0` desactiva la poda de relevos con narrativa, como
  `pruneAfterDays: 0` desactiva la de los demás. Antes daba plazo cero y
  borraba en la próxima poda. `chaski doctor` muestra los plazos efectivos de la
  config en vez de «90 días en vez de 30» fijo.
- `init` agrega `chaski.local.json` al `.gitignore` aunque `.tambo/` ya
  estuviera ignorado; cada línea se comprueba por separado.
- `chaski next` muestra el total real de archivos sin commitear
  (`dirtyTotal`) en vez del tope de 50 de la lista.
- Los wrappers de `~/.chaski/` y `sonda.mjs` se escriben con `writeAtomic`
  (invariante 7); los `.sh` conservan el modo 0755.
- Textos con restos del renombre al inglés («writtenAt hace», «con narrative»,
  «sin signature», «usa el agent», «los facts»): ahora dicen «escrito hace»,
  «con narrativa», «sin firma», «usa el agente», «los hechos».
- `chaski --help`, `-h` y `help` salen con código 0 (un subcomando desconocido
  sigue saliendo con 1). El uso menciona `--version`/`-v` e incluye `init`,
  `doctor` y `uninstall`.

### Seguridad
- `excludePaths` pasa por el mismo control que `redact`: los patrones de forma
  catastrófica (`(a+)+`) o de más de 200 caracteres se descartan en vez de
  ejecutarse en cada turno.

## [0.1.2] - 2026-11-13

### Seguridad
- El render del relevo ya no se deja romper por texto ajeno (#53). Los bloques
  de código usan una valla más larga que cualquier corrida de comillas del
  contenido (un archivo llamado ```` ``` ```` cerraba el bloque de archivos
  sin commitear y lo siguiente se leía como Markdown). El código en línea
  (`lastFile`, refs, colisiones) tampoco se puede cerrar desde dentro. El tipo
  y el motivo de parada de un subagente se muestran en una sola línea y sin
  marcas de formato.
- La narrativa y las conclusiones de subagentes se redactan al renderizar,
  con los patrones propios de `redact` (#53). Antes la narrativa, que el agente
  escribe directo en `estado.json`, solo se redactaba al archivarla, y un
  patrón agregado después no alcanzaba lo ya guardado.

### Cambiado
- `chaski init` muestra en qué carpeta vive el relevo y por qué, cuando no es
  la carpeta actual (repo hijo único, raíz del repo desde una subcarpeta) o no
  hay repo (#47). Reporta cada archivo de proyecto con su ruta absoluta, y el
  resumen final nombra la carpeta. `chaski doctor` muestra la misma
  explicación.
- El preámbulo del relevo avisa cuando la narrativa es bastante más vieja que
  los hechos, porque `writtenAt` se renueva en cada captura (#53).
- README: para usar chaski basta npm; clonar es solo para contribuir o
  auditar (#46). Explica cómo se resuelve la carpeta del relevo (#47).
- `release.yml`: un `npm publish` fallido deja el workflow en rojo en vez de
  un aviso en verde, y publica con log verbose para diagnosticar OIDC.

## [0.1.1] - 2026-11-13

### Seguridad
- El relevo inyectado ya no puede cerrar su propio marco de datos: `inject.mjs`
  neutraliza toda corrida de tres o más `<` o `>` en el cuerpo y en el aviso de
  deriva. Una narrativa, una conclusión de subagente, un mensaje de commit o un
  nombre de rama que traía `<<<FIN-RELEVO-CHASKI>>>` dejaba el texto siguiente
  fuera del bloque "datos, no instrucciones".
- Las conclusiones de subagentes vencen a las 72 h. Desde el #28 se preservaban
  entre sesiones sin plazo, así que un texto de modelo no verificado se
  inyectaba en cada arranque de los tres CLIs hasta que lo desplazaran seis
  conclusiones nuevas.
- `estado.head` se valida como SHA antes de pasarlo a git (defensa en
  profundidad: hoy `git cat-file -e` ya rechaza un valor con forma de opción).

### Corregido
- Guardar la narrativa ya no hace que el relevo siguiente llegue con el aviso
  de posible manipulación (#49). Si lo firmado valida y todo lo que no es
  narrativa coincide con el estado actual, se inyecta con una nota de que la
  narrativa se firma en el próximo turno. Un relevo.md editado o hechos
  alterados en estado.json siguen disparando el aviso.
- `chaski doctor` ya no declara hooks registrados por palabras que aparecen
  solo en comentarios u otras claves (#51). Ahora cuenta un evento solo si,
  dentro de la clave de hooks que ese CLI lee, hay un comando que apunta a un
  script o wrapper de chaski. Un archivo que no se puede parsear se reporta como
  ilegible en vez de como registrado.
- `chaski init` ya no anuncia «quedó instalado / CLIs CONECTADOS» cuando los
  instaladores fallan (#50). El titular dice «NO quedó instalado» o
  «instalación incompleta», y el resumen separa los CLIs configurados ahora,
  los que ya estaban y los que no se pudieron configurar.
- `chaski init` es idempotente de verdad: si la configuración de un CLI (o un
  wrapper de `~/.chaski/`) ya es idéntica a la que escribiría, no la toca ni la
  respalda, y lo reporta como «ya configurado». Funciona aunque la
  configuración esté en solo lectura.
- Un relevo ya no afirma «Sin repositorio git» cuando `git rev-parse` no
  responde dentro del presupuesto de tiempo (#56): si existe `.git`, sigue
  siendo un repo y la rama sin leer se declara como recorte.
- Cuando el agente no tiene la skill `relevo`, la petición automática de
  narrativa trae la ruta absoluta real de `estado.json` en vez de la plantilla
  `.tambo/branches/<rama>/estado.json` «en la raíz del repositorio» (#48).
  Ahora funciona sin git (`sin-rama`), con el repo en una carpeta hija y con
  ramas cuyo slug lleva hash.

## [0.1.0] - 2026-11-07

### Comandos y herramientas de sesión
- `chaski next`: lee `~/.chaski/quota.json` (alimentado cuando un hook detecta
  un corte por `rate_limit`) y el `estado.json` de la rama actual para indicar
  a qué CLI disponible cambiar y qué archivos o pasos quedaron pendientes.
- `chaski cost`: reporta el gasto externo (`0 tokens · $0.00`, porque chaski
  no invoca modelos ni APIs externas) y contabiliza en `~/.chaski/cost.json`
  los turnos extra pedidos por chaski y las narrativas escritas por cada CLI.
- `chaski why [tema]`: busca decisiones pasadas en `.tambo/historia/entries.jsonl`
  (registro append-only donde `capture.mjs` preserva cada narrativa antes de que
  se reemplace), en las ramas activas y en `decisiones/`.
- `chaski share [tema] [--yes]`: publica la narrativa de la rama actual en un
  archivo único `decisiones/YYYY-MM-DD-<tema>.md`, pasando nuevamente el filtro
  de secretos y exigiendo confirmación interactiva salvo con `--yes`.
- `chaski version` / `chaski --version` / `chaski -v`: imprime la versión instalada; `doctor`
  también la incluye en su encabezado.

### Empaquetado y distribución en npm
- Publicación en el registro público de npm bajo `@cristobalbn/chaski` manteniendo
  el comando global `chaski`.
- Workflow `.github/workflows/release.yml` con Trusted Publishing (OIDC en npmjs.com
  vía `id-token: write` y `--provenance`) o secret `NPM_TOKEN`, automatizando la
  creación de tags `vX.Y.Z` y GitHub Releases con notas extraídas de `CHANGELOG.md`
  tras verificar que el commit pertenezca a `main`.
- Verificación de sincronización en `.github/workflows/test.yml` con avisos
  automáticos en PRs si se modifican `src/` o `skill/` sin incrementar `version` en
  `package.json` o si npm está desfasado respecto a `main`.
- Configuración de `.gitattributes` forzando `eol=lf` en ejecutables con shebang
  (`#!/usr/bin/env node`), evitando fallos en Linux/macOS al empaquetar desde Windows.
- Normalización del campo `bin.chaski` en `package.json` y archivo `.github/CODEOWNERS`.

### Rendimiento y extractores de transcript
- Reducción de subprocesos de `git` en `capture.mjs` e `inject.mjs`: la rama se
  resuelve una sola vez por corrida, el `HEAD` corto se toma de `git log -5` y
  `git status --porcelain --branch` entrega en un único subproceso los archivos
  sucios, la referencia upstream y los commits entrantes (`behind N`). En árbol
  limpio con upstream, los subprocesos bajan de 9 a 3 y la mediana de captura
  baja de 366 ms a 219 ms.
- Extractores de transcript actualizados para los formatos vigentes de Codex
  (`exec_command` / `shell_command` emparejados con `function_call_output` por
  `call_id`, ignorando el JavaScript interno de code mode) y Antigravity
  (`tool_calls` en `PLANNER_RESPONSE` emparejados con pasos `GENERIC`, contando
  el turno en `USER_INPUT`).

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
- Suite de 193 tests con `node:test` (42 suites), sin dependencias: contrato de
  payload y de transcript por CLI, nuevos comandos (`next`, `cost`, `why`,
  `share`, `version`), presupuesto de tiempo (`budget.mjs`), corpus de 15 formatos
  de credencial, invariantes del relevo, firma, escritura atómica y lectura
  incremental. Los fixtures son sintéticos: la forma viene de capturas reales, el
  contenido es inventado.
- `chaski probe`: instala una sonda que vuelca el payload crudo de los hooks de
  cada CLI, para cerrar los formatos no documentados y aportar fixtures.

### Convenciones
- El código va en inglés: módulos, funciones exportadas, campos de
  `estado.json` y la API pública. La documentación, los comentarios y los
  mensajes al usuario siguen en español, y el léxico del producto también
  (`chaski`, `.tambo/`, `relevo`, `quipu`).
- Los módulos pasan a `capture.mjs`, `inject.mjs`, `cli.mjs`, `lib/paths.mjs`,
  `lib/facts.mjs`, `lib/secrets.mjs`, `lib/relay.mjs`, `lib/ask.mjs` y
  `lib/budget.mjs`; el estado vive en `.tambo/branches/<rama>/`.
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

- La narrativa del relevo se pide sola. El hook `Stop` puede mantener al agent
  un turno más con `decision: block` para que la guarde, temprano y repartida,
  en vez de depender de que el usuario la escriba justo antes de quedarse sin
  cuota — el momento en que ya no se puede generar, porque la escribe el agent.
  Debounce de 12 minutos, solo con trabajo real detrás, y solo en Claude Code,
  donde el contrato está verificado. Se apaga con `askNarrative: false`.
  Respeta `stop_hook_active`: sin eso sería un bucle infinito de bloqueos.

- La conclusión de un subagente ya no la borra la captura del final del mismo
  turno. `promote()` la guardaba y el `Stop` del padre construía un estado
  nuevo sin el campo, así que la sección «Trabajo delegado» duraba lo que
  duraba el turno y una sesión nueva no la veía nunca (reportado en el #18). Se
  preserva como la narrativa, **también entre sesiones**: atarla a la sesión la
  borraría en la primera captura del CLI siguiente, que es justo el escenario
  que la herramienta existe para cubrir.
- El relevo muestra cuánto hace que se promovió cada conclusión. Si sobreviven
  entre sesiones, su antigüedad tiene que verse: una de hace tres días se lee
  distinto que una de hace diez minutos.

- La petición automática de la narrativa funciona en los tres CLIs. El formato
  no es el mismo: Claude Code y Codex usan `decision: "block"`, y Antigravity
  usa `decision: "continue"` y trata cualquier otro valor como permiso para
  parar — mandarle el `"block"` de Claude Code no daría error, no haría nada.
- El hook `Stop` de Codex se registra síncrono. Estaba en `async = true`, y la
  documentación de Codex dice que un hook en segundo plano no puede bloquear.
  El costo es esperar la captura (~340 ms) al cerrar cada turno en Codex.
- En Antigravity la protección contra bucles la pone chaski: no existe un
  equivalente de `stop_hook_active`, así que se usa `executionNum` y solo se
  pide en la primera vuelta del bucle.
- Un test corre una captura normal en los tres CLIs y falla si stderr trae
  algo. Nace de un bug de esta misma ronda: una función usada sin importar, que
  `node --check` no veía, que los tests no veían porque la excepción ocurría
  después de escribir el relevo, y que el hook atrapaba saliendo con código 0.

- La petición de la narrativa ya no aparece en cada turno. Tenía dos causas.
  El contador `turnsAtNarrative` se comparaba contra `previo.narrativeWrittenAt`,
  pero la narrativa se escribe fuera de banda —directo en `estado.json`—, así
  que en la captura siguiente los dos valores coincidían y el contador quedaba
  clavado en cero: con `turns` en 2.049, la política creía que habían pasado
  2.049 turnos desde la última narrativa y la pedía cada vez que expiraba el
  debounce. Ahora se compara contra `narrativeStamp`, la marca que el propio
  código ya contabilizó.
- Y una narrativa escrita hace menos de 20 minutos no se vuelve a pedir, pase
  lo que pase. Sin eso, una sesión que mergeaba tres PR recibía una petición
  por merge: cada uno mueve el HEAD y «hay commits nuevos» disparaba aunque la
  narrativa fuera de hace un minuto.
- La primera línea del mensaje se lee como una petición y no como un fallo: es
  la única que el CLI muestra en su resumen, y la muestra con «Stop hook error»
  delante.
- `init` ya no borra el estado de confianza de los hooks de Codex. Codex lo
  guarda en un `[hooks.state]` con un `trusted_hash` dentro del bloque
  delimitado de chaski, así que cada `init` obligaba a aceptar los hooks otra
  vez y a abrir Codex dos veces, porque el permiso recién se aplica en la
  sesión siguiente. Ahora se rescata y se vuelve a escribir dentro del bloque,
  para que `uninstall` siga siendo una resta exacta.

- `init` ya no escribe archivos de proyecto en la carpeta desde la que se lo
  invoca cuando esa carpeta no es el repositorio. Antes instalaba la skill y el
  `AGENTS.md` en las dos, para que un agent abierto en la carpeta contenedora
  tuviera la skill a mano; pero una contenedora suele tener varios proyectos
  dentro, y ahí la skill aplica a todos y el `AGENTS.md` habla de chaski a
  quien trabaja en otro proyecto. El texto de la petición automática pasa a ser
  autosuficiente: trae las instrucciones para escribir la narrativa sin skill.
- Ya no se promueve como conclusión de un subagente algo que no lo es. En
  producción, la sección «Trabajo delegado» quedó con cuatro mensajes del
  usuario presentados como conclusiones, con la etiqueta vacía: algún CLI
  dispara el evento con el último mensaje de la conversación, que puede ser el
  del usuario. Lo que llegaba era el campo `agent_type` presente y **vacío**,
  no ausente, así que el `??` no lo cubría. Ausente se sigue aceptando con un
  nombre genérico; presente y vacío se rechaza.

- La petición de la narrativa ya no se muestra como error en Claude Code. Se
  emite con `hookSpecificOutput.additionalContext` en vez de
  `decision: "block"`: los dos mantienen al agent un turno más y respetan
  `stop_hook_active` y el tope de continuaciones, pero `block` hace que la
  interfaz use la palabra «error» —la misma que para un hook que de verdad
  falló— y el usuario veía un error en cada petición. La documentación llama a
  `additionalContext` «non-error feedback for Claude» y el rótulo pasa a ser
  «Stop hook feedback». En Codex y Antigravity el formato no cambia: su
  documentación no describe un equivalente.

- El texto de la petición pasa de veinte líneas a cuatro. Lo muestra el CLI en
  pantalla, y explicaba ahí las cuatro secciones, el presupuesto de palabras y
  el camino sin skill — detalle que ya vive en la skill `relevo`, que es donde
  se lee cuando hace falta. Queda una línea para el caso sin skill, que es lo
  mínimo que lo hace autosuficiente. Hay un test que falla si vuelve a crecer.
- Lo que chaski **no** puede quitar: las líneas `Ran 1 stop hook` y
  `Stop hook feedback` las pinta Claude Code al ejecutar cualquier hook, y
  `suppressOutput` no tiene efecto sobre ellas.

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

### Descartado por términos de uso
- Reserva de proveedor como `synth-only`: invocar una suscripción de consumidor
  desde un hook en segundo plano (`claude -p`, `codex exec`, `agy -p`) está
  prohibido por los términos de uso de los proveedores. En su lugar, la
  narrativa se pide dentro de la sesión interactiva activa.
