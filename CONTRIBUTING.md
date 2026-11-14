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

Además de la suite automatizada (`npm test`), para probar los hooks a mano el ciclo es este:

```bash
mkdir /tmp/prueba && cd /tmp/prueba && git init
echo "x" > a.js && git add -A && git commit -m inicial
echo "y" >> a.js

echo '{"cwd":"'$PWD'","hook_event_name":"Stop"}' | node ruta/a/chaski/src/capture.mjs Stop "claude code"
cat .tambo/branches/*/relevo.md

echo '{"cwd":"'$PWD'"}' | node ruta/a/chaski/src/inject.mjs
```

En Windows, usa rutas nativas: una ruta POSIX de Git Bash no resuelve cuando el
hook se ejecuta de verdad.

## Qué conviene aportar

- **Validación de los payloads de Codex y `agy`.** Es lo más útil ahora mismo.
  Si tienes esos CLIs, captura el JSON real que llega por stdin en cada evento y
  envíalo como fixture en `test/fixtures/`.
- **Formatos de credencial que el filtro no detecta.** Agregalos a
  `src/lib/secrets.mjs` con un caso de prueba.
- **Adaptadores para otros CLIs o mejoras a comandos.** Entrada e instalador en
  el mapa `CLIS` de `src/cli.mjs`, extractor en `src/lib/facts.mjs`, formato de
  petición en `src/lib/ask.mjs` o mejoras a los subcomandos (`next`, `cost`,
  `why`, `share`, `version`, etc.).
- **Más casos en los tests.** Nuevas variantes de transcripts de los CLIs
  soportados (capturadas con `chaski probe`) o de herramientas emergentes.

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
```

Y prueba el cambio a mano según la sección de abajo.

El CI corre la suite en Linux, Windows y macOS por tres versiones de Node, y
falla si `package.json` declara alguna dependencia. Si tocas un adaptador,
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
     en `CHANGELOG.md` y actualiza `"version": "X.Y.Z"` en `package.json`.
  2. Al mergear a `main`, `.github/workflows/release.yml` se dispara solo:
     verifica `package.json` + `CHANGELOG.md`, corre `npm run check` y `npm test`,
     crea el tag `vX.Y.Z`, publica el GitHub Release y ejecuta
     `npm publish --provenance --access public` vía Trusted Publishing (OIDC
     configurado en npmjs.com para `release.yml`) o con secret `NPM_TOKEN` como
     respaldo.
