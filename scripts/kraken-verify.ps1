# Verifies KRAKEN is running and healthy by checking the live process/task and
# today's log for KRAKEN ONLINE plus a recent heartbeat.
param(
  [int]$HeartbeatMaxAgeSec = 120,
  [switch]$PreCommit,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $repoRoot "logs\kraken-$(Get-Date -Format 'yyyy-MM-dd').log"

function Write-Check($ok, $msg) {
  if ($Quiet -and $ok) { return }
  if ($ok) { Write-Host "[OK] $msg" -ForegroundColor Green }
  else { Write-Host "[FAIL] $msg" -ForegroundColor Red }
}

function Test-BotProcess() {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.js' }
  return @($procs).Count -gt 0
}

function Test-TaskRunning() {
  $task = Get-ScheduledTask -TaskName 'KrakenBot' -ErrorAction SilentlyContinue
  if (-not $task) { return $false }
  return $task.State -eq 'Running'
}

if ($PreCommit) {
  $staged = git -C $repoRoot diff --cached --name-only 2>$null
  if (-not $staged) { exit 0 }
  $touchesRuntime = $false
  foreach ($f in $staged) {
    if ($f -match '^(src/|scripts/kraken-|package\.json|package-lock\.json)') {
      $touchesRuntime = $true
      break
    }
  }
  if (-not $touchesRuntime) { exit 0 }
  if (-not $Quiet) {
    Write-Host 'Pre-commit: staged changes touch runtime — verifying bot health...' -ForegroundColor Cyan
  }
}

if (-not (Test-Path $logPath)) {
  Write-Check $false "Log file missing: $logPath"
  exit 1
}

$allLines = @(Get-Content -Path $logPath -ErrorAction SilentlyContinue)
if ($allLines.Count -eq 0) {
  Write-Check $false "Log file is empty: $logPath"
  exit 1
}

# Find the most recent start/exit marker by scanning the WHOLE file, not a fixed
# tail window - with a heartbeat logged once a minute, a small tail (e.g. the last
# 40 lines) rolls the one-time "Bot started"/"KRAKEN ONLINE" lines out of view
# after as little as ~40 minutes of healthy uptime, which used to make this script
# report a perfectly fine, long-running bot as unhealthy. This also detects
# whether kraken-boot.ps1's self-healing loop is currently sitting in a crash-loop
# backoff window (node.exe intentionally not running while it waits to retry) -
# without it, the wrapper process (Test-TaskRunning) staying alive, plus stale
# ONLINE/heartbeat lines from the PRIOR run, both read as "healthy" during that
# window, hiding a genuine outage from this exact check.
$markerIdx = -1
for ($i = $allLines.Count - 1; $i -ge 0; $i--) {
  if ($allLines[$i] -match '^=== Bot (started|exited) ') { $markerIdx = $i; break }
}
$inBackoff = ($markerIdx -ge 0) -and ($allLines[$markerIdx] -match 'restarting in \d+s')

$processOk = Test-BotProcess
$taskOk = Test-TaskRunning
$processCheckOk = ($processOk -or $taskOk) -and -not $inBackoff
if ($inBackoff) {
  Write-Check $false "Bot process running (currently in crash-loop backoff: $($allLines[$markerIdx]))"
} else {
  Write-Check $processCheckOk "Bot process or KrakenBot task running (process=$processOk task=$taskOk)"
}

# Scoped to lines since the most recent start/exit marker, unbounded by any fixed
# line count, so neither a long healthy run nor a stale line from a previous,
# now-dead run can produce a wrong result in either direction.
$sinceMarker = if ($markerIdx -ge 0) { $allLines[$markerIdx..($allLines.Count - 1)] } else { $allLines }
$sinceMarkerText = $sinceMarker -join "`n"

$onlineOk = $sinceMarkerText -match 'KRAKEN ONLINE'
Write-Check $onlineOk 'Most recent startup reached KRAKEN ONLINE'

$heartbeatLines = @($sinceMarker | Where-Object { $_ -match '\[SCHEDULE\] Kraken heartbeat OK' })
$heartbeatOk = $heartbeatLines.Count -gt 0
Write-Check $heartbeatOk 'Log contains at least one heartbeat since the most recent startup'

$logAgeSec = ((Get-Date) - (Get-Item $logPath).LastWriteTime).TotalSeconds
$recentLogOk = $logAgeSec -le $HeartbeatMaxAgeSec
Write-Check $recentLogOk "Log updated within ${HeartbeatMaxAgeSec}s (last write $([int]$logAgeSec)s ago)"

if (-not $processCheckOk -or -not $onlineOk -or -not $heartbeatOk -or -not $recentLogOk) {
  if (-not $Quiet) {
    Write-Host ''
    Write-Host 'Bot health check failed. Restart and verify before committing:' -ForegroundColor Yellow
    Write-Host "  & $(Join-Path $PSScriptRoot 'kraken-restart.ps1')" -ForegroundColor Yellow
  }
  exit 1
}

if (-not $Quiet) {
  Write-Host 'Bot health check passed.' -ForegroundColor Green
}
exit 0
