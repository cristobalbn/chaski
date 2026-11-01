# chaski

[![test](https://github.com/cristobalbn/chaski/actions/workflows/test.yml/badge.svg)](https://github.com/cristobalbn/chaski/actions/workflows/test.yml)
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

## Instalación

**Requisitos:** Node.js ≥ 20. Nada más — cero dependencias de runtime.

### Si le pasaste este enlace a un agente

Si estás leyendo esto porque alguien te pidió instalar chaski en su proyecto,
sigue exactamente esto y no hace falta que leas el resto del README.

```bash
node --version                      # debe ser >= 20; si no, detente y avisa
npm install -g chaski               # o: npm install -g github:cristobalbn/chaski
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
   - `/relevo` es opcional y agrega el «por qué» al relevo.

**Si algo falla**, no improvises una solución: pégale al usuario la salida de
`chaski doctor` y dile qué paso falló. Los modos de fallo conocidos están en
[Límites conocidos](#límites-conocidos).

**No instales con `npx`**: los hooks guardan una ruta absoluta y el caché de
`npx` es temporal. `init` aborta si detecta ese caso.

**No agregues configuración que no te pidieron.** chaski funciona sin
`chaski.json`; crearlo «por las dudas» solo agrega algo que mantener.

### Opción 1 — npm (recomendada)

```bash
npm install -g chaski
cd tu-proyecto
chaski init
```

Mientras no esté publicado en npm, se instala igual desde GitHub:

```bash
npm install -g github:cristobalbn/chaski
```

> **No uses `npx chaski init`.** Los hooks guardan una ruta absoluta a los
> scripts, y el caché de `npx` es temporal: la ruta desaparece y los hooks
> fallan en silencio. `init` detecta ese caso y aborta con una explicación.

### Opción 2 — desde el código fuente

Si prefieres leer lo que vas a ejecutar antes de instalarlo —algo razonable en
una herramienta que corre sola en cada turno— clona el repositorio. Son ~1.100
líneas de JavaScript sin dependencias:

```bash
git clone https://github.com/cristobalbn/chaski.git
cd chaski
npm run check          # verifica la sintaxis; no hay build
npm test               # 88 tests, sin dependencias
cd ../tu-proyecto
node ../chaski/src/instalar.mjs init
```

### Qué hace `init`

1. Detecta cuáles de los tres CLIs tienes instalados y registra los hooks **a
   nivel de usuario**, con rutas nativas del sistema operativo. Respalda cada
   archivo de configuración antes de tocarlo.
2. Agrega `.tambo/` y `chaski.local.json` a tu `.gitignore`.
3. Instala el skill `/relevo` en `.claude/skills/relevo/`.
4. Agrega una sección de relevo a tu `AGENTS.md`.

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
chaski probe --ver        # mira lo capturado
chaski probe --limpiar    # quita la sonda
```

Tiene que ser una sesión interactiva: ninguno de los tres dispara hooks en
modo headless.

### Desinstalar

```bash
chaski uninstall
```

Revierte cada configuración desde su respaldo. Tus relevos en `.tambo/` quedan
en disco porque son tuyos; borralos a mano si quieres.

---

## Uso

No se usa. Eso es el punto.

1. Trabajas normal en Claude Code. No ejecutas nada, no vigilas nada.
2. Se agota la cuota.
3. Abres otra terminal, **`cd` al mismo proyecto**, y abres `agy` o `codex`.
4. El agente arranca sabiendo dónde quedaste.

No hace falta cerrar el primer CLI ni pedirle al segundo que lea nada.

**El `cd` no es opcional:** el relevo vive dentro del proyecto, así que cada
proyecto tiene el suyo y no se mezclan. Tampoco se mezclan las ramas — volver a
una rama que dejaste hace una semana te devuelve su contexto.

### La primera vez, verifica

Al abrir el segundo CLI, pregúntale *«¿qué sabes del estado de este trabajo?»*.
Si responde con los archivos tocados y qué quedó a medias, funcionó. Si no,
`chaski doctor` te dice qué hook no quedó registrado y dónde.

### El comando `/relevo`

Los **hechos** —archivos, diff, exit codes, commits— se escriben solos en cada
turno, sin costo. La **narrativa** —qué estás intentando, qué decidiste, qué
descartaste y por qué— la escribe el agente cuando se la pides con `/relevo`.

No es obligatorio. Sin narrativa el relevo sigue siendo útil, porque los hechos
son lo que evita que el siguiente agente rompa algo. La narrativa es lo que
evita que reabra decisiones ya cerradas.

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
| `src/capturar.mjs` | hooks `Stop`, `SessionEnd`, `PreCompact`, `SubagentStop`, `StopFailure` | Lee el transcript desde una marca de agua y git; escribe `relevo.md` y `estado.json` |
| `src/leer.mjs` | hook `SessionStart` | Imprime el relevo; lo que imprime entra al contexto del agente |
| `src/instalar.mjs` | a mano | `init`, `doctor`, `uninstall` |
| `skill/SKILL.md` | con `/relevo` | Instrucciones para que el agente escriba la narrativa |

Archivos que genera en tu proyecto:

```
.tambo/
  ramas/
    main/relevo.md          ← lo que se inyecta
    main/estado.json        ← hechos, marca de agua, firma
    feat-pagos/relevo.md    ← otra rama, otro contexto
```

Y en `~/.chaski/`: la clave de firma, los latidos de cada CLI y la config global.

El diseño completo, con los riesgos y la investigación de términos de uso, está
en [`docs/diseno.html`](docs/diseno.html). Describe el diseño entero, incluidas
piezas que todavía no existen: abre con una tabla que distingue lo construido
de lo pendiente.

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
| `limpiarTrasDias` | Días antes de borrar el relevo de una rama que ya no existe. Por defecto 30; `0` desactiva la limpieza |
| `limpiarConNarrativaTrasDias` | Lo mismo para los relevos que tienen narrativa. Por defecto 90 |

Los relevos con narrativa viven el triple a propósito: los hechos se
recalculan desde git en cualquier momento, pero la narrativa existe solo
porque alguien la escribió y no se recupera. Un relevo de rama viva no se
borra nunca, sin importar la antigüedad.

### `chaski.local.json` — tu máquina, **en `.gitignore`**

Mismas claves. Se suma a la del proyecto en lugar de reemplazarla.

La partición es deliberada: tu equipo comparte la política del repositorio, pero
cada máquina declara lo suyo. Alguien clona y funciona, sin heredar la
configuración de nadie.

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
  verificado** en lugar de descartarse en silencio.
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
de configuración de los CLIs que habilitaste. En ningún otro lugar. No ejecuta
scripts del repositorio, no abre puertos y no hace commits.

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
interactivo de una sesión que iniciaste tú. Si prefieres que la genere un
proceso aparte, configura tu propia API key: esa es la excepción que los
términos nombran explícitamente.

No existe una opción de configuración para invocar tu suscripción de forma
automática. No está implementada a propósito: una configuración que pone en
riesgo tu cuenta no debería estar a un flag de distancia.

---

## Lo que chaski no hace

- **No funciona en modo headless.** Verificado empíricamente en los tres:
  `claude -p`, `codex exec` y `agy -p` no disparan los hooks `SessionStart` ni
  `Stop`. chaski es para sesiones interactivas; si lo necesitas en CI, esta
  herramienta no es la indicada.
- **No busca en el historial de meses atrás**, no comparte memoria con tu
  equipo, no administra cuotas y no soporta veinte herramientas. Si necesitas
  eso, [ai-memory](https://github.com/akitaonrails/ai-memory) es más completo y
  está más maduro.
- **No hace commits** ni toca tu historial de git.

---

## Límites conocidos

| Límite | Valor | Por qué |
|---|---|---|
| Latencia del hook | ~290 ms, casi todo arranque de Node | El presupuesto de `Stop` en Claude Code es de 1,5 s **compartido** entre todos los hooks del evento. Hay margen de 5x, pero si tienes muchos hooks ahí, mide |
| Tamaño del relevo | 6.000 caracteres | Por encima de 10.000, Claude Code reemplaza el contenido por una ruta y el relevo no llega |
| Narrativa | puede atrasarse unos turnos | Los hechos están siempre al día; el porqué depende de cuándo corriste `/relevo` |
| Hooks de Codex | requieren conceder confianza | La primera vez que abres Codex con hooks instalados pide confiar en ellos. Hasta que aceptes, no se ejecuta ninguno, y el permiso se aplica desde la sesión siguiente |

Si un administrador fijó `allowManagedHooksOnly` o `disableAllHooks` en una
máquina corporativa, los hooks de usuario no corren. `doctor` lo detecta y lo
informa en vez de dejarte creyendo que funciona.

---

## Contribuir

Las contribuciones son bienvenidas. Antes de abrir un PR, lee
[AGENTS.md](AGENTS.md): tiene los siete invariantes del proyecto, los
presupuestos de latencia y tamaño, y las trampas conocidas de cada CLI.

El más importante: **cero dependencias de runtime**. La herramienta se ejecuta
sola en cada turno, así que un árbol de npm sería superficie de ataque.

Agregar soporte para otro CLI es un archivo en `src/lib/` más una entrada en el
mapa `CLIS` de `src/instalar.mjs`.

## Soporte

- **Bugs y propuestas:** abre un issue en el repositorio.
- **Diagnóstico:** incluye la salida de `chaski doctor` (no contiene secretos) y
  las versiones de tus CLIs.

## Licencia

MIT — ver [LICENSE](LICENSE).
