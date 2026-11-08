# Abre un CLI de IA en la raíz de este repositorio, sin importar desde dónde se
# invoque. Atajo de conveniencia: chaski no lo necesita para funcionar.
#
#   .\scripts\abrir-agente.ps1            # codex
#   .\scripts\abrir-agente.ps1 claude
#
# La ruta se resuelve contra la ubicación del script y no contra el directorio
# actual: así sigue funcionando desde cualquier parte.
param(
  [ValidateSet('codex', 'claude', 'agy')][string]$Agente = 'codex',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Argumentos
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Resolve-Path (Join-Path $PSScriptRoot '..'))
& $Agente @Argumentos
