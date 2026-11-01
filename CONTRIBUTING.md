# Contribuir a chaski

Gracias por el interés. Esto es lo que hace falta saber antes de abrir un PR.

## Antes de escribir código

Lee [AGENTS.md](AGENTS.md). Tiene los siete invariantes del proyecto, los
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

Hasta que exista la suite de tests, el ciclo es este:

```bash
mkdir /tmp/prueba && cd /tmp/prueba && git init
echo "x" > a.js && git add -A && git commit -m inicial
echo "y" >> a.js

echo '{"cwd":"'$PWD'","hook_event_name":"Stop"}' | node ruta/a/chaski/src/capturar.mjs Stop "claude code"
cat .tambo/ramas/*/relevo.md

echo '{"cwd":"'$PWD'"}' | node ruta/a/chaski/src/leer.mjs
```

En Windows, usa rutas nativas: una ruta POSIX de Git Bash no resuelve cuando el
hook se ejecuta de verdad.

## Qué conviene aportar

- **Validación de los payloads de Codex y `agy`.** Es lo más útil ahora mismo.
  Si tienes esos CLIs, captura el JSON real que llega por stdin en cada evento y
  envíalo como fixture en `test/fixtures/`.
- **Formatos de credencial que el filtro no detecta.** Agregalos a
  `src/lib/secretos.mjs` con un caso de prueba.
- **Adaptadores para otros CLIs.** Un archivo en `src/lib/` más una entrada en
  el mapa `CLIS` de `src/instalar.mjs`.
- **Más casos en los tests.** Hay 91. Falta cubrir el adaptador de Codex y de
  `agy` con fixtures de más de una versión de cada CLI.

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

`main` siempre tiene que quedar instalable: es lo que la gente baja con
`npm install -g github:cristobalbn/chaski`. Así que nada entra directo.

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
npm test                            # 91 tests
```

Y prueba el cambio a mano según la sección de abajo.

El CI corre la suite en Linux, Windows y macOS por tres versiones de Node, y
falla si `package.json` declara alguna dependencia. Si tocas un adaptador,
agrega o ajusta su fixture en `test/fixtures/`.

`main` está protegida y exige pull request. No exige aprobación de otra
persona —sería absurdo en un proyecto de un solo mantenedor— pero sí obliga a
que todo pase por un PR, incluido el dueño del repo. El PR es el lugar donde
queda escrito **por qué** se hizo un cambio, y eso vale más que el commit.

## Pull requests

- Una cosa por PR.
- Describí qué problema resuelve, no solo qué cambia.
- Si tocaste `capturar.mjs`, mide la latencia antes y después y ponlo en la
  descripción.
- Si agregaste un comentario que explica el límite de una herramienta, que sea
  evidente por qué está: esos comentarios evitan que alguien reintroduzca el bug.
