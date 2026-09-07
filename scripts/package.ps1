$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& node (Join-Path $projectRoot 'scripts/package.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Extension packaging failed.' }
