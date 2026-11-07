# Instala chaski como comando global y registra los hooks.
#
#   .\scripts\instalar-global.ps1
#
# Deja disponible `chaski init`, `chaski doctor` y `chaski uninstall` desde
# cualquier carpeta. Sin esto, los comandos se invocan como
# `node src/cli.mjs <comando>` desde la raíz del repositorio.
#
# `--install-links` copia el paquete en vez de enlazarlo: en Windows, crear un
# enlace simbólico exige privilegios de administrador y esto no.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Resolve-Path (Join-Path $PSScriptRoot '..'))
& npm.cmd install --global . --install-links --offline --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'No se pudo instalar chaski globalmente.' }
& node src/cli.mjs init
