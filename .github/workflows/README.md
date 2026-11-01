# Workflows

`test.yml` corre la suite en una matriz de tres sistemas operativos por tres
versiones de Node. La matriz no es por exceso: el proyecto se desarrolló solo
en Windows, y el envoltorio de hooks genera un `.sh` para Unix que nunca se
había ejecutado.

Incluye un paso que falla si `package.json` declara alguna dependencia. Cero
dependencias es un invariante del proyecto —la herramienta se ejecuta sola en
cada turno y un árbol de npm sería superficie de ataque— así que conviene que
lo verifique una máquina y no la buena memoria de quien revisa el PR.
