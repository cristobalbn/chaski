# Workflows

El proyecto cuenta con dos workflows en GitHub Actions:

## `test.yml` (Integración Continua)

Corre en cada push a `main`, en cada pull request y bajo `workflow_dispatch`, con permisos de solo lectura (`contents: read`).

- **Matriz multiplataforma:** ejecuta en Ubuntu (`ubuntu-latest`), Windows (`windows-latest`) y macOS (`macos-latest`) sobre Node 20, 22 y `lts/*`. Verifica tanto los scripts `.cmd` de Windows como los `.sh` de Unix que genera el envoltorio de hooks.
- **Invariante cero dependencias:** falla inmediatamente si `package.json` declara alguna dependencia en `dependencies` o `devDependencies`.
- **Chequeo de sintaxis y tests:** ejecuta `npm run check` (los 11 módulos `.mjs`) y `npm test` (193 tests con `node:test`).
- **Sincronización con npm y tags:** en Ubuntu con Node 22, valida si un PR tocó archivos distribuidos (`src/`, `skill/`) sin incrementar `version` en `package.json` o sin sección en `CHANGELOG.md`, y emite advertencias si `@cristobalbn/chaski` en npm quedó desfasado respecto a `main`.

## `release.yml` (Publicación Automática y Segura)

Se dispara al mergear a `main` un commit que modifique `package.json`, al empujar tags `v*.*.*` o manualmente (`workflow_dispatch`).

1. Verifica que el commit pertenezca a la rama protegida `main` (`git merge-base --is-ancestor HEAD origin/main`), garantizando que ningún código sin revisión ni CI pueda publicarse.
2. Verifica cero dependencias y coherencia entre el tag, `package.json` y la sección `## [X.Y.Z]` en `CHANGELOG.md`.
3. Ejecuta `npm run check`, `npm test` y `npm pack --dry-run`.
4. Si el tag `vX.Y.Z` aún no existe, lo crea y lo envía a `origin`.
5. Crea el GitHub Release extrayendo automáticamente las notas de esa versión desde `CHANGELOG.md`.
6. Publica en npm como `@cristobalbn/chaski` con `--provenance` y `--access public` usando Trusted Publishing (OIDC con `id-token: write`) o el secret `NPM_TOKEN`.
