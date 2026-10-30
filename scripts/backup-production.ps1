[CmdletBinding()]
param(
  [string]$ConfigDir = (Join-Path $env:APPDATA 'morriscode'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'morriscode'),
  [string]$BackupRoot = (Join-Path $env:USERPROFILE 'morriscode\backups'),
  [string]$TaskName = 'MorrisCode Server',
  [switch]$StopTask
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path $BackupRoot "pre-update-$stamp"
New-Item -ItemType Directory -Path $destination -Force | Out-Null

if ($StopTask) {
  & schtasks.exe /end /tn $TaskName | Out-Null
  Start-Sleep -Seconds 2
}

if (Test-Path -LiteralPath $ConfigDir) {
  Copy-Item -LiteralPath $ConfigDir -Destination (Join-Path $destination 'config') -Recurse -Force
}
if (Test-Path -LiteralPath $DataDir) {
  Copy-Item -LiteralPath $DataDir -Destination (Join-Path $destination 'data') -Recurse -Force
}
$taskXml = & schtasks.exe /query /tn $TaskName /xml 2>$null
if ($LASTEXITCODE -eq 0) { $taskXml | Out-File -LiteralPath (Join-Path $destination 'task.xml') -Encoding utf8 }

@{
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  configDir = $ConfigDir
  dataDir = $DataDir
  database = (Join-Path $DataDir 'sessions.db')
} | ConvertTo-Json | Out-File -LiteralPath (Join-Path $destination 'backup.json') -Encoding utf8

Write-Host "Backup written to $destination"
Write-Host 'Keep this directory outside the repository.'
