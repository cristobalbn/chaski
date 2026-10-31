# Política de seguridad

## Reportar una vulnerabilidad

No abras un issue público para un problema de seguridad.

Usa la pestaña **Security → Report a vulnerability** del repositorio en GitHub
(advisory privado). Incluye:

- Versión de chaski y de Node.
- Sistema operativo.
- Qué CLIs tienes configurados.
- Pasos para reproducir.
- Impacto que observaste.

Respondo en un plazo razonable y coordino la divulgación antes de publicar el
arreglo.

## Modelo de amenaza

Vale la pena que sepas a qué está expuesta esta herramienta, porque es una que
se ejecuta sola en cada turno de tus sesiones.

### Qué puede hacer chaski

- **Leer:** el transcript de tus sesiones, la salida de `git` en tu proyecto,
  y sus propios archivos de configuración.
- **Escribir:** `.tambo/` dentro del proyecto, `~/.chaski/`, los archivos de
  configuración de los CLIs que habilitaste, y `.gitignore`, `AGENTS.md` y
  `.claude/skills/relevo/` durante `init`.
- **Red:** ninguna. chaski no hace ninguna petición de red, nunca.

### Qué NO hace

- No invoca `claude -p`, `codex exec` ni `agy -p`.
- No hace commits ni modifica tu historial de git.
- No ejecuta scripts del repositorio en el que corre.
- No abre puertos ni escucha conexiones.
- No tiene dependencias de runtime, así que no hay árbol de npm que comprometer.

### Riesgos conocidos y cómo se contienen

**Inyección de prompt a través del relevo.** El relevo se inyecta en el contexto
de un agente con permisos de escritura, así que quien pueda escribir en
`.tambo/` podría intentar colar instrucciones. Contención: el bloque se declara
como datos entre delimitadores explícitos, se firma con HMAC contra una clave
local que nunca se versiona, y un relevo cuya firma no valida se inyecta
rotulado como no verificado en lugar de pasar por legítimo. Además `.tambo/`
está en `.gitignore`, así que no viaja entre máquinas.

**Captura accidental de secretos.** El transcript contiene todo lo que pasó por
la sesión. El filtro de `src/lib/secretos.mjs` corre antes de escribir a disco,
no solo antes de enviar algo. Si encuentras un formato de credencial que se nos
escapa, es un reporte de seguridad válido y lo agradecemos.

**chaski como vector de cadena de suministro.** Instalarlo significa registrar
un comando que tus CLIs van a ejecutar solos. Para que puedas verificarlo:
`chaski doctor` imprime el comando exacto registrado en cada configuración —
son unas diez líneas. Revísalo después de instalar y después de cada
actualización. Si prefieres no confiar en un paquete publicado, clona el
repositorio y ejecuta desde el código fuente: son ~1.100 líneas sin dependencias.

## Versiones soportadas

Mientras el proyecto esté antes de 1.0, solo se da soporte a la última versión
publicada.
