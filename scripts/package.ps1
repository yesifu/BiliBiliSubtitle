$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$archivePath = Join-Path $outputDirectory 'bili-whole-subtitles.zip'
$extensionFiles = @('manifest.json', 'popup.html', 'options.html', 'offscreen.html', 'src', 'styles', 'icons', 'README.md', 'PRIVACY.md', 'RESEARCH.md', 'VALIDATION.md') | ForEach-Object { Join-Path $projectRoot $_ }
Compress-Archive -LiteralPath $extensionFiles -DestinationPath $archivePath -Force
Write-Output "Packaged: $archivePath"
