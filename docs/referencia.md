# Referencia técnica de chaski

Detalle técnico que el [README](https://github.com/cristobalbn/chaski#readme)
resume o enlaza: contratos por CLI, diagnóstico, historia de compatibilidad,
mediciones y términos de los proveedores. Para instalar y usar chaski no hace
falta leerlo.

## Índice

- [Petición automática de la narrativa](#petición-automática-de-la-narrativa)
- [Capturar payloads (`chaski probe`)](#capturar-payloads-chaski-probe)
- [Actualizar: por qué `init` no es opcional](#actualizar-por-qué-init-no-es-opcional)
- [Plugin de Claude Code](#plugin-de-claude-code)
- [Puentes de compatibilidad (`capturar.mjs`, `leer.mjs`)](#puentes-de-compatibilidad-capturarmjs-leermjs)
- [Cuota (statusline de Claude Code)](#cuota-statusline-de-claude-code)
- [Compactación (Claude Code)](#compactación-claude-code)
- [Turnos cortados](#turnos-cortados)
- [Límites conocidos: detalle y mediciones](#límites-conocidos-detalle-y-mediciones)
- [Términos de uso de los proveedores](#términos-de-uso-de-los-proveedores)

---

## Petición automática de la narrativa

El relevo tiene dos mitades. Los **hechos** —archivos, diff, commits, exit
codes— los saca chaski de git y del transcript sin costo ni intervención. La
**intención** —qué intentabas, qué quedó a medias y dónde, el siguiente paso—
solo la puede escribir el agente que estuvo en la conversación.

Pedirla a mano tiene un defecto que no es de disciplina: **la narrativa
consume cuota, porque la escribe el agente**. Quien espera a estar al límite
descubre que el momento en que más la necesita es el único en que ya no se
puede generar. Y el corte por cuota es abrupto: deja la tarea a medias, que es
exactamente cuando el siguiente agente necesita saber dónde quedó.

Por eso chaski la pide por su cuenta, **temprano y repartida**, mientras sobra
cuota. Al terminar un turno con trabajo detrás, el hook puede mantener al agente
un turno más con una instrucción: guarda la narrativa, con énfasis en lo que
quedó en vuelo. No se invoca ningún modelo por fuera —eso lo prohíben los
términos de los tres proveedores— sino que se le pide al agente que ya está en
sesión.

Cada petición cuesta un turno de tu conversación, así que los límites son
conservadores, y en este orden:

1. **Una narrativa escrita hace menos de 20 minutos no se vuelve a pedir**,
   pase lo que pase. Es el corte más fuerte: lo que vuelve insufrible a esta
   función no es pedirla de más en una sesión larga, es pedirla dos veces
   seguidas.
2. **12 minutos** de debounce (espera mínima) entre peticiones.
3. Solo si hay trabajo real detrás: archivos sin commitear, commits nuevos o
   comandos ejecutados.
4. Y solo si la narrativa falta, quedó **8 turnos** atrás (`askNarrativeAfterTurns`
   lo cambia), o hay commits nuevos.

| | |
|---|---|
| Apagarlo | `"askNarrative": false` en `chaski.json` o `chaski.local.json` |
| Cuándo se entrega (#73) | En `Stop` solo se anota en `.tambo/pending-ask.json`. La entrega `inject.mjs` en el evento previo a la respuesta de cada CLI, con el contrato de cada uno: `UserPromptSubmit` con `hookSpecificOutput.additionalContext` en Claude Code (no se pinta en la conversación) y en Codex («extra developer context»), y `PreInvocation` con `injectSteps` en Antigravity, que corre antes de cada llamada al modelo y por eso borra la anotación al entregarla. El agente guarda el relevo **antes** de responder y la respuesta queda al final. Pedirla en `Stop` dejaba las llamadas del guardado debajo de la respuesta, y no hay forma de ocultarlas: `suppressOutput` no tiene efecto en `Stop`, y `SessionEnd` no puede hacer actuar al modelo. No se entrega en otra sesión (el agente no tendría la conversación), ni si ya hay una narrativa posterior, ni pasadas 12 h. Mide ~54 ms por evento en los tres CLIs, contra ~39 ms de un `node` vacío (más el `cmd`/`sh` del wrapper en Codex y agy) |
| Si no llega otro mensaje | `capture.mjs` guarda la última respuesta del agente (`lastReply`: redactada, ~700 caracteres, vence a las 72 h) y el relevo la muestra como «Última respuesta del agente» cuando hubo trabajo después de la narrativa. No pasa por ningún modelo |
| Cuándo NO se difiere | Si el hook de entrega de ese CLI no dio señales de vida en las últimas 12 h (`~/.chaski/prompt-hook.json`, que escribe `inject.mjs` a lo sumo cada 10 min). Cubre la instalación que no volvió a correr `chaski init` y, en Codex, el hook nuevo que el usuario todavía no marcó como confiable. Ahí se sigue pidiendo en `Stop` con el formato de abajo: diferir sin quien entregue dejaría el relevo sin narrativa sin que nadie se entere |
| Cómo se ve (petición en `Stop`) | Una línea bajo el rótulo **«Stop hook feedback»** (cuatro si la sesión no tiene la skill `relevo`: entonces trae la ruta y los campos que hay que escribir). Ese rótulo y el `Ran 1 stop hook` los pinta Claude Code al ejecutar cualquier hook y no se pueden suprimir; lo nuestro es el texto, y es corto a propósito porque ocupa pantalla del usuario. Se emite con `hookSpecificOutput.additionalContext`, que la documentación llama «non-error feedback»: mantiene el turno extra y las protecciones contra bucles sin rotularse como error. En una versión de Claude Code anterior a ese campo la petición no llega — no rompe nada |
| Petición en `Stop` (respaldo) | Los tres, con el contrato de cada uno: `hookSpecificOutput.additionalContext` en Claude Code, `decision: "block"` en Codex y `decision: "continue"` en Antigravity, que trata cualquier otro valor como permiso para parar |
| En Codex | su hook `Stop` se registra **síncrono**, porque un hook en segundo plano no puede bloquear. Esperas la captura (~220 ms) al cerrar cada turno |

## Capturar payloads (`chaski probe`)

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
modo headless. `chaski probe` instala una sonda temporal en
`~/.chaski/sonda.mjs`; `--show` muestra los payloads capturados en
`~/.chaski/sonda.log`. `--clean` quita la sonda y conserva los cambios hechos
en la configuración mientras estaba activa. Los hooks normales siguen activos
en los tres CLIs.

## Actualizar: por qué `init` no es opcional

**Ejecutar `chaski init` tras actualizar no es opcional.** Los hooks se
registran con la ruta absoluta de los scripts, así que una actualización que
mueva la carpeta de instalación —o que cambie un nombre de archivo— deja la
configuración apuntando a algo que ya no existe, y el CLI imprime un error de
módulo no encontrado en cada turno. `chaski init` reescribe las rutas y es
idempotente: correrlo de nuevo sobre una instalación sana no cambia nada.

También actualiza las copias de la skill y el bloque de peticiones de
`AGENTS.md` en ese proyecto. Las secciones antiguas sin delimitadores se
conservan, porque pueden contener instrucciones escritas por ti.

Si ya estás viendo ese error, corre `chaski init`. Pero **la sesión que ya lo
tiene abierto no lo va a ver desaparecer**: los CLIs leen su configuración de
hooks una sola vez, al arrancar, así que `init` corrige la ruta para la
próxima sesión, no para la que está corriendo. Cierra esa sesión y abre una
nueva. `chaski doctor` muestra qué eventos quedaron registrados y la ruta de
los scripts, por si quieres confirmarlo antes de reabrir.

## Plugin de Claude Code

El repositorio es a la vez marketplace (`.claude-plugin/marketplace.json`, nombre
`chaski`) y plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`), así
que el id en `enabledPlugins` es `chaski@chaski`.

| | |
|---|---|
| Forma de los hooks | Exec, sin shell: `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/capture.mjs", "Stop", "claude-code"]`. Sin comillas que se rompan con espacios y sin diferencias entre Git Bash, PowerShell y `sh` |
| Versión | Fijada en `plugin.json` y siempre igual a `package.json` (un test lo exige). Claude Code solo actualiza a quien tiene el plugin cuando esa versión cambia |
| Skill | La misma `skill/SKILL.md`, declarada con `"skills": ["./skill"]`. Queda con espacio de nombres: `chaski:relevo` |
| Duplicados | Los hooks del plugin y los de `settings.json` se suman y corren en paralelo. Los del plugin traen `CLAUDE_PLUGIN_ROOT` en el entorno y los de `settings.json` no: si el plugin está activo, estos últimos salen sin hacer nada (`silencedByPlugin()` en `src/lib/paths.mjs`) |
| Activo | `enabledPlugins["chaski@chaski"]` en `~/.claude/settings.json`, `.claude/settings.json` o `.claude/settings.local.json`, con esa precedencia de menos a más específico |
| Sin `init` | `.tambo/` se crea con su propio `.gitignore` (`*`), así que queda fuera de git igual |
| Validar | `claude plugin validate .` y `claude plugin validate ./.claude-plugin/marketplace.json` |

## Puentes de compatibilidad (`capturar.mjs`, `leer.mjs`)

Desde la 0.1.0 los dos nombres de archivo anteriores a la homologación al
inglés —`capturar.mjs` y `leer.mjs`— siguen funcionando como puentes, así que
una configuración vieja ya no produce ese volcado de Node: captura e inyecta
igual, y el hook de inicio de sesión imprime una línea recordando que conviene
correr `init`. Los puentes existen para que actualizar no rompa nada, no para
quedarse: `init` sigue siendo el paso correcto. El puente de captura no avisa
por stderr a propósito: corre en cada turno y sería ruido inapagable.

El [CHANGELOG](https://github.com/cristobalbn/chaski/blob/main/CHANGELOG.md)
cuenta la versión en que volvieron.

## Cuota (statusline de Claude Code)

La narrativa se pide temprano porque escribirla consume cuota. Claude Code le
pasa a la statusline cuánto va gastado (`rate_limits.five_hour` y
`rate_limits.seven_day`, con `used_percentage` y `resets_at`; solo en planes
Pro, Max y Ultra, y recién tras la primera respuesta), y no lo expone en
ningún otro lugar. Por eso `chaski init --statusline` instala
`src/statusline.mjs`.

| | |
|---|---|
| Qué hace | Anota la cuota en `~/.chaski/usage.json` (si cambió o pasó un minuto) y después corre tu statusline anterior con el mismo stdin y devuelve su salida. Sin statusline propia, imprime modelo y cuota |
| Tu statusline | Su comando queda en `~/.chaski/config.json` → `statusLineCommand`; `padding` y el resto se conservan. Se ejecuta con `sh` (Git Bash en Windows si está) y 3 s de tope; si falla, sale la línea mínima en vez de una barra vacía |
| Cuándo pide | En `Stop`, si el dato tiene menos de 15 min, la ventana más gastada pasa de `askNarrativeAtQuota` (80 por defecto) y todavía no se renovó, hubo trabajo después de la última narrativa y no se pidió ya en esa ventana (`askedQuotaKey`). Va antes que los motivos por turnos |
| Opt-in | `statusLine` es una sola entrada de `settings.json` y suele ser algo armado a gusto: `init` solo la toca con `--statusline`. `uninstall` la devuelve como estaba |
| Costo | ~52 ms por ejecución contra ~37 ms de un `node` vacío, más lo que tarde tu statusline. Corre con cada mensaje del asistente, con un debounce de 300 ms de Claude Code |
| Codex y agy | No documentan un dato equivalente |

## Compactación (Claude Code)

Al compactar, Claude Code reemplaza la conversación por un resumen, y lo que el
resumen no conserve se pierde igual que al cambiar de agente. Lo que imprime
el hook `PreCompact` «becomes instructions for the compaction summary», así que
`capture.mjs` pide ahí lo mismo que una narrativa: tarea, decisiones y
descartes con su porqué, lo que quedó a medias con rutas y el siguiente paso.
Los hechos no se piden: chaski los guarda solo y los vuelve a inyectar en el
`SessionStart` que sigue a la compactación. La instrucción sale antes del lock
y no depende del estado. Codex y agy no la reciben: Codex no documenta qué hace
con esa salida y agy no tiene el evento.

## Turnos cortados

El hook de entrega (`UserPromptSubmit`, o `PreInvocation` en agy) anota el
turno como abierto en `.tambo/turns-open.json` al empezar, y `capture.mjs` lo
quita al cerrarlo (`Stop`, `StopFailure` o `SessionEnd`; `PreCompact` no,
porque la compactación automática ocurre a mitad de un turno). Si la marca
sobrevive, el turno se cortó: interrupción, ventana cerrada o cuelgue.

| | |
|---|---|
| Cuándo se avisa | Al arrancar una sesión **distinta**, si el turno cortado empezó **después** de la última captura: solo entonces el relevo es de antes de algo que el agente nuevo no ve. Una captura posterior lo deja de avisar |
| Qué dice | Qué CLI cortó el turno y hace cuánto, y que revise `git status` y `git diff` antes de seguir |
| Dónde no se crea | En un proyecto sin `.tambo/`: el hook corre en cada mensaje de cualquier proyecto |
| Vencimiento | 72 h |
| Costo | Una escritura por turno (en agy, por turno y no por llamada al modelo) |

## Límites conocidos: detalle y mediciones

El README conserva los límites que cambian lo que haces. Aquí queda el resto.

| Límite | Valor | Por qué |
|---|---|---|
| Latencia del hook | ~220 ms (antes ~340 ms; se redujeron los subprocesos de git de 9 a 3 en árbol limpio, o 4 si hay archivos sucios) | El presupuesto de `Stop` en Claude Code es de 1,5 s **compartido** entre todos los hooks del evento. Hay margen de casi 7x, pero si tienes muchos hooks ahí, mide |
| Un turno con miles de archivos modificados | el relevo sale **incompleto, y lo dice** | El hook tiene un presupuesto de tiempo propio y sacrifica lo caro y poco informativo antes de agotarlo: primero el detalle de líneas `+/-` por archivo, después el log de commits. La rama, el `HEAD`, la lista de archivos y su total siempre sobreviven. Lo que se omitió aparece declarado en el relevo, porque un relevo incompleto que se presenta como completo es peor que uno recortado. Medido: 5.000 archivos modificados pasaban de 2.000 ms —y perdían el relevo entero— y ahora el hook completo tarda ~220-340 ms |

**Relevos de antes del renombre a `branches/`.** Versiones viejas de chaski
guardaban el relevo en `.tambo/ramas/<rama>/`. Ni `inject.mjs` ni `doctor`
migran ni mencionan esa carpeta: si tienes relevos ahí, quedaron huérfanos.
Para recuperarlos a mano, copia el contenido de
`.tambo/ramas/<rama>/estado.json` al campo `narrative` (y
`narrativeAuthor`/`narrativeWrittenAt`) del `estado.json` nuevo en
`.tambo/branches/<rama>/` — los hechos no se recuperan porque ya están
obsoletos, pero la narrativa escrita a mano sí vale la pena rescatarla.
Después puedes borrar `.tambo/ramas/`.

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

## Publicación del relevo

`estado.json` guarda los hechos, la narrativa y una copia acotada del Markdown
firmado. La captura lo reemplaza primero y después publica `relevo.md`. El
arranque puede usar la copia firmada si la vista falta o si su firma coincide
con la última vista publicada. Los relevos anteriores conservan su lectura
habitual. Una vista editada conserva el aviso de firma inválida.

Se compararon tres diseños. Dos renombres independientes dejan una ventana
con versiones distintas. Una base transaccional resolvería esa coordinación
a costa de migrar el archivo que editan las skills. La copia firmada en el
estado mantiene ese contrato y acota el costo adicional al tamaño del relevo.
La recuperación cubre una interrupción del proceso entre escrituras. La
durabilidad ante pérdida de energía exige garantías adicionales del sistema
de archivos. [Node.js](https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath) ·
[SQLite y commit atómico](https://sqlite.org/atomiccommit.html)
