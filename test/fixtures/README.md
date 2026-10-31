# Fixtures

Payloads de hooks y transcripts de los tres CLIs soportados.

**Son sintéticos, no capturas literales.** La estructura, los nombres de campo
y los tipos de evento se tomaron de capturas reales hechas el 2026-10-31 con
`chaski probe`; el contenido es inventado. Un transcript real lleva rutas con
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
| `agy.payload.json` | hook `Stop`, Antigravity CLI 1.4.12 |
| `agy.transcript.jsonl` | pasos con `step_index`, `type` y `content` |

Los tres formatos de transcript son distintos entre sí. Ninguno de los CLIs
prometió mantenerlos estables entre versiones, y por eso hay un test por
formato.
