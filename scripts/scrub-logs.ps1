$ErrorActionPreference = 'SilentlyContinue'
# Derived from the current user's profile and this script's own location —
# this file previously hardcoded a specific Windows username and a specific
# machine's absolute repo path, neither of which belong in a shared template.
$repoRoot = Split-Path -Parent $PSScriptRoot

$paths = @(
  (Join-Path $env:USERPROFILE '.pm2\logs\kraken-out.log'),
  (Join-Path $env:USERPROFILE '.pm2\logs\kraken-error.log')
)

# Also scrub local log files written by kraken-boot.ps1
$localLogs = Get-ChildItem (Join-Path $repoRoot 'logs\kraken-*.log') -ErrorAction SilentlyContinue
foreach ($f in $localLogs) { $paths += $f.FullName }

function Scrub($text) {
  if ($null -eq $text) { return $text }

  # Common env-style leaks: KEY=VALUE
  $text = $text -replace '(?im)\b(DISCORD_TOKEN|CR_API_TOKEN|TOKEN|API_KEY|SECRET|KEY)\s*=\s*\S+', '$1=[REDACTED]'

  # JSON leaks: "token": "..."
  $text = $text -replace '(?im)"(discord_token|cr_api_token|token|api_key|secret|key)"\s*:\s*"[^"]+"', '"$1":"[REDACTED]"'

  # Header leaks: Authorization: Bearer ...
  $text = $text -replace '(?im)\bAuthorization\s*:\s*Bearer\s+\S+', 'Authorization: Bearer [REDACTED]'

  # Generic 'token: blah' patterns
  $text = $text -replace '(?im)\b(token|secret|api[_-]?key)\b\s*:\s*\S+', '$1: [REDACTED]'

  return $text
}

foreach ($p in $paths) {
  if (Test-Path $p) {
    $raw = Get-Content $p -Raw
    $clean = Scrub $raw
    if ($clean -ne $raw) {
      Set-Content $p -Value $clean -Encoding utf8
    }
  }
}
