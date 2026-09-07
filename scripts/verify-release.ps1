param([Parameter(Mandatory = $true)][string]$Tag)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if ($Tag -notmatch '^v\d+\.\d+\.\d+$' -or $Tag -cne "v$($manifest.version)" -or $manifest.version -cne $package.version) {
    throw 'Release tag, manifest.json and package.json versions must match (vX.Y.Z).'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $projectRoot 'dist/bili-whole-subtitles.zip'
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($required in @('manifest.json', 'popup.html', 'options.html', 'offscreen.html', 'src/background.js', 'src/offscreen.js', 'src/vendor/mp4box.all.mjs', 'src/vendor/LICENSE')) {
        if ($names -cnotcontains $required) { throw "Missing release file: $required" }
    }
    if ($names | Where-Object { $_ -match '(^|/)(\.git|\.github|\.research|\.browser-test|node_modules|tests|dist)(/|$)' }) {
        throw 'The installation archive contains development or local data.'
    }
    $reader = [System.IO.StreamReader]::new($archive.GetEntry('manifest.json').Open())
    try { $packedManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($packedManifest.version -cne $manifest.version) { throw 'The ZIP has a stale manifest version.' }
} finally { $archive.Dispose() }

$sha = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$archivePath.sha256"
[System.IO.File]::WriteAllText($checksumPath, "$sha  bili-whole-subtitles.zip`n", [System.Text.Encoding]::ASCII)
Write-Output "Verified $Tag ($($names.Count) entries): $sha"
