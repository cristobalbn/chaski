# chaski

[![test](https://github.com/cristobalbn/chaski/actions/workflows/test.yml/badge.svg)](https://github.com/cristobalbn/chaski/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@cristobalbn/chaski.svg)](https://www.npmjs.com/package/@cristobalbn/chaski)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Dependencias](https://img.shields.io/badge/dependencias-0-brightgreen.svg)](package.json)

**Relevo de contexto entre agentes de código.** Trabajas en Claude Code y se
acaba la cuota. Abres Codex en la misma carpeta y ya sabe lo que pasó: «estabas
migrando el login a tokens; falta actualizar los tests de `auth/`». Sin vigilar
contadores ni copiar y pegar nada.

**Privacidad:** chaski no envía nada por red por su cuenta. Todo queda en tu
máquina, y los secretos se redactan antes de escribir a disco
([detalle](#seguridad)).

Los chaskis eran los mensajeros del imperio inca: cada uno corría un tramo y en
el **tambo** entregaba el mensaje al siguiente. Mismo problema, misma solución.

Compatible con **Claude Code**, **Codex CLI** y **Antigravity CLI (`agy`)**. Con
uno solo ya sirve: el relevo entre sesiones de la misma herramienta tiene valor
propio.

Necesitas Node.js 20 o superior: compruébalo con `node --version` y, si no lo
tienes, descárgalo de [nodejs.org](https://nodejs.org).

```bash
npm install -g "@cristobalbn/chaski"
cd tu-proyecto          # la raíz del repositorio git; init se corre una vez por proyecto
chaski init
chaski doctor           # verifica qué quedó conectado
```

Después **cierra y vuelve a abrir tu CLI**: chaski se engancha con *hooks* (un
hook es un comando que el CLI ejecuta solo al iniciar o terminar un turno) y el
CLI los lee únicamente al arrancar. Si usas Codex, además tiene que aceptar los
hooks (ver [Dos pasos después de instalar](#dos-pasos-después-de-instalar)). Si
la terminal no reconoce `chaski`, ábrela de nuevo.

No hace falta clonar este repositorio: clonar es solo para contribuir o auditar
el código ([ver abajo](#para-contribuir-o-auditar-el-código)).

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
  - [Con npm](#con-npm)
  - [Qué hace `init`](#qué-hace-init)
  - [Dos pasos después de instalar](#dos-pasos-después-de-instalar)
  - [Verificar la instalación](#verificar-la-instalación)
  - [Si le pasaste este enlace a un agente](#si-le-pasaste-este-enlace-a-un-agente)
  - [Actualizar](#actualizar)
  - [Desinstalar](#desinstalar)
- [Uso diario](#uso)
  - [Qué escribir en el chat del agente](#la-misma-petición-en-los-tres-agentes)
  - [La narrativa se pide sola](#la-narrativa-se-pide-sola)
  - [Referencia de comandos en terminal](#referencia-de-comandos-en-terminal)
- [Configuración (`chaski.json`, `chaski.local.json`, `~/.chaski/config.json`)](#configuración)
- [Equipos y repositorios compartidos](#equipos-y-repositorios-compartidos)
- [Arquitectura](#arquitectura)
- [Seguridad](#seguridad)
- [Términos de uso de los proveedores](#términos-de-uso-de-los-proveedores)
- [Lo que chaski no hace](#lo-que-chaski-no-hace)
- [Límites conocidos](#límites-conocidos)
- [Contribuir](#contribuir)
  - [Para contribuir o auditar el código](#para-contribuir-o-auditar-el-código)
- [Soporte](#soporte) y [Licencia](#licencia)

El detalle técnico que no hace falta para usar chaski está en la
[referencia técnica](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md).

---

## Instalación

**Requisitos:** Node.js ≥ 20. Nada más — cero dependencias de runtime.

### Con npm

```bash
npm install -g "@cristobalbn/chaski"
cd tu-proyecto
chaski init
```

*(Las comillas son opcionales: el comando funciona igual en PowerShell, cmd y bash/zsh.)*

Instalado así, los hooks apuntan a la copia global de npm (la ruta exacta la
muestra `chaski doctor`), no a ningún clon. Un clon local de este repositorio
es independiente de lo que ejecutan tus CLIs: puedes borrarlo o moverlo sin
romper nada.

También se puede instalar directo desde GitHub:

```bash
npm install -g github:cristobalbn/chaski
```

> **No uses `npx "@cristobalbn/chaski" init`** (ni `npx github:cristobalbn/chaski init`).
> Los hooks guardan una ruta absoluta a los scripts, y el caché de `npx` es
> temporal: la ruta desaparece y los hooks fallan en silencio. `init` detecta
> ese caso y aborta con una explicación.

### Qué hace `init`

1. Detecta cuáles de los tres CLIs tienes instalados y registra los hooks **a
   nivel de usuario**, con rutas nativas del sistema operativo. Respalda cada
   archivo de configuración antes de tocarlo.
2. Agrega `.tambo/` y `chaski.local.json` a tu `.gitignore`.
3. Instala la skill `relevo` (un archivo de instrucciones que el agente carga
   al oírte pedir «relevo») dos veces: en `.claude/skills/relevo/`, que lee
   Claude Code, y en `.agents/skills/relevo/`, que leen Codex y Antigravity.
   Es el mismo archivo y reconoce las mismas peticiones: **«relevo»**,
   **«guarda el relevo»** y **«actualiza el relevo»**.
4. Agrega una sección de relevo a tu `AGENTS.md`. Si ya existe, añade o actualiza
   un bloque delimitado con las peticiones comunes y conserva el resto del texto.

Si no encuentra ningún CLI en el `PATH` (la lista de carpetas donde tu terminal
busca programas), no toca nada y sale con 0.

<details>
<summary>Si abres el CLI en una carpeta que no es la raíz del repo</summary>

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

`init` y `doctor` muestran en la línea `proyecto` / `directorio` la carpeta
donde vive el relevo, y explican cuándo no es la carpeta actual. Hay que
saber cómo se resuelve. `<slug-de-la-rama>` es el nombre de la rama convertido
a un nombre de carpeta seguro (`main` queda `main`; `feat/pagos` queda
`feat-pagos-<hash6>`).

| Abres el CLI en… | El relevo vive en… |
|---|---|
| la raíz de un repo o una subcarpeta suya | la raíz del repo, `.tambo/branches/<slug-de-la-rama>/` |
| una carpeta sin git con **un único** repo hijo | ese repo hijo |
| una carpeta sin git con cero o varios repos hijos | esa misma carpeta, `.tambo/branches/sin-rama/` |

En carpetas sin git, **cada carpeta desde la que abras un CLI tiene su propio
relevo**: el de la carpeta padre no lo ve quien abre una subcarpeta, y al revés.
Y si a mitad de una tarea creas el único repo dentro de una carpeta sin git, el
relevo pasa a ese repo y el anterior (`sin-rama`) queda en la carpeta padre sin
migrarse.

</details>

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

**1. Revisa la configuración.**

```bash
chaski doctor
```

Imprime en qué eventos de cada configuración hay un hook de chaski, las rutas de
`capture.mjs` e `inject.mjs` de esta instalación, el último latido de cada CLI
(la fecha en que su hook corrió por última vez), el estado del relevo y **qué
sale de tu máquina**. Para ver el comando textual, abre la config del CLI.

Esta es la salida real en un proyecto recién creado y **sin ningún CLI
configurado** (las rutas y el directorio dependen de tu máquina; `…` marca lo
omitido):

```
chaski doctor (v0.1.2)

CLIs y hooks
  claude code     sin config — ejecuta init
  codex           sin config — ejecuta init
  agy             sin config — ejecuta init

Ejecutables del hook
  capture         ok  …\src\capture.mjs
  inject          ok  …\src\inject.mjs

Latidos (última vez que cada CLI ejecutó el hook)
  ninguno todavía — abre una sesión y vuelve a revisar

Proyecto
  …
  .tambo en git   NO IGNORADO — ejecuta init
  relevo          todavía no existe para esta rama

Qué sale de esta máquina
  capture         nada: solo lee archivos locales y git
  inject          nada: imprime un archivo local
  skill relevo    usa el agente que ya tienes abierto (uso interactivo)
  llamadas        chaski NO invoca claude -p, codex exec ni agy -p
```

Tras `chaski init` y una sesión real, lo que cambia es: cada CLI instalado pasa
de `sin config — ejecuta init` a `registrado (…)`, con la lista de eventos que
tienen un hook de chaski entre paréntesis; `.tambo en git` pasa a `ignorado, correcto`; aparece una
línea de latido por CLI con la fecha de su última ejecución; y el relevo pasa a
mostrar su tamaño, `firma válida` y si tiene narrativa. Los dos bloques `ok` de
ejecutables y `Qué sale de esta máquina` deben verse igual que arriba. Si ves
`FALTA`, `NO VALIDA`, `hooks NO registrados` o un aviso `⚠`, el propio mensaje
dice qué hacer.

**2. Prueba de punta a punta.** Al abrir el segundo CLI, pregúntale *«¿qué
sabes del estado de este trabajo?»*. Si responde con los archivos tocados y qué
quedó a medias, funcionó. Si no, `chaski doctor` te dice qué hook no quedó
registrado y dónde.

### Si le pasaste este enlace a un agente

<details>
<summary>Instrucciones para el agente que instala chaski en nombre del usuario</summary>

Si estás leyendo esto porque alguien te pidió instalar chaski en su proyecto,
sigue exactamente esto y no hace falta que leas el resto del README.

```bash
node --version                      # debe ser >= 20; si no, detente y avisa
npm install -g "@cristobalbn/chaski"  # o: npm install -g github:cristobalbn/chaski
cd <el proyecto del usuario>
chaski init
chaski doctor
```

Después:

1. **Muéstrale al usuario el resumen que imprime `chaski init`.** Explica qué
   quedó instalado, qué tiene que hacer y qué comandos tiene. No lo
   parafrasees ni lo resumas: ya está escrito para que lo lea una persona.
2. **Pega también la salida de `chaski doctor`**, que dice qué CLIs quedaron
   conectados, en qué eventos hay un hook de chaski y qué scripts ejecuta esta
   instalación. El usuario debería poder auditarlo.
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

**No instales con `npx`** (ver la advertencia en [Con npm](#con-npm)).

**No agregues configuración que no te pidieron.** chaski funciona sin
`chaski.json`; crearlo «por las dudas» solo agrega algo que mantener.

</details>

### Actualizar

```bash
npm install -g "@cristobalbn/chaski"   # o: npm install -g github:cristobalbn/chaski
cd tu-proyecto
chaski init                            # repítelo en cada proyecto que uses con chaski
```

Después cierra y vuelve a abrir tus CLIs: leen los hooks una sola vez, al
arrancar. **`chaski init` no es opcional tras actualizar**: los hooks guardan
la ruta absoluta de los scripts y, si una versión la mueve, el CLI imprime un
error de módulo no encontrado en cada turno
([por qué y qué pasa con la sesión abierta](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#actualizar-por-qué-init-no-es-opcional)).
Las configuraciones anteriores a la 0.1.0 siguen funcionando mediante puentes de
compatibilidad, pero `init` sigue siendo el paso correcto
([detalle](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#puentes-de-compatibilidad-capturarmjs-leermjs)).

Para saber qué versión tienes y si hay una más nueva:

```bash
chaski version
npm outdated -g @cristobalbn/chaski
```

### Desinstalar

En este orden: primero `uninstall`, que necesita el binario, y después el
paquete.

```bash
chaski uninstall
npm uninstall -g "@cristobalbn/chaski"
```

`uninstall` quita solo los hooks de chaski de la configuración actual de cada
CLI, así que conserva todo lo que cambiaste después del primer `init` (incluida
la confianza de hooks que Codex guarda). El respaldo `.chaski-backup` que hizo
`init` no se borra ni se restaura: queda en su sitio y `uninstall` imprime su
ruta. Lo que queda, y se borra a mano si quieres:

- En cada proyecto: `.tambo/` (tus relevos), las skills
  `.claude/skills/relevo/` y `.agents/skills/relevo/`, y el bloque entre
  `<!-- chaski:requests:start -->` y `<!-- chaski:requests:end -->` de
  `AGENTS.md`. Quita ese bloque: si no, el agente sigue leyendo instrucciones
  sobre un relevo que ya no existe.
- Las líneas de chaski en `.gitignore`, que no estorban.
- En tu usuario: `~/.chaski/` (clave local, latidos, registro de costos y
  wrappers).

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
basta al configurar el proyecto y al actualizar chaski.

**El `cd` no es opcional:** el relevo vive dentro del proyecto, así que cada
proyecto tiene el suyo y no se mezclan. Tampoco se mezclan las ramas — volver a
una rama que dejaste hace una semana te devuelve su contexto.
No necesitas trabajar dentro del código de chaski para usarlo en otro proyecto.

### La narrativa se pide sola

El relevo tiene **hechos** (archivos, commits, comandos: los saca chaski de git
y de la conversación, gratis) y **narrativa** (qué intentabas, qué quedó a
medias, el siguiente paso: solo la puede escribir el agente). A veces, al
terminar un turno con trabajo detrás, chaski le pide al agente **un turno
extra** para guardar ese porqué. Ese turno consume algo de cuota, pero se pide
con poca frecuencia, mientras todavía sobra, y nunca se invoca ningún modelo por
fuera. En Claude Code lo verás como una línea bajo «Stop hook feedback».

- Apagarlo: `"askNarrative": false` en `chaski.json` o `chaski.local.json`.
- Ver cuántos turnos extra pidió: `chaski cost`.
- Los límites exactos (20 minutos, 8 turnos) y el contrato por CLI están en la
  [referencia técnica](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#petición-automática-de-la-narrativa).

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
| `chaski init` | Al instalar chaski en un proyecto o tras actualizar | Registra los hooks a nivel de usuario (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/config/hooks.json`), agrega `.tambo/` y `chaski.local.json` a `.gitignore`, instala la skill en `.claude/skills/relevo/` y `.agents/skills/relevo/`, y actualiza el bloque de relevo en `AGENTS.md`. Sale con código `1` si algún CLI falló |
| `chaski doctor` | Para verificar la instalación o diagnosticar si algo no captura | Muestra la versión instalada, los hooks registrados por CLI, el último latido en `~/.chaski/latidos.json`, si `.tambo/` está ignorado en git, el estado y firma del relevo de la rama actual y qué sale de tu máquina. Siempre sale con código `0` |
| `chaski next` | Al agotarse la cuota de un CLI o antes de retomar | Lee `~/.chaski/quota.json` (alimentado cuando un hook detecta un corte por `rate_limit`) y `.tambo/branches/<slug>/estado.json` para indicar qué CLI está disponible (`→`), cuántos archivos hay sin commitear y cuál es el paso pendiente |
| `chaski cost` | Para revisar cuántos turnos extra pidió chaski | Reporta el gasto externo (`0 tokens · $0.00`, porque chaski nunca llama a APIs ni modelos externos) y contabiliza desde `~/.chaski/cost.json` las peticiones automáticas y narrativas escritas por cada CLI en los últimos 7 días y en total |
| `chaski why [tema]` | Para consultar por qué se tomó o descartó una decisión pasada | Busca en `.tambo/historia/entries.jsonl` (donde `capture.mjs` archiva cada narrativa antes de que se reemplace), en las ramas activas de `.tambo/branches/` y en `decisiones/`. Si pasas `tema`, filtra por texto o nombre de rama. Muestra las 10 más recientes. |
| `chaski share [tema] [--yes]` | Para compartir una decisión de tu relevo local con el equipo en git | Toma la narrativa de la rama actual, vuelve a pasar el filtro de secretos (`src/lib/secrets.mjs`), muestra la vista previa de `decisiones/YYYY-MM-DD-<tema>.md` y pide confirmación interactiva antes de escribir (o publica directo con `--yes`). Nunca sobrescribe un archivo existente; si ya existe, añade sufijo `-2`, `-3`, etc. Sale con código `1` si la rama no tiene narrativa o si no confirmas |
| `chaski probe [--show \| --clean]` | Diagnóstico de payloads de hooks o creación de nuevos fixtures | Instala una sonda temporal que vuelca a disco lo que cada CLI le pasa a sus hooks. Solo para diagnóstico o contribuir: [detalle y uso](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#capturar-payloads-chaski-probe) |
| `chaski uninstall` | Para quitar los hooks de chaski de tus CLIs | Quita los hooks de chaski de `~/.claude/settings.json`, `~/.codex/config.toml` y `~/.gemini/config/hooks.json` sin tocar el resto de cada archivo. Conserva los respaldos `.chaski-backup`, `.tambo/` y `~/.chaski/` |
| `chaski version` (`--version`, `-v`) | Para consultar la versión instalada | Imprime `chaski X.Y.Z` desde `package.json` |

---

## Arquitectura

La idea central es **separar hechos de intención**:

- **Hechos** (determinísticos, gratis, instantáneos): se derivan de git y del
  transcript (el historial de la conversación que guarda cada CLI). Cero
  tokens, cero red, y exactos por construcción.
- **Intención** (requiere un modelo): por qué se eligió un enfoque, qué falta.
  Esto no está en el diff; está en la conversación.

El 70% del valor de un relevo está en la capa de hechos, y no cuesta nada. Por
eso el modelo es el último recurso y no el primero.

| Archivo | Cuándo corre | Qué hace |
|---|---|---|
| `src/capture.mjs` | hook `Stop` en los tres CLIs; también `SessionEnd`, `PreCompact`, `SubagentStop` y `StopFailure` en Claude Code | Lee el transcript desde una marca de agua (hasta dónde ya leyó) y git; escribe `relevo.md`, `estado.json` y `.tambo/historia/` |
| `src/inject.mjs` | hook `SessionStart` | Imprime el relevo; lo que imprime entra al contexto del agente |
| `src/cli.mjs` | a mano | `init`, `doctor`, `next`, `cost`, `why`, `share`, `version`, `uninstall`, `probe` |
| `skill/SKILL.md` | al pedir «relevo» | Instrucciones para que el agente escriba la narrativa |

Archivos que genera en tu proyecto:

```
.tambo/
  branches/
    main/relevo.md          ← lo que se inyecta
    main/estado.json        ← hechos, marca de agua, firma
    feat-pagos-<hash6>/relevo.md  ← rama feat/pagos: otra rama, otro contexto
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
| `pruneNarrativeAfterDays` | Días antes de borrar el relevo huérfano que tiene narrativa. Por defecto, el triple de `pruneAfterDays`, con un mínimo de 90. `pruneAfterDays: 0` desactiva también esta limpieza; `pruneNarrativeAfterDays: 0` desactiva solo la de relevos con narrativa (los demás siguen su plazo) |
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

Por eso `.tambo/` entra al `.gitignore` y `doctor` avisa si no está ignorado.
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
- Se firma con HMAC (una firma con clave que detecta ediciones) contra una
  clave local en `~/.chaski/clave`, que nunca se
  versiona. Si la firma no valida, el relevo se inyecta **rotulado como no
  verificado** en lugar de descartarse en silencio. Una narrativa guardada
  después de la última captura no dispara ese aviso mientras los hechos sigan
  coincidiendo con lo firmado: se inyecta con una nota de que se firma en el
  próximo turno.
- Ningún texto ajeno —narrativa, conclusión de subagente, commit, nombre de
  archivo o de rama— puede cerrar el bloque de datos ni los bloques de código
  del relevo. Las conclusiones de subagentes vencen a las 72 h. Detalle en
  [SECURITY.md](SECURITY.md).
- `.tambo/` va en `.gitignore`: no viaja entre máquinas por git.
- Tiene techo de tamaño, así que un relevo inflado no puede desplazar tu
  contexto de trabajo.

**El filtro de secretos corre antes de escribir**, no solo antes de enviar: un
token en `.tambo/branches/<slug>/relevo.md` ya es una fuga aunque nunca salga de la máquina.
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
`codex exec`, ni `agy -p`. Los términos de consumidor de Anthropic, Google y
OpenAI restringen la automatización de las suscripciones (Google documenta
bloqueos de cuenta), así que la narrativa la escribe **el agente que ya tienes
abierto**, en una sesión que iniciaste tú. No existe una opción, ni detrás de un
flag, para invocar tu suscripción de forma automática: una configuración que
pone en riesgo tu cuenta no debería estar a un flag de distancia. Las citas y el
razonamiento completo están en la
[referencia técnica](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#términos-de-uso-de-los-proveedores).

---

## Lo que chaski no hace

- **No funciona en modo headless** (sin interfaz interactiva). Verificado
  empíricamente en los tres: `claude -p`, `codex exec` y `agy -p` no disparan
  los hooks `SessionStart` ni `Stop`. chaski es para sesiones interactivas; si
  lo necesitas en CI, esta herramienta no es la indicada.
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
| Narrativa | puede atrasarse unos turnos | Los hechos están siempre al día; el porqué depende de cuándo pediste «relevo» |
| Hooks de Codex | requieren conceder confianza | La primera vez que abres Codex con hooks instalados pide confiar en ellos. Hasta que aceptes, no se ejecuta ninguno, y el permiso se aplica desde la sesión siguiente |
| Un turno con miles de archivos modificados | el relevo sale **incompleto, y lo dice** | El hook sacrifica detalle caro (líneas `+/-`, log de commits) antes de agotar su presupuesto de tiempo; la rama, el `HEAD`, la lista de archivos y su total siempre sobreviven, y lo omitido aparece declarado en el relevo |
| Ruta del proyecto de más de ~240 caracteres | los subprocesos de git fallan | En Windows, una ruta así de larga hace que el subproceso de git falle. Desde la 0.1.1, si existe `.git` el relevo no afirma «Sin repositorio git»: declara la rama sin leer como recorte, pero sale sin rama ni los datos que dependen de git. No hay arreglo barato conocido: evita rutas tan largas para este proyecto |
| Tamaño del relevo | 6.000 caracteres | Por encima de 10.000, Claude Code reemplaza el contenido por una ruta y el relevo no llega |

Si un administrador fijó `allowManagedHooksOnly` o `disableAllHooks` en una
máquina corporativa, los hooks de usuario no corren. `doctor` no lee esas claves:
lo verás como «hooks registrados pero nunca ejecutados» o como un latido que
dejó de actualizarse. Consulta a quien administra la máquina.

**`doctor` siempre termina con código de salida 0**, incluso cuando ningún CLI
tiene los hooks registrados. Es un comando de diagnóstico para que lo lea una
persona, no una verificación para encadenar en un script o en CI — si
necesitas eso, revisa su salida de texto, no su código de salida. (`init` sí
termina en 1 si algún CLI falló al configurarse.)

**Falsa alarma de firma con clientes de sincronización.** Si OneDrive, Dropbox
o similar bloquean `estado.json` justo cuando `capture.mjs` está escribiendo,
puede quedar un `relevo.md` nuevo firmado junto a un `estado.json` que todavía
tiene la firma anterior. La sesión siguiente ve la firma desajustada y avisa
de una posible manipulación aunque no haya pasado nada malintencionado — es un
falso positivo del mecanismo de integridad, no una vulnerabilidad.

Las mediciones (latencia del hook, 5.000 archivos modificados), el tamaño
exacto del recorte y los relevos guardados por versiones viejas en
`.tambo/ramas/` (cómo rescatarlos a mano) están en la
[referencia técnica](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#límites-conocidos-detalle-y-mediciones).

---

## Contribuir

Las contribuciones son bienvenidas. Antes de abrir un PR, lee
[AGENTS.md](AGENTS.md): tiene los ocho invariantes del proyecto, los
presupuestos de latencia y tamaño, y las trampas conocidas de cada CLI.

El más importante: **cero dependencias de runtime**. La herramienta se ejecuta
sola en cada turno, así que un árbol de npm sería superficie de ataque.

Agregar soporte para otro CLI implica añadir su entrada e instalador en `CLIS`
(`src/cli.mjs`), su extractor en `src/lib/facts.mjs`, su formato de petición en
`src/lib/ask.mjs` y su fixture en `test/fixtures/`. Para capturar los payloads
reales de los hooks, usa `chaski probe`
([cómo](https://github.com/cristobalbn/chaski/blob/main/docs/referencia.md#capturar-payloads-chaski-probe)).

### Para contribuir o auditar el código

**No es necesario para usar chaski**: para eso basta [npm](#con-npm). El clon
trae lo que el paquete de npm deja fuera a propósito —historial, `test/`,
`docs/`, `scripts/`, CI y `CONTRIBUTING.md`—.

Clónalo si vas a contribuir, o si prefieres leer lo que vas a ejecutar antes de
instalarlo, algo razonable en una herramienta que corre sola en cada turno. Son
~3.800 líneas de JavaScript sin dependencias:

```bash
git clone https://github.com/cristobalbn/chaski.git
cd chaski
npm run check          # verifica la sintaxis; no hay build
npm test               # node:test, sin dependencias
cd ../tu-proyecto
node ../chaski/src/cli.mjs init
```

Ojo con este último paso: un `init` corrido desde el clon registra hooks que
apuntan **al clon**. Si después lo mueves o lo borras, los hooks quedan
apuntando a un archivo inexistente. Para auditar y luego usar, instala con npm
y deja el clon solo para leer.

## Soporte

- **Bugs y propuestas:** abre un issue en el repositorio.
- **Diagnóstico:** incluye la salida de `chaski doctor` (no contiene secretos) y
  las versiones de tus CLIs.

## Licencia

MIT — ver [LICENSE](LICENSE).
