---
name: relevo
description: Actualiza la narrativa del relevo de chaski con el estado del trabajo actual — qué se está haciendo, qué se decidió, qué quedó a medias y cuál es el siguiente paso. Usar al cerrar un bloque de trabajo, antes de una sesión larga, o cuando el usuario lo pida.
---

# Actualizar el relevo

Escribes la parte del relevo que un script no puede deducir: la **intención**.
Los hechos —archivos tocados, diff, tests, commits— ya los escribió chaski y
son exactos. No los repitas ni los corrijas.

## Pasos

1. Lee `.tambo/branches/<rama-actual>/estado.json`. La rama sale de `git rev-parse --abbrev-ref HEAD`.
2. Escribe la narrativa en el campo `narrativa` de ese JSON, junto con
   `narrativaAutor` (tu nombre de agente) y `narrativaEscrita` (ISO 8601 de ahora).
3. No toques ningún otro campo. `facts`, `commands`, `offset` y `firma` son de chaski.
4. Confirmá al usuario en una línea: qué quedó anotado como siguiente paso.

El Markdown se regenera solo en el próximo turno. No edites `relevo.md` a mano.

## Qué escribir

Cuatro secciones, en este orden, en prosa breve. Apuntá a 120-200 palabras en
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
- **Distingue lo temporal de lo permanente.** Si en esta sesión apareció una
  convención que vale **siempre** —un estilo, una herramienta prohibida, un
  comando que hay que correr antes de dar algo por listo— no va en el relevo,
  que se reescribe: propón al usuario agregarla a `AGENTS.md`. Una línea
  preguntando, no la agregues sin confirmar.

## Ejemplo

```json
{
  "narrativa": "Migrando la capa de auth a JWT con refresh tokens.\n\nDecidido: el refresh token va en cookie httpOnly, no en localStorage, por XSS. Se descartó passport.js: demasiado peso para dos endpoints.\n\nA medias: el endpoint de refresh existe y responde, pero no rota el token viejo. Falta invalidarlo en Redis antes de emitir el nuevo, en src/auth/refresh.ts:41. Los dos tests que fallan en test/auth.test.ts son por esto, no por otra cosa.\n\nSiguiente paso: cerrar la rotación en refresh.ts:41 y volver a correr npm test -- auth.",
  "narrativaAutor": "claude code",
  "narrativaEscrita": "2026-10-31T16:20:00.000Z"
}
```
