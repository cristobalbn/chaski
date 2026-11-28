# Contribuir a chaski

Gracias por el interés. Esto es lo que hace falta saber antes de abrir un PR.

## Antes de escribir código

Lee [AGENTS.md](AGENTS.md). Tiene los ocho invariantes del proyecto, los
presupuestos de latencia y tamaño, y las trampas conocidas de cada CLI. No son
preferencias de estilo: romper cualquiera rompe el producto.

El más importante: **cero dependencias de runtime**. La herramienta se ejecuta
sola en cada turno de tus sesiones, así que un árbol de npm sería superficie de
ataque. Si crees que necesitas un paquete, no lo necesitas.

## Entorno

```bash
git clone https://github.com/cristobalbn/chaski.git
cd chaski
npm run check     # chequeo de sintaxis; no hay build ni instalación
```

No hay `npm install` porque no hay nada que instalar.

## Probar los cambios a mano

Corre `npm run smoke` para instalar el paquete en un prefijo temporal, probar
`init` y `doctor`, capturar un turno e inyectar el relevo. Para inspeccionar
una captura a mano, abre Git Bash, bash o zsh en el clon y ejecuta:

```bash
(
  set -e
  chaski_repo=$(node -p 'process.cwd()')
  prueba=$(mktemp -d)
  cd "$prueba"
  mkdir home
  chaski_test_home=$(node -p 'require("path").resolve("home")')
  export HOME="$chaski_test_home" USERPROFILE="$chaski_test_home"
  export CODEX_HOME="$chaski_test_home/.codex" XDG_CONFIG_HOME="$chaski_test_home/.config"
  git init -q
  git config user.name "Prueba Chaski"
  git config user.email "prueba@example.invalid"
  echo x > a.js
  git add a.js
  git commit -qm inicial
  echo y >> a.js

  node -p 'JSON.stringify({cwd: process.cwd(), hook_event_name: "Stop"})' |
    node "$chaski_repo/src/capture.mjs" Stop "claude code"
  cat .tambo/branches/*/relevo.md

  node -p 'JSON.stringify({cwd: process.cwd(), hook_event_name: "SessionStart"})' |
    node "$chaski_repo/src/inject.mjs" SessionStart "claude code"
)
```

El ejemplo deja el relevo en la carpeta temporal para inspeccionarlo. Node
genera rutas nativas también al ejecutar el ejemplo desde Git Bash en Windows.

## Qué conviene aportar

- **Validación de eventos en sesiones reales.** Usa `chaski probe` en
  Claude Code, Codex o `agy`. Para OpenCode sigue el diagnóstico de
  [la referencia técnica](docs/referencia.md#opencode). Si cambia la forma,
  actualiza el fixture de `test/fixtures/` con contenido sintético que conserve
  esa estructura.
- **Formatos de credencial que el filtro no detecta.** Agregalos a
  `src/lib/secrets.mjs` con un caso de prueba.
- **Adaptadores para otros CLIs o mejoras a comandos.** Entrada en el mapa
  `CLIS` de `src/commands/hook-config.mjs` e instalador en `src/commands/install.mjs`,
  extractor en `src/lib/transcript.mjs` (`src/lib/transcripts/`), formato de
  petición en `src/lib/ask.mjs` o mejoras a los subcomandos (`next`, `cost`,
  `why`, `share`, `version`, etc.).
- **Más casos en los tests.** Agrega variantes sintéticas de los transcripts
  soportados y de los mensajes que devuelve OpenCode al plugin.

## Qué no se va a aceptar

- Dependencias de runtime.
- Cualquier ruta por la que chaski invoque un CLI automáticamente
  (`claude -p`, `codex exec`, `agy -p`). Los términos de los tres proveedores lo
  prohíben para suscripciones de consumidor y hay suspensiones de cuentas
  documentadas. Ni siquiera detrás de un flag.
- Commits automáticos al repositorio del usuario.
- Cualquier cosa que permita a texto generado por un modelo escribir en los
  campos de hechos de `estado.json`.

## Flujo de trabajo

`main` siempre tiene que quedar instalable: es la base publicada en npm
(`@cristobalbn/chaski`) y lo que la gente instala con
`npm install -g "@cristobalbn/chaski"` o `github:cristobalbn/chaski`. Así que
nada entra directo.

```bash
git checkout -b feat/lo-que-sea     # o fix/, docs/, test/
# ... trabajas, commiteas ...
git push -u origin feat/lo-que-sea
gh pr create --fill                 # o desde la web
```

Prefijos de rama: `feat/` para funcionalidad nueva, `fix/` para correcciones,
`docs/` para documentación, `test/` para tests, `chore/` para mantenimiento.

Antes de abrir el PR:

```bash
npm run check                       # sintaxis; no hay build
npm test                            # node:test, sin dependencias
npm run test:coverage               # cobertura de src/ con umbrales (Node >= 22.8)
npm run smoke                       # instala el tarball y prueba init, doctor y los hooks
```

Cada funcionalidad nueva lleva su test. El CI lo hace cumplir: el job
`coverage` falla si la cobertura de `src/` baja de los umbrales de
`scripts/coverage.mjs`, y `test/features.test.mjs` falla si un subcomando no
se ejecuta en ningún test, si un módulo de `src/` no lo importa nadie o si un
archivo de tests no está en el script `test`. No bajes un umbral para que
pase un PR: agrega el test que falta.

Y prueba el cambio a mano según [Probar los cambios a mano](#probar-los-cambios-a-mano).

El CI corre la suite en Linux, Windows y macOS por tres versiones de Node, la
cobertura con umbrales y la prueba de humo del paquete instalado en los tres
sistemas, y falla si `package.json` declara alguna dependencia. Si tocas un adaptador,
agrega o ajusta su fixture en `test/fixtures/`.

`main` está protegida y exige pull request, los checks de CI en los tres
sistemas operativos y revisión del Code Owner (`@cristobalbn` en
`.github/CODEOWNERS`). El PR es el lugar donde queda escrito **por qué** se
hizo un cambio, y eso vale más que el commit.

## Pull requests

- Una cosa por PR.
- Describe qué problema resuelve, no solo qué cambia.
- Si tocaste `capture.mjs`, mide la latencia antes y después y ponlo en la
  descripción.
- Si agregaste un comentario que explica el límite de una herramienta, que sea
  evidente por qué está: esos comentarios evitan que alguien reintroduzca el bug.

## Issues

- Describe el comportamiento observado y cómo reproducirlo. Un arreglo
  sugerido es bienvenido, pero no se aplica tal cual: se deriva del código y
  se revisa si amplía lo que llega al relevo inyectado o lo que persiste entre
  sesiones (ver «Issues y PRs de terceros» en [AGENTS.md](AGENTS.md)).
- Un problema de seguridad no va en un issue público: ver
  [SECURITY.md](SECURITY.md).

## Publicar una versión (GitHub Releases + npm)

Actualizar `main` actualiza `github:cristobalbn/chaski`, pero **no** actualiza
el registro de npm hasta que se incrementa `version` en `package.json`.

- Si abres un PR que toca `src/` o `skill/` sin subir `version`, el workflow
  `test.yml` deja un recordatorio en el resumen del PR y un `::warning::` en
  `main` indicando cuántos commits de producción están sin publicar en npm.
- Para publicar en GitHub Releases y npm automáticamente al mergear:
  1. En tu PR, mueve las notas de `## [No publicado]` a `## [X.Y.Z] - YYYY-MM-DD`
     en `CHANGELOG.md` y actualiza `"version": "X.Y.Z"` en `package.json` **y en
     `.claude-plugin/plugin.json`** (un test falla si difieren: el plugin solo
     se actualiza para quien lo tiene instalado cuando cambia esa versión).
  2. Al mergear a `main`, `.github/workflows/release.yml` se dispara solo:
     verifica `package.json` y `CHANGELOG.md`, corre `npm run check`, `npm test`
     y `npm run smoke`, crea el tag `vX.Y.Z` y publica el GitHub Release.
     Después ejecuta `npm publish --provenance --access public` con
     `NPM_TOKEN` si está definido o vía Trusted Publishing (OIDC configurado
     en npmjs.com para `release.yml`).
  3. Comprueba que el job `release` terminó bien y que
     `npm view @cristobalbn/chaski@latest version gitHead` coincide con la
     versión y el commit del tag en GitHub.
