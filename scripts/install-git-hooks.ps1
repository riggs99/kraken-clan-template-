# Installs repo git hooks (pre-commit bot health check). Run once per clone.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$hooksDir = Join-Path $repoRoot '.git\hooks'
$hookPath = Join-Path $hooksDir 'pre-commit'

if (-not (Test-Path (Join-Path $repoRoot '.git'))) {
  Write-Error 'Not a git repository — run from the KRAKEN repo root.'
}

$hookContent = @'
#!/bin/sh
# KRAKEN pre-commit: block commits when runtime code changes and bot is offline.
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/dev2/kraken/scripts/kraken-verify.ps1" -PreCommit
'@

# Use forward slashes in hook — git on Windows resolves them fine.
$hookContent = $hookContent -replace 'C:/dev2/kraken', ($repoRoot -replace '\\', '/')

New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
Set-Content -Path $hookPath -Value $hookContent -Encoding ASCII -NoNewline
Write-Host "Installed pre-commit hook: $hookPath" -ForegroundColor Green
Write-Host 'Commits that touch src/ or kraken scripts require a healthy bot (online + heartbeat).' -ForegroundColor Cyan
