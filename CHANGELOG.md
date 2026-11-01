# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Este proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [No publicado]

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
  recupera. Configurable con `limpiarTrasDias`; `0` la desactiva. Un relevo
  de rama viva no se borra nunca. Si git no responde, no se borra nada.
- CI en GitHub Actions: la suite corre en Linux, Windows y macOS por tres
  versiones de Node, y falla si se declara alguna dependencia.
- Promoción de los resultados de subagentes: al terminar, su conclusión sube
  al relevo del padre con atribución, y si no terminó por `end_turn` se avisa
  que puede no haber acabado. Su exploración se descarta.
- Suite de 88 tests con `node:test`, sin dependencias: contrato de payload y
  de transcript por CLI, corpus de 15 formatos de credencial, invariantes del
  relevo, firma, escritura atómica y lectura incremental. Los fixtures son
  sintéticos: la forma viene de capturas reales, el contenido es inventado.
- `chaski probe`: instala una sonda que vuelca el payload crudo de los hooks de
  cada CLI, para cerrar los formatos no documentados y aportar fixtures.

### Corregido en la revisión del 2026-11-01
-  ya no reescribe una configuración que no puede parsear. Un
   con una coma final hacía que reemplazara el archivo entero
  y el usuario perdía su configuración en el primer comando que corría.
- La escritura atómica ya no borra el destino para forzar el : ese
  camino podía dejar sin relevo ni original.
- Dos ramas distintas ya no comparten relevo ( y ).
- Un renombre es un archivo y no dos, y las rutas con acentos son legibles.
- El estado topa la lista de archivos sucios: miles hacían un 
  de más de un megabyte reescrito en cada turno.
-  termina con código distinto de cero si algún CLI falló.

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

- Disparo automático de la narrativa. Hoy la narrativa solo se escribe con
  `/relevo` a mano.
- `chaski next`, `chaski cost`, `chaski why` y `chaski share`.
- Reserva de proveedor como `synth-only`.
- CI, y verificación en macOS y Linux: todo se probó en Windows.
