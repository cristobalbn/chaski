---
name: relevo
description: Guarda la narrativa de Chaski al pedir «relevo», «guarda el relevo» o «actualiza el relevo», o al cerrar un bloque de trabajo para cambiar de agente. Registra intención, decisiones, pendientes y siguiente paso. No usar para consultas sobre Chaski ni para leer o continuar un relevo existente.
---

# Actualizar el relevo

Escribes la parte del relevo que un script no puede deducir: la **intención**.
Los hechos —archivos tocados, diff, tests, commits— ya los escribió chaski y
son exactos. No los repitas ni los corrijas.

## Petición común

En Claude Code, Codex y agy:
- **«relevo»**, **«guarda el relevo»** o **«actualiza el relevo»**: solicita guardar la narrativa de la sesión actual. Ejecuta los pasos de **Guardar el relevo** y confirma al terminar.
- **«continúa desde el relevo»**: solicita retomar el trabajo. Lee el bloque `<<<RELEVO-CHASKI>>>` inyectado al inicio de la sesión (o `.tambo/branches/<slug>/relevo.md`), contrástalo con `git status` y los archivos mencionados, y ejecuta el siguiente paso pendiente; **no** sobrescribas la narrativa al recibir esta petición.
- Una pregunta sobre el funcionamiento del relevo o sobre decisiones pasadas (para lo cual puedes ejecutar `chaski why [tema]`) tampoco solicita sobrescribirlo.

## Pasos para guardar el relevo

1. **Ubica la raíz del repositorio Git** (si el espacio de trabajo es una carpeta contenedora con un único repo hijo o una subcarpeta del repo, usa la raíz de ese repositorio).
2. **Ubica el archivo `.tambo/branches/<slug>/estado.json`** correspondiente a la rama actual (`git rev-parse --abbrev-ref HEAD`):
   - Si el nombre de la rama solo contiene letras, números, `.`, `_` o `-` y hasta 60 caracteres (por ejemplo `main`, `develop`, `feat-pagos`), `<slug>` es el nombre de la rama tal cual: `.tambo/branches/main/estado.json`.
   - Si el nombre de la rama contiene `/` u otros caracteres especiales (por ejemplo `feat/pagos` o `fix/login`), chaski reemplaza esos caracteres por `-` y agrega un sufijo hash de 6 caracteres: `.tambo/branches/feat-pagos-<hash>/estado.json` (dentro del archivo, `"facts.branch"` coincide exactamente con la rama actual). Lista `.tambo/branches/` para tomar la carpeta `<rama-con-guiones>-*` sin adivinar el hash.
3. **Actualiza únicamente los tres campos de narrativa** en ese JSON (codificación UTF-8):
   - `"narrative"`: texto con las cuatro secciones de abajo.
   - `"narrativeAuthor"`: tu identificador canónico (`"claude code"`, `"codex"` o `"agy"`).
   - `"narrativeWrittenAt"`: marca ISO 8601 UTC actual (`new Date().toISOString()`). La siguiente captura detecta la marca nueva y archiva la narrativa en `.tambo/historia/entries.jsonl`.
4. **No toques ningún otro campo.** `facts`, `commands`, `offset`, `turns`, `subagents` y `signature` los calcula y firma chaski.
5. **Confirma al usuario en una línea** qué quedó anotado como siguiente paso.

El Markdown (`relevo.md`) se regenera y firma solo en el próximo turno. **No edites `relevo.md` a mano.**

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
