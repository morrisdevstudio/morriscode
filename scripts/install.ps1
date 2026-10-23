[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'MorrisCode'),
  [string]$BundlePath,
  [string]$ManifestPath,
  [string]$SignaturePath,
  [string]$PublicKeyPath,
  [string]$TaskName = 'MorrisCode',
  [string]$Arguments = '--port 10369 --host 127.0.0.1 --no-https --no-browser',
  [int]$HealthPort = 10369,
  [switch]$NoAutoUpdate,
  [switch]$NoTask,
  [switch]$ExistingTask,
  [switch]$Start,
  [string]$PreviousVersion,
  [string]$PreviousDir
)

$ErrorActionPreference = 'Stop'
$ReleaseRepository = 'morrisdevstudio/morriscode-releases'

function Write-Utf8([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Download-File([string]$Url, [string]$Destination) {
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -Headers @{ 'User-Agent' = 'MorrisCode-Installer' }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 24 or newer is required. Install it from https://nodejs.org and run this installer again.' }
$nodeMajor = [int](((& $node -v) -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required (found $(& $node -v))." }

$temp = Join-Path ([IO.Path]::GetTempPath()) ('morriscode-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
  if ($BundlePath) {
    if (-not $ManifestPath -or -not $SignaturePath -or -not $PublicKeyPath) {
      throw 'A local install needs -ManifestPath, -SignaturePath and -PublicKeyPath.'
    }
    $asset = (Resolve-Path -LiteralPath $BundlePath).Path
    $manifest = (Resolve-Path -LiteralPath $ManifestPath).Path
    $signature = (Resolve-Path -LiteralPath $SignaturePath).Path
    $publicKey = (Resolve-Path -LiteralPath $PublicKeyPath).Path
    $verifyScript = Join-Path $PSScriptRoot 'release\verify-release.mjs'
    $launcherSource = Join-Path $PSScriptRoot 'launcher.mjs'
  } else {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$ReleaseRepository/releases/latest" -Headers @{ 'User-Agent' = 'MorrisCode-Installer'; 'Accept' = 'application/vnd.github+json' }
    $version = $release.tag_name.TrimStart('v')
    $wanted = @('manifest.json', 'manifest.json.sig', 'release-public-key.pem', 'launcher.mjs', 'verify-release.mjs', "morriscode-$version-win32-x64.zip")
    foreach ($name in $wanted) {
      $candidate = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
      if (-not $candidate) { throw "Release asset missing: $name" }
      Download-File $candidate.browser_download_url (Join-Path $temp $name)
    }
    $asset = Join-Path $temp "morriscode-$version-win32-x64.zip"
    $manifest = Join-Path $temp 'manifest.json'
    $signature = Join-Path $temp 'manifest.json.sig'
    $publicKey = Join-Path $temp 'release-public-key.pem'
    $verifyScript = Join-Path $temp 'verify-release.mjs'
    $launcherSource = Join-Path $temp 'launcher.mjs'
  }

  $verified = & $node $verifyScript --manifest $manifest --signature $signature --public-key $publicKey --platform win32 --arch x64 --asset $asset
  if ($LASTEXITCODE -ne 0) { throw 'The release signature or checksum could not be verified.' }
  $metadata = ($verified -join "`n") | ConvertFrom-Json
  $version = $metadata.version

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($asset)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName -replace '\\', '/'
      if ($name -eq '' -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name -match '(^|/)\.\.(/|$)') {
        throw "Unsafe archive entry: $name"
      }
      $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixMode -eq 0xA000) { throw "Archive symlink rejected: $name" }
    }
  } finally {
    $archive.Dispose()
  }

  New-Item -ItemType Directory -Path (Join-Path $Root 'releases') -Force | Out-Null
  $releaseDir = Join-Path $Root (Join-Path 'releases' $version)
  if (Test-Path -LiteralPath $releaseDir) { Remove-Item -LiteralPath $releaseDir -Recurse -Force }
  Expand-Archive -LiteralPath $asset -DestinationPath $releaseDir -Force
  if (-not (Test-Path -LiteralPath (Join-Path $releaseDir 'dist\cli\index.js'))) {
    throw 'The extracted release has no CLI entry point.'
  }

  Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $Root 'launcher.mjs') -Force
  $launcherConfig = [ordered]@{
    args = @($Arguments -split '\s+' | Where-Object { $_ })
    cwd = $Root
    healthPort = $HealthPort
    healthScheme = 'http'
    autoUpdate = (-not $NoAutoUpdate)
  }
  Write-Utf8 (Join-Path $Root 'launcher.json') ($launcherConfig | ConvertTo-Json -Depth 5)

  $currentPath = Join-Path $Root 'current.json'
  $previous = $null
  if (Test-Path -LiteralPath $currentPath) {
    $existing = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
    $previous = [ordered]@{ version = $existing.version; dir = $existing.dir }
  }
  $current = [ordered]@{
    schemaVersion = 1
    version = $version
    dir = "releases/$version"
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  if ($PreviousVersion -and $PreviousDir) {
    $previous = [ordered]@{ version = $PreviousVersion; dir = $PreviousDir }
  }
  if ($previous) { $current.previous = $previous }
  Write-Utf8 $currentPath ($current | ConvertTo-Json -Depth 5)

  if (-not $NoTask) {
    $taskCommand = '"' + $node + '" "' + (Join-Path $Root 'launcher.mjs') + '"'
    if ($ExistingTask) {
      $backup = Join-Path $Root ('task-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
      & schtasks.exe /query /tn $TaskName /xml | Out-File -LiteralPath $backup -Encoding utf8
      & schtasks.exe /change /tn $TaskName /tr $taskCommand | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Could not update task $TaskName. Stop it first or run this from an elevated prompt." }
    } else {
      & schtasks.exe /create /tn $TaskName /sc ONLOGON /tr $taskCommand /rl LIMITED /f | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Could not create task $TaskName." }
    }
  }

  Write-Host "MorrisCode $version installed in $releaseDir"
  Write-Host "Configuration and history were not modified: $env:APPDATA\morriscode and $env:LOCALAPPDATA\morriscode"
  if (-not $NoTask) { Write-Host "Startup task: $TaskName" }
  if ($Start) { & schtasks.exe /run /tn $TaskName }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
