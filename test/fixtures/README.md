# Fixtures

Payloads de hooks y transcripts de los tres CLIs soportados.

**Son sintéticos, no capturas literales.** La estructura, los nombres de campo
y los tipos de evento se tomaron de capturas reales hechas entre el 2026-10-31 y
el 2026-11-07 con `chaski probe`; el contenido es inventado. Un transcript real
lleva rutas con
el nombre de usuario y la conversación completa de alguien, y esto es un
repositorio público.

Lo que importa de un fixture es la **forma**, porque es lo que se rompe cuando
un CLI cambia de versión. Si capturas un payload con una forma distinta,
reemplaza el fixture y ajusta el test: eso es exactamente lo que estos tests
existen para detectar.

| Archivo | Origen |
|---|---|
| `claude-code.payload.json` | hook `Stop`, Claude Code 2.1.316 |
| `claude-code.transcript.jsonl` | bloques con `tool_use` y `tool_result` |
| `codex.payload.json` | hook `SessionStart`, Codex CLI 0.166.0 |
| `codex.transcript.jsonl` | rollout `{timestamp, ordinal, type, payload}` |
| `codex-code-mode.transcript.jsonl` | formato observado el 2026-11-07: `custom_tool_call` y `CommandExecution`; contenido sintético |
| `agy.payload.json` | hook `Stop`, Antigravity CLI 1.4.12 |
| `agy.transcript.jsonl` | pasos con `step_index`, `type` y `content` |
| `agy-tool-calls.transcript.jsonl` | formato observado el 2026-11-07: `tool_calls` en `PLANNER_RESPONSE` y salidas `GENERIC`; contenido sintético |
| `opencode.messages.json` | respuesta de `client.session.messages()` en el plugin de OpenCode 1.19.6 (2026-11-27): `{ info, parts }` con partes `text`, `reasoning`, `tool` (`state.input.command`, `state.metadata.exit`); contenido sintético |
| `opencode.events.json` | eventos y entradas de hooks del plugin de OpenCode 1.19.6 (2026-11-27): `session.created`, `session.idle`, `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`; contenido sintético |
| `opencode-v2.context.json` | respuesta de `ctx.session.context()` en el plugin de OpenCode 2.4.2 (2026-11-27): `{ type: "user", text }`, `{ type: "assistant", content }` con herramientas `{ type: "tool", name: "shell" \| "read", state }` y `{ type: "idle" }`; contenido sintético |
| `opencode-v2.events.json` | eventos del bus (`session.created`, `session.execution.succeeded`), `ctx.session.get()` y entradas de los hooks `prompt`, `context` y `compaction` de OpenCode 2.4.2 (2026-11-27); contenido sintético |
| `claude-code-prompt.payload.json` | hook `UserPromptSubmit` de Claude Code, **según la documentación oficial** (2026-11-20), sin captura real todavía |
| `codex-prompt.payload.json` | hook `UserPromptSubmit` de Codex, **según la documentación oficial** (2026-11-20), sin captura real todavía |
| `agy-preinvocation.payload.json` | hook `PreInvocation` de Antigravity, **según la documentación instalada** (`agy-customizations/docs/hooks.md`), sin captura real todavía |

### Última verificación contra cada CLI real

La versión verificada de cada CLI vive en `scripts/upstream.json`
(`verified`). Esta tabla dice **cómo** se verificó, para que nadie suba una
versión sin haber corrido el CLI.

| CLI | Versión | Fecha | Cómo |
|---|---|---|---|
| Claude Code | 2.1.330 | 2026-11-27 | `node scripts/verify-local.mjs` sobre un transcript real; hooks activos en la misma sesión |
| Codex CLI | 0.171.0 | 2026-11-27 | `scripts/verify-local.mjs` sobre una sesión del 2026-11-22; `estado.json` escrito por su hook `Stop` |
| agy | 1.5.14 | 2026-11-27 | `scripts/verify-local.mjs` sobre un transcript del 2026-11-21, día en que se instaló 1.5.14 (el transcript no trae versión) |
| OpenCode 1.x | 1.19.6 | 2026-11-27 | turno real con el plugin en un HOME aislado: captura, inyección y compactación |
| OpenCode 2.x | 2.4.2 | 2026-11-27 | ídem, con `@opencode/cli` instalado en un prefijo aparte |

Los tres `*-prompt` / `*-preinvocation` no salen de `chaski probe`: reemplázalos por una captura real en cuanto haya una. Si la forma difiere, el test de contrato lo dice.

Los tres formatos de transcript son distintos entre sí. Ninguno de los CLIs
prometió mantenerlos estables entre versiones, y por eso hay un test por
formato.
