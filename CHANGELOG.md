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
- `chaski probe`: instala una sonda que vuelca el payload crudo de los hooks de
  cada CLI, para cerrar los formatos no documentados y aportar fixtures.

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

  Los tres adaptadores quedaron validados contra payloads y transcripts
  reales. Cada CLI usa un formato de transcript distinto, y hay un extractor
  por formato:
  - Claude Code: bloques con `tool_use` y `tool_result`.
  - Antigravity: pasos con `step_index`, `type` y `content` en texto plano.
  - Codex: envoltorio `{timestamp, ordinal, type, payload}`.

### Pendiente antes de 1.0
- Suite de tests con fixtures de los tres formatos.
- Suite de tests con `node:test` y fixtures de transcript por versión de CLI.
- Disparo automático de la narrativa (implementado y apagado por defecto).
