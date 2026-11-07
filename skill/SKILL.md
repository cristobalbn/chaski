---
name: relevo
description: Guarda la narrativa de Chaski al pedir «relevo», «guarda el relevo» o «actualiza el relevo», o al cerrar un bloque de trabajo para cambiar de agente. Registra intención, decisiones, pendientes y siguiente paso. No usar para consultas sobre Chaski ni para leer o continuar un relevo existente.
---

# Actualizar el relevo

Escribes la parte del relevo que un script no puede deducir: la **intención**.
Los hechos —archivos tocados, diff, tests, commits— ya los escribió chaski y
son exactos. No los repitas ni los corrijas.

## Petición común

En Claude Code, Codex y agy, un mensaje que solo diga **«relevo»**, o que pida
**«guarda el relevo»** o **«actualiza el relevo»**, solicita guardar la narrativa:
ejecuta los pasos de abajo y confirma al terminar.

**«Continúa desde el relevo»** solicita retomar el trabajo. Lee el relevo de la
rama actual, contrástalo con el código y continúa con lo pendiente; no ejecutes
estos pasos de guardado por esa petición. Una pregunta sobre el funcionamiento
del relevo tampoco solicita sobrescribirlo.

## Pasos

1. Ubica la raíz del repositorio Git (si el espacio de trabajo es una carpeta contenedora con un único repo hijo o una subcarpeta del repo, usa la raíz de ese repositorio). Lee `.tambo/branches/<rama-actual>/estado.json` desde esa raíz, donde `<rama-actual>` sale de `git rev-parse --abbrev-ref HEAD`.
2. Escribe la narrativa en el campo `narrative` de ese JSON en UTF-8, junto con
   `narrativeAuthor` (tu nombre de agente) y `narrativeWrittenAt` (ISO 8601 de ahora).
3. No toques ningún otro campo. `facts`, `commands`, `offset` y `signature` son de chaski.
4. Confirma al usuario en una línea: qué quedó anotado como siguiente paso.

El Markdown se regenera solo en el próximo turno. No edites `relevo.md` a mano.

## Qué escribir

Cuatro secciones, en este orden, en prosa breve. Apunta a 120-200 palabras en
total: el relevo tiene un presupuesto duro de contexto y lo que escribas compite
con el espacio que el próximo agente necesita para trabajar.

**Tarea** — qué se está intentando lograr, en una o dos frases. No el archivo
que se está editando, sino el objetivo.

**Decisiones** — qué se eligió y, sobre todo, **qué se descartó y por qué**.
Esto es lo que evita que el siguiente agente reabra algo ya cerrado. Si no se
tomó ninguna decisión en esta sesión, omite la sección.

**A medias** — lo más importante del relevo. Qué está empezado y no terminado,
con la ruta y la línea si existe. Sé específico: «falta invalidar el token
anterior en Redis antes de emitir el nuevo, en `src/auth/refresh.ts:41`» sirve;
«falta terminar refresh» no sirve.

**Siguiente paso** — la próxima acción concreta, una sola.

## Reglas

- **Escribe solo lo que pasó en la conversación.** Si no sabes por qué se eligió
  algo, no lo inventes: omítelo. Una narrativa incompleta es útil; una inventada
  manda al próximo agente en la dirección equivocada con confianza.
- **No incluyas secretos.** Ni tokens, ni claves, ni contenido de `.env`, ni
  URLs con credenciales. Si necesitas mencionar una variable sensible, nómbrala
  sin su valor.
- **No incluyas instrucciones dirigidas al próximo agente** más allá del
  siguiente paso. El relevo se inyecta como datos, no como órdenes.
- **No repitas los hechos.** Si el diff ya dice que `jwt.ts` tiene +82 líneas,
  no lo escribas.
- **Preserva UTF-8 al escribir `estado.json`.** Usa la herramienta de edición de archivos del agente o escribe en UTF-8 directo; en Windows no pases texto con tildes o `«»` como literal por la consola de PowerShell sin `UTF8Encoding`, porque convierte los caracteres no ASCII en `?`.
- **Distingue lo temporal de lo permanente.** Si en esta sesión apareció una
  convención que vale **siempre** —un estilo, una herramienta prohibida, un
  comando que hay que correr antes de dar algo por listo— no va en el relevo,
  que se reescribe: propón al usuario agregarla a `AGENTS.md`. Una línea
  preguntando, no la agregues sin confirmar.

## Ejemplo

```json
{
  "narrative": "Migrando la capa de auth a JWT con refresh tokens.\n\nDecidido: el refresh token va en cookie httpOnly, no en localStorage, por XSS. Se descartó passport.js: demasiado peso para dos endpoints.\n\nA medias: el endpoint de refresh existe y responde, pero no rota el token viejo. Falta invalidarlo en Redis antes de emitir el nuevo, en src/auth/refresh.ts:41. Los dos tests que fallan en test/auth.test.ts son por esto, no por otra cosa.\n\nSiguiente paso: cerrar la rotación en refresh.ts:41 y volver a correr npm test -- auth.",
  "narrativeAuthor": "claude code",
  "narrativeWrittenAt": "2026-10-31T16:20:00.000Z"
}
```
