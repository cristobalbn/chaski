# chaski

[![test](https://github.com/cristobalbn/chaski/actions/workflows/test.yml/badge.svg)](https://github.com/cristobalbn/chaski/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@cristobalbn/chaski.svg)](https://www.npmjs.com/package/@cristobalbn/chaski)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Dependencias](https://img.shields.io/badge/dependencias-0-brightgreen.svg)](package.json)

**Relevo de contexto entre agentes de código.** Cuando se agota la cuota de un
CLI, el siguiente arranca sabiendo qué se decidió, qué quedó a medias y cuál es
el siguiente paso — sin vigilar contadores ni copiar y pegar nada.

Los chaskis eran los mensajeros del imperio inca: cada uno corría un tramo y en
el **tambo** entregaba el mensaje al siguiente. Lo que llevaban era un registro
de nudos. Mismo problema, misma solución.

Compatible con **Claude Code**, **Codex CLI** y **Antigravity CLI (`agy`)**. Con
uno solo ya sirve: el relevo entre sesiones de la misma herramienta tiene valor
propio.

---

## El problema

Si pagas dos o tres suscripciones de $20 al mes y rotas entre ellas cuando se
agotan, cada rotación cuesta entre diez y treinta minutos de volver a explicar.
Y a veces llega con el código a mitad de un refactor, que es cuando entregarle
el teclado a un agente sin contexto rompe algo que funcionaba.

Los archivos de instrucciones (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) describen
el *proyecto*, no la *sesión*: son estables y los escribes tú. La compactación
automática de cada CLI vive dentro de ese CLI y no cruza al de al lado. Y pedir
un resumen a mano funciona exactamente hasta el día en que te olvidas.

---

## Índice

- [Instalación](#instalación)
  - [Si le pasaste este enlace a un agente](#si-le-pasaste-este-enlace-a-un-agente)
  - [Opción 1 — npm (recomendada)](#opción-1--npm-recomendada)
  - [Opción 2 — desde el código fuente](#opción-2--desde-el-código-fuente)
  - [Dos pasos después de instalar](#dos-pasos-después-de-instalar)
  - [Actualizar y desinstalar](#actualizar)
- [Uso diario](#uso)
  - [Qué escribir en el chat del agente](#la-misma-petición-en-los-tres-agentes)
  - [La narrativa se pide sola](#la-narrativa-se-pide-sola)
  - [Referencia de comandos en terminal](#referencia-de-comandos-en-terminal)
- [Configuración (`chaski.json`, `chaski.local.json`, `~/.chaski/config.json`)](#configuración)
- [Equipos y repositorios compartidos](#equipos-y-repositorios-compartidos)
- [Arquitectura](#arquitectura)
- [Seguridad y términos de uso](#seguridad)
- [Límites conocidos](#límites-conocidos)

---

## Instalación

**Requisitos:** Node.js ≥ 20. Nada más — cero dependencias de runtime.

### Si le pasaste este enlace a un agente

Si estás leyendo esto porque alguien te pidió instalar chaski en su proyecto,
sigue exactamente esto y no hace falta que leas el resto del README.

```bash
node --version                      # debe ser >= 20; si no, detente y avisa
npm install -g @cristobalbn/chaski  # o: npm install -g github:cristobalbn/chaski
cd <el proyecto del usuario>
chaski init
chaski doctor
```

Después:

1. **Muéstrale al usuario el resumen que imprime `chaski init`.** Explica qué
   quedó instalado, qué tiene que hacer y qué comandos tiene. No lo
   parafrasees ni lo resumas: ya está escrito para que lo lea una persona.
2. **Pega también la salida de `chaski doctor`**, que dice qué CLIs quedaron
   conectados y qué comando exacto se registró en cada configuración. El
   usuario debería poder auditarlo.
3. **Avísale de los dos pasos que solo él puede hacer**, o va a creer que la
   herramienta está rota:
   - **reiniciar las sesiones abiertas**, porque los hooks se cargan al abrir
     la sesión;
   - **y si tiene Codex, aceptar los hooks** cuando se lo pregunte («trust
     all»). Sin eso Codex no ejecuta ninguno, y el permiso recién se aplica
     en la sesión siguiente, así que tiene que abrirlo dos veces.
4. **Dile las tres cosas que importan**, con tus palabras:
   - no tiene que hacer nada más, chaski corre solo;
   - cuando se le agote la cuota de un CLI, que abra otro **en la misma
     carpeta**;
   - escribir **«relevo»** en el chat agrega el «por qué», en cualquiera de los tres.

**Si algo falla**, no improvises una solución: pégale al usuario la salida de
`chaski doctor` y dile qué paso falló. Los modos de fallo conocidos están en
[Límites conocidos](#límites-conocidos).

**No instales con `npx`**: los hooks guardan una ruta absoluta y el caché de
`npx` es temporal. `init` aborta si detecta ese caso.

**No agregues configuración que no te pidieron.** chaski funciona sin
`chaski.json`; crearlo «por las dudas» solo agrega algo que mantener.

### Opción 1 — npm (recomendada)

```bash
npm install -g "@cristobalbn/chaski"
cd tu-proyecto
chaski init
```

*(Las comillas alrededor de `"@cristobalbn/chaski"` evitan que PowerShell interprete `@` como operador de splatting; en bash/zsh funcionan con o sin comillas).*

También se puede instalar directo desde GitHub:

```bash
npm install -g github:cristobalbn/chaski
```

> **No uses `npx chaski init`.** Los hooks guardan una ruta absoluta a los
> scripts, y el caché de `npx` es temporal: la ruta desaparece y los hooks
> fallan en silencio. `init` detecta ese caso y aborta con una explicación.

### Opción 2 — desde el código fuente

Si prefieres leer lo que vas a ejecutar antes de instalarlo —algo razonable en
una herramienta que corre sola en cada turno— clona el repositorio. Son ~3.100
líneas de JavaScript sin dependencias:

```bash
git clone https://github.com/cristobalbn/chaski.git
cd chaski
npm run check          # verifica la sintaxis; no hay build
npm test               # node:test, sin dependencias
cd ../tu-proyecto
node ../chaski/src/cli.mjs init
```

### Dónde escribe `init`, y dónde no

Los hooks van a **nivel de usuario** y sirven para todos tus proyectos. Los
archivos de proyecto —la skill, el bloque de `AGENTS.md`, la línea del
`.gitignore`— van **solo en el repositorio**, nunca en la carpeta desde la que
invocaste `init` si esa carpeta no es el repositorio.

Esto importa si tienes una carpeta contenedora con varios proyectos dentro:
instalar ahí la skill la aplicaría a todos, y el `AGENTS.md` le hablaría de
chaski a quien esté trabajando en otro proyecto. Todo lo de un proyecto vive en
su proyecto.

Si abres un agente en la carpeta contenedora, el relevo se inyecta igual
—los hooks son de usuario y chaski resuelve el repositorio hijo— y la petición
automática de la narrativa trae las instrucciones completas para escribirla sin
la skill. Lo que no tendrás ahí es el atajo `/relevo`.

### Qué hace `init`

1. Detecta cuáles de los tres CLIs tienes instalados y registra los hooks **a
   nivel de usuario**, con rutas nativas del sistema operativo. Respalda cada
   archivo de configuración antes de tocarlo.
2. Agrega `.tambo/` y `chaski.local.json` a tu `.gitignore`.
3. Instala la skill `relevo` dos veces: en `.claude/skills/relevo/`, que lee
   Claude Code, y en `.agents/skills/relevo/`, que leen Codex y Antigravity.
   Es el mismo archivo y reconoce las mismas peticiones: **«relevo»**,
   **«guarda el relevo»** y **«actualiza el relevo»**.
4. Agrega una sección de relevo a tu `AGENTS.md`. Si ya existe, añade o actualiza
   un bloque delimitado con las peticiones comunes y conserva el resto del texto.

### Dos pasos después de instalar

Hay dos cosas que `init` no puede hacer por ti, y sin ellas parece que la
herramienta no funciona.

**1. Reinicia tus sesiones.** Los CLIs cargan los hooks al abrir la sesión, así
que una que ya estaba abierta no los tiene y `.tambo/` va a seguir vacío.
Ciérrala y vuelve a abrirla.

**2. En Codex, acepta los hooks.** La primera vez que abras Codex te va a
preguntar si confías en ellos. **Tienes que aceptar** —aparece como «trust
all»— o no ejecuta ninguno. Y el permiso, aunque queda guardado, recién se
aplica en la sesión siguiente: cierra Codex y vuelve a abrirlo una vez más.

Si algo no captura, `chaski doctor` detecta exactamente este caso y te dice
qué falta:

```
⚠ codex: hooks registrados pero nunca ejecutados.
  Codex pide confiar en los hooks la primera vez que lo abres.
  Acepta ("trust all") y vuelve a abrirlo: el permiso se aplica
  desde la sesión siguiente.
```

### Verificar la instalación

```bash
chaski doctor
```

Imprime el comando exacto que quedó registrado en cada configuración, el último
latido de cada CLI, el estado del relevo y **qué sale de tu máquina**. Revisa esa
salida antes de confiar en la herramienta: son unas diez líneas.

### Capturar payloads (`chaski probe`)

Herramienta de diagnóstico: instala una sonda que vuelca a disco el payload
crudo que cada CLI le pasa a sus hooks. Sirve para ver por qué un hook no
captura, y para aportar fixtures si agregas soporte a otro CLI.

```bash
chaski probe              # instala la sonda en los CLIs que tengas
# abre cada CLI en modo INTERACTIVO, escribe algo, ciérralo
chaski probe --show       # mira lo capturado
chaski probe --clean      # quita la sonda
```

Tiene que ser una sesión interactiva: ninguno de los tres dispara hooks en
modo headless.

### Actualizar

```bash
npm install -g "@cristobalbn/chaski"   # o: npm install -g github:cristobalbn/chaski
cd tu-proyecto
chaski init                            # repítelo en cada proyecto que uses con Chaski
```

**Ejecutar `chaski init` no es opcional.** Los hooks se registran con la ruta absoluta
de los scripts, así que una actualización que mueva la carpeta de instalación
—o que cambie un nombre de archivo— deja la configuración apuntando a algo que
ya no existe, y el CLI imprime un error de módulo no encontrado en cada turno.
`chaski init` reescribe las rutas y es idempotente: correrlo de nuevo sobre una
instalación sana no cambia nada.

También actualiza las copias de la skill y el bloque de peticiones de `AGENTS.md`
en ese proyecto. Las secciones antiguas sin delimitadores se conservan, porque
pueden contener instrucciones escritas por ti.

Si ya estás viendo ese error, corre `chaski init`. Pero **la sesión que ya lo
tiene abierto no lo va a ver desaparecer**: los CLIs leen su configuración de
hooks una sola vez, al arrancar, así que `init` corrige la ruta para la
próxima sesión, no para la que está corriendo. Cierra esa sesión y abre una
nueva. `chaski doctor` muestra el comando que quedó registrado, por si quieres
confirmarlo antes de reabrir.

Desde la versión actual los dos nombres de archivo anteriores a la
homologación al inglés —`capturar.mjs` y `leer.mjs`— siguen funcionando como
puentes, así que una configuración vieja ya no produce ese volcado de Node:
captura e inyecta igual, y el hook de inicio de sesión imprime una línea
recordando que conviene correr `init`. Los puentes existen para que
actualizar no rompa nada, no para quedarse: `init` sigue siendo el paso
correcto.

### Desinstalar

```bash
chaski uninstall
```

Revierte cada configuración desde su respaldo. Tus relevos en `.tambo/` quedan
en disco porque son tuyos; bórralos a mano si quieres.

---

## Uso

1. Abre Claude Code, Codex o agy **en la raíz del proyecto** y trabaja normalmente.
2. Antes de cambiar de agente, escribe **«relevo»** en su chat y espera a que
   confirme el guardado. Así queda anotada también la intención del trabajo.
3. Abre otra terminal, **`cd` a esa misma carpeta**, e inicia el siguiente CLI.
4. Escribe **«continúa desde el relevo»** para retomar el siguiente paso pendiente.

La captura de hechos y la lectura al arrancar son automáticas. Si se agota la
cuota antes de pedir el relevo, siguen disponibles los hechos guardados, aunque
puede faltar la narrativa reciente. No ejecutes `chaski init` en cada cambio:
basta al configurar el proyecto y al actualizar Chaski.

**El `cd` no es opcional:** el relevo vive dentro del proyecto, así que cada
proyecto tiene el suyo y no se mezclan. Tampoco se mezclan las ramas — volver a
una rama que dejaste hace una semana te devuelve su contexto.
No necesitas trabajar dentro del código de Chaski para usarlo en otro proyecto.

### La narrativa se pide sola

El relevo tiene dos mitades. Los **hechos** —archivos, diff, commits, exit
codes— los saca chaski de git y del transcript sin costo ni intervención. La
**intención** —qué intentabas, qué quedó a medias y dónde, el siguiente paso—
solo la puede escribir el agent que estuvo en la conversación.

Pedirla a mano tiene un defecto que no es de disciplina: **la narrativa
consume cuota, porque la escribe el agent**. Quien espera a estar al límite
descubre que el momento en que más la necesita es el único en que ya no se
puede generar. Y el corte por cuota es abrupto: deja la tarea a medias, que es
exactamente cuando el siguiente agent necesita saber dónde quedó.

Por eso chaski la pide por su cuenta, **temprano y repartida**, mientras sobra
cuota. Al terminar un turno con trabajo detrás, el hook puede mantener al agent
un turno más con una instrucción: guarda la narrativa, con énfasis en lo que
quedó en vuelo. No se invoca ningún modelo por fuera —eso lo prohíben los
términos de los tres proveedores— sino que se le pide al agent que ya está en
sesión.

Cada petición cuesta un turno de tu conversación, así que los límites son
conservadores, y en este orden:

1. **Una narrativa escrita hace menos de 20 minutos no se vuelve a pedir**,
   pase lo que pase. Es el corte más fuerte: lo que vuelve insufrible a esta
   función no es pedirla de más en una sesión larga, es pedirla dos veces
   seguidas.
2. **12 minutos** de debounce entre peticiones.
3. Solo si hay trabajo real detrás: archivos sin commitear, commits nuevos o
   comandos ejecutados.
4. Y solo si la narrativa falta, quedó **8 turnos** atrás, o hay commits
   nuevos.

| | |
|---|---|
| Apagarlo | `"askNarrative": false` en `chaski.json` o `chaski.local.json` |
| Cómo se ve | Cuatro líneas bajo el rótulo **«Stop hook feedback»**. Ese rótulo y el `Ran 1 stop hook` los pinta Claude Code al ejecutar cualquier hook y no se pueden suprimir; lo nuestro es el texto, y es corto a propósito porque ocupa pantalla del usuario. Se emite con `hookSpecificOutput.additionalContext`, que la documentación llama «non-error feedback»: mantiene el turno extra y las protecciones contra bucles sin rotularse como error. En una versión de Claude Code anterior a ese campo la petición no llega — no rompe nada |
| Dónde funciona | Los tres, con el contrato de cada uno: `hookSpecificOutput.additionalContext` en Claude Code, `decision: "block"` en Codex y `decision: "continue"` en Antigravity, que trata cualquier otro valor como permiso para parar |
| En Codex | su hook `Stop` se registra **síncrono**, porque un hook en segundo plano no puede bloquear. Esperas la captura (~220 ms) al cerrar cada turno |

### La primera vez, verifica

Al abrir el segundo CLI, pregúntale *«¿qué sabes del estado de este trabajo?»*.
Si responde con los archivos tocados y qué quedó a medias, funcionó. Si no,
`chaski doctor` te dice qué hook no quedó registrado y dónde.

### La misma petición en los tres agentes

En el **chat de cualquiera de los tres agentes**, usa siempre las mismas frases:

| Qué quieres hacer | Qué escribes en el chat | Qué hace el agente |
|---|---|---|
| **Guardar la intención** antes de cerrar o cambiar de CLI | `relevo`, `guarda el relevo` o `actualiza el relevo` | Escribe `narrative`, `narrativeAuthor` y `narrativeWrittenAt` en `.tambo/branches/<slug>/estado.json` y confirma en una línea el siguiente paso |
| **Retomar el trabajo** al abrir otro CLI o nueva sesión | `continúa desde el relevo` | Lee el bloque `<<<RELEVO-CHASKI>>>`, lo contrasta con el código actual y retoma el paso pendiente **sin sobrescribir** la narrativa |
| **Verificar que recibió el relevo** | `¿qué sabes del estado de este trabajo?` | Resume los archivos modificados, el diff y lo pendiente |

Los atajos nativos siguen disponibles si prefieres invocar la skill directamente:

| Agente | Atajo nativo para guardar |
|---|---|
| [Claude Code](https://code.claude.com/docs/en/skills) | `/relevo` |
| [Codex CLI](https://learn.chatgpt.com/docs/build-skills) | `$relevo` o `/skills` → `relevo` |
| [agy](https://antigravity.google/docs/skills/#slash-command-conversion) | `/relevo` |

Si la skill aún no aparece tras actualizar, abre una sesión nueva en ese proyecto
(en agy también puedes ejecutar `/skills reload`).

Los **hechos** —archivos, diff, exit codes, commits— se escriben solos en cada
turno, sin costo. La **narrativa** —qué estás intentando, qué decidiste, qué
descartaste y por qué— la escribe el agente cuando pides **«relevo»** (o cuando
chaski se la pide automáticamente).

No es obligatorio pedirlo a mano. Sin narrativa el relevo sigue siendo útil,
porque los hechos son lo que evita que el siguiente agente rompa algo; la
narrativa es lo que evita que reabra decisiones ya cerradas.

### Referencia de comandos en terminal

| Comando | Cuándo usarlo | Qué hace y dónde lee/escribe |
|---|---|---|
| `chaski init` | Al instalar chaski en un proyecto o tras actualizar | Registra los hooks a nivel de usuario (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/antigravity/hooks/hooks.json`), agrega `.tambo/` y `chaski.local.json` a `.gitignore`, instala la skill en `.claude/skills/relevo/` y `.agents/skills/relevo/`, y actualiza el bloque de relevo en `AGENTS.md`. Sale con código `1` si algún CLI falló |
| `chaski doctor` | Para verificar la instalación o diagnosticar si algo no captura | Muestra la versión instalada, los hooks registrados por CLI, el último latido en `~/.chaski/latidos.json`, si `.tambo/` está ignorado en git, el estado y firma del relevo de la rama actual y qué sale de tu máquina. Siempre sale con código `0` |
| `chaski next` | Al agotarse la cuota de un CLI o antes de retomar | Lee `~/.chaski/quota.json` (alimentado cuando un hook detecta un corte por `rate_limit`) y `.tambo/branches/<slug>/estado.json` para indicar qué CLI está disponible (`→`), cuántos archivos hay sin commitear y cuál es el paso pendiente |
| `chaski cost` | Para revisar cuántos turnos extra pidió chaski | Reporta el gasto externo (`0 tokens · $0.00`, porque chaski nunca llama a APIs ni modelos externos) y contabiliza desde `~/.chaski/cost.json` las peticiones automáticas y narrativas escritas por cada CLI en los últimos 7 días y en total |
| `chaski why [tema]` | Para consultar por qué se tomó o descartó una decisión pasada | Busca en `.tambo/historia/entries.jsonl` (donde `capture.mjs` archiva cada narrativa antes de que se reemplace), en las ramas activas de `.tambo/branches/` y en `decisiones/`. Si pasas `tema`, filtra por texto o nombre de rama |
| `chaski share [tema] [--yes]` | Para compartir una decisión de tu relevo local con el equipo en git | Toma la narrativa de la rama actual, vuelve a pasar el filtro de secretos (`src/lib/secrets.mjs`), muestra la vista previa de `decisiones/YYYY-MM-DD-<tema>.md` y pide confirmación interactiva antes de escribir (o publica directo con `--yes`). Nunca sobrescribe un archivo existente; si ya existe, añade sufijo `-2`, `-3`, etc. Sale con código `1` si la rama no tiene narrativa |
| `chaski probe [--show \| --clean]` | Diagnóstico de payloads de hooks o creación de nuevos fixtures | `chaski probe` instala una sonda temporal en `~/.chaski/sonda.mjs`; `--show` muestra los payloads capturados en `~/.chaski/sonda.log`; `--clean` restaura los hooks normales de chaski |
| `chaski uninstall` | Para quitar los hooks de chaski de tus CLIs | Restaura `~/.claude/settings.json`, `~/.codex/config.toml` y `~/.gemini/antigravity/hooks/hooks.json` desde sus respaldos `.chaski-backup` (o resta el bloque de chaski). Conserva `.tambo/` y `~/.chaski/` |
| `chaski version` (`--version`, `-v`) | Para consultar la versión instalada | Imprime `chaski X.Y.Z` desde `package.json` |

---

## Arquitectura

La idea central es **separar hechos de intención**:

- **Hechos** (determinísticos, gratis, instantáneos): se derivan de git y del
  transcript. Cero tokens, cero red, y exactos por construcción.
- **Intención** (requiere un modelo): por qué se eligió un enfoque, qué falta.
  Esto no está en el diff; está en la conversación.

El 70% del valor de un relevo está en la capa de hechos, y no cuesta nada. Por
eso el modelo es el último recurso y no el primero.

| Archivo | Cuándo corre | Qué hace |
|---|---|---|
| `src/capture.mjs` | hook `Stop` en los tres CLIs; también `SessionEnd`, `PreCompact`, `SubagentStop` y `StopFailure` en Claude Code | Lee el transcript desde una marca de agua y git; escribe `relevo.md`, `estado.json` y `.tambo/historia/` |
| `src/inject.mjs` | hook `SessionStart` | Imprime el relevo; lo que imprime entra al contexto del agente |
| `src/cli.mjs` | a mano | `init`, `doctor`, `next`, `cost`, `why`, `share`, `version`, `uninstall`, `probe` |
| `skill/SKILL.md` | al pedir «relevo» | Instrucciones para que el agente escriba la narrativa |

Archivos que genera en tu proyecto:

```
.tambo/
  branches/
    main/relevo.md          ← lo que se inyecta
    main/estado.json        ← hechos, marca de agua, firma
    feat-pagos/relevo.md    ← otra rama, otro contexto
  historia/
    entries.jsonl           ← narrativas históricas (append-only, para chaski why)
```

Y en `~/.chaski/`: la clave de firma, los latidos de cada CLI, el estado de
cuota (`quota.json`), la contabilidad de turnos (`cost.json`) y la config global.

El diseño completo, con los riesgos y la investigación de términos de uso, está
en [`docs/diseno.html`](docs/diseno.html). Describe el diseño entero, incluidas
piezas que todavía no existen: abre con una tabla que distingue lo construido
de lo pendiente.

La auditoría de noviembre de 2026 —qué se revisó, qué se encontró y qué se
decidió **no** arreglar, con el motivo— está en
[`docs/auditoria-2026-11.md`](docs/auditoria-2026-11.md). Si vas a cambiar algo
aquí, la sección de límites conocidos te ahorra descubrirlos de nuevo.

---

## Configuración

Todo tiene valores por defecto razonables. No hace falta configurar nada.

### `chaski.json` — política del proyecto, **se versiona**

```json
{
  "redact": ["MI_PATRON_SECRETO_[A-Z0-9]+"],
  "excludePaths": ["^infra/secretos/", "\\.tfstate$"]
}
```

| Clave | Qué hace |
|---|---|
| `redact` | Expresiones regulares extra para redactar antes de escribir |
| `excludePaths` | Rutas que nunca aparecen en el relevo |
| `pruneAfterDays` | Días antes de borrar el relevo de una rama que ya no existe. Por defecto 30; `0` desactiva la limpieza |
| `pruneNarrativeAfterDays` | Lo mismo para los relevos que tienen narrativa. Por defecto 90 |
| `askNarrative` | Si es `false`, desactiva las peticiones automáticas de narrativa en el hook `Stop` |

Los relevos con narrativa viven el triple a propósito: los hechos se
recalculan desde git en cualquier momento, pero la narrativa existe solo
porque alguien la escribió y no se recupera. Un relevo de rama viva no se
borra nunca, sin importar la antigüedad.

### `chaski.local.json` — tu máquina en este proyecto, **en `.gitignore`**

Mismas claves. `init` lo agrega a `.gitignore` automáticamente.

### `~/.chaski/config.json` — global de tu usuario, para todos tus proyectos

Mismas claves. Se aplica a cualquier repositorio en tu máquina sin tener que
crear archivos por proyecto.

### Orden de precedencia al combinar los tres niveles

Cuando existen dos o tres archivos a la vez, chaski los combina así:
- **Claves escalares** (`pruneAfterDays`, `pruneNarrativeAfterDays`, `askNarrative`): manda el nivel más específico (`chaski.local.json` > `chaski.json` > `~/.chaski/config.json`).
- **Listas de seguridad** (`redact` y `excludePaths`): **se concatenan** entre los tres niveles (`global + proyecto + local`), de modo que una configuración local siempre suma patrones de redacción o rutas excluidas y nunca desactiva la política compartida del repositorio.

La partición es deliberada: tu equipo comparte la política del repositorio en
`chaski.json`, y cada máquina declara lo suyo en `chaski.local.json` o
`~/.chaski/config.json`. Alguien clona y funciona, sin heredar la configuración
privada de nadie.

---

## Equipos y repositorios compartidos

Hay una regla que gobierna este escenario: **un archivo que se reescribe
automáticamente nunca va en git.** Versionar el relevo produciría conflictos de
merge permanentes sobre contenido que nadie quiere resolver.

Por eso `.tambo/` entra al `.gitignore` y `doctor` avisa si alguien lo trackea.
Cada persona tiene su propio relevo, local. Lo que el equipo sí comparte son las
convenciones estables, y esas van en `AGENTS.md`, que los tres CLIs ya leen de
forma nativa.

> Nota práctica: si `.tambo/` no está ignorado, `git stash -u` y los `checkout`
> se llevan tus relevos. Verificado a la mala durante el desarrollo.

---

## Seguridad

**El relevo es texto que se inyecta en el contexto de un agente con permisos de
escritura.** Eso lo convierte en un vector de inyección de prompt, así que:

- Se declara como datos y no como instrucciones, entre delimitadores explícitos.
- Se firma con HMAC contra una clave local en `~/.chaski/clave`, que nunca se
  versiona. Si la firma no valida, el relevo se inyecta **rotulado como no
  verificado** en lugar de descartarse en silencio. Una narrativa guardada
  después de la última captura no dispara ese aviso mientras los hechos sigan
  coincidiendo con lo firmado: se inyecta con una nota de que se firma en el
  próximo turno.
- `.tambo/` va en `.gitignore`: no viaja entre máquinas por git.
- Tiene techo de tamaño, así que un relevo inflado no puede desplazar tu
  contexto de trabajo.

**El filtro de secretos corre antes de escribir**, no solo antes de enviar: un
token en `.tambo/relevo.md` ya es una fuga aunque nunca salga de la máquina.
Cubre ~20 formatos de credencial, cadenas de alta entropía, asignaciones con
nombre sensible, URLs con credenciales y cabeceras `Authorization`. Las rutas
tipo `.env`, `*.pem` o `id_rsa` nunca aparecen en el relevo. Lo redactado deja
marca visible, para que nadie confunda una redacción con un dato ausente.

**Alcance de escritura:** `.tambo/` del proyecto, `~/.chaski/`, y los archivos
de configuración de los CLIs que habilitaste, más `.gitignore`, `AGENTS.md`,
`.claude/skills/relevo/` y `.agents/skills/relevo/` durante `init` y
`decisiones/` cuando ejecutas explícitamente `chaski share`. En ningún otro
lugar. No ejecuta scripts del repositorio, no abre puertos y no hace commits.

Para reportar una vulnerabilidad, ver [SECURITY.md](SECURITY.md).

---

## Términos de uso de los proveedores

**chaski no invoca ningún CLI automáticamente.** Ni `claude -p`, ni
`codex exec`, ni `agy -p`.

Esto no es una limitación técnica, es una decisión informada. Los términos de
consumidor de Anthropic prohíben acceder a los servicios «por medios
automatizados o no humanos, mediante bot, script o de otro modo» salvo con una
API key. Google respondió oficialmente que los requests automáticos y
desatendidos no están soportados en planes de consumidor y pueden activar
bloqueos de cuenta — y hay suspensiones documentadas en sus foros. OpenAI apunta
a usar una API key para automatización.

La narrativa la escribe **el agente que ya tienes abierto**, que es uso
interactivo de una sesión que iniciaste tú (los términos solo permiten
automatización externa mediante una API key propia, pero chaski no necesita
siquiera eso porque nunca invoca un modelo por fuera).

No existe una opción de configuración para invocar tu suscripción de forma
automática. No está implementada a propósito: una configuración que pone en
riesgo tu cuenta no debería estar a un flag de distancia.

---

## Lo que chaski no hace

- **No funciona en modo headless.** Verificado empíricamente en los tres:
  `claude -p`, `codex exec` y `agy -p` no disparan los hooks `SessionStart` ni
  `Stop`. chaski es para sesiones interactivas; si lo necesitas en CI, esta
  herramienta no es la indicada.
- **No es una base de datos vectorial ni un servicio en la nube**, no sincroniza
  estado en tiempo real entre máquinas y solo soporta tres herramientas (para
  historial local tiene `chaski why`, para decisiones puntuales `chaski share` y
  para ver el último corte por `rate_limit` tiene `chaski next`). Si necesitas
  búsqueda semántica o veinte integraciones, [ai-memory](https://github.com/akitaonrails/ai-memory)
  es más completo.
- **No hace commits** ni toca tu historial de git.

---

## Límites conocidos

| Límite | Valor | Por qué |
|---|---|---|
| Latencia del hook | ~220 ms (antes ~340 ms; se redujeron los subprocesos de git de 9 a 3 en árbol limpio, o 4 si hay archivos sucios) | El presupuesto de `Stop` en Claude Code es de 1,5 s **compartido** entre todos los hooks del evento. Hay margen de casi 7x, pero si tienes muchos hooks ahí, mide |
| Tamaño del relevo | 6.000 caracteres | Por encima de 10.000, Claude Code reemplaza el contenido por una ruta y el relevo no llega |
| Narrativa | puede atrasarse unos turnos | Los hechos están siempre al día; el porqué depende de cuándo pediste «relevo» |
| Hooks de Codex | requieren conceder confianza | La primera vez que abres Codex con hooks instalados pide confiar en ellos. Hasta que aceptes, no se ejecuta ninguno, y el permiso se aplica desde la sesión siguiente |
| Un turno con miles de archivos modificados | el relevo sale **incompleto, y lo dice** | El hook tiene un presupuesto de tiempo propio y sacrifica lo caro y poco informativo antes de agotarlo: primero el detalle de líneas `+/-` por archivo, después el log de commits. La rama, el `HEAD`, la lista de archivos y su total siempre sobreviven. Lo que se omitió aparece declarado en el relevo, porque un relevo incompleto que se presenta como completo es peor que uno recortado. Medido: 5.000 archivos modificados pasaban de 2.000 ms —y perdían el relevo entero— y ahora el hook completo tarda ~220-340 ms |
| Ruta del proyecto de más de ~240 caracteres | los subprocesos de git fallan | En Windows, una ruta así de larga hace que el subproceso de git falle. chaski lo interpreta como «esto no es un repositorio git» y lo reporta en silencio, perdiendo también la detección de la rama. No hay arreglo barato conocido: evita rutas tan largas para este proyecto |

Si un administrador fijó `allowManagedHooksOnly` o `disableAllHooks` en una
máquina corporativa, los hooks de usuario no corren. `doctor` lo detecta y lo
informa en vez de dejarte creyendo que funciona.

**`doctor` siempre termina con código de salida 0**, incluso cuando ningún CLI
tiene los hooks registrados. Es un comando de diagnóstico para que lo lea una
persona, no una verificación para encadenar en un script o en CI — si
necesitas eso, revisa su salida de texto, no su código de salida. (`init` sí
termina en 1 si algún CLI falló al configurarse.)

**Relevos de antes del renombre a `branches/`.** Versiones viejas de chaski
guardaban el relevo en `.tambo/ramas/<rama>/`. Ni `inject.mjs` ni `doctor`
migran ni mencionan esa carpeta: si tienes relevos ahí, quedaron huérfanos.
Para recuperarlos a mano, copia el contenido de
`.tambo/ramas/<rama>/estado.json` al campo `narrative` (y
`narrativeAuthor`/`narrativeWrittenAt`) del `estado.json` nuevo en
`.tambo/branches/<rama>/` — los hechos no se recuperan porque ya están
obsoletos, pero la narrativa escrita a mano sí vale la pena rescatarla.
Después puedes borrar `.tambo/ramas/`.

**Falsa alarma de firma con clientes de sincronización.** Si OneDrive, Dropbox
o similar bloquean `estado.json` justo cuando `capture.mjs` está escribiendo,
puede quedar un `relevo.md` nuevo firmado junto a un `estado.json` que todavía
tiene la firma anterior. La sesión siguiente ve la firma desajustada y avisa
de una posible manipulación aunque no haya pasado nada malintencionado — es un
falso positivo del mecanismo de integridad, no una vulnerabilidad.

---

## Contribuir

Las contribuciones son bienvenidas. Antes de abrir un PR, lee
[AGENTS.md](AGENTS.md): tiene los ocho invariantes del proyecto, los
presupuestos de latencia y tamaño, y las trampas conocidas de cada CLI.

El más importante: **cero dependencias de runtime**. La herramienta se ejecuta
sola en cada turno, así que un árbol de npm sería superficie de ataque.

Agregar soporte para otro CLI implica añadir su entrada e instalador en `CLIS`
(`src/cli.mjs`), su extractor en `src/lib/facts.mjs`, su formato de petición en
`src/lib/ask.mjs` y su fixture en `test/fixtures/`.

## Soporte

- **Bugs y propuestas:** abre un issue en el repositorio.
- **Diagnóstico:** incluye la salida de `chaski doctor` (no contiene secretos) y
  las versiones de tus CLIs.

## Licencia

MIT — ver [LICENSE](LICENSE).
