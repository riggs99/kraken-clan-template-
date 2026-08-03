# Clean restart: stop (disable task + kill bot node), re-enable task, start, verify
# KRAKEN ONLINE + heartbeat before returning success.
param(
  [int]$VerifyTimeoutSec = 180,
  [int]$VerifyIntervalSec = 5
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
function Get-TodayLogPath { Join-Path $repoRoot "logs\kraken-$(Get-Date -Format 'yyyy-MM-dd').log" }
$verifyScript = Join-Path $PSScriptRoot 'kraken-verify.ps1'
$stopScript = Join-Path $PSScriptRoot 'kraken-stop.ps1'

Write-Host '=== KRAKEN restart ===' -ForegroundColor Cyan

# Captured against whichever file is "today's" log AT THIS MOMENT. kraken-boot.ps1
# (the actual launcher) recomputes its own log path fresh every loop iteration from
# the current date, so a restart that spans local midnight can have the new bot
# instance write "Bot started" into TOMORROW's log file while this script keeps
# polling today's - $logPathBefore lets the loop below detect that and reset its
# baseline instead of watching a file nothing will ever write to again.
$logPathBefore = Get-TodayLogPath
$linesBefore = 0
if (Test-Path $logPathBefore) {
  $linesBefore = @(Get-Content -Path $logPathBefore -ErrorAction SilentlyContinue).Count
}

& $stopScript
Start-Sleep -Seconds 2

# kraken-stop disables the task — must re-enable before Start-ScheduledTask works.
Enable-ScheduledTask -TaskName 'KrakenBot' | Out-Null
Start-ScheduledTask -TaskName 'KrakenBot'

Write-Host "Waiting for KRAKEN ONLINE + heartbeat (timeout ${VerifyTimeoutSec}s)..." -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
$passed = $false
$logPath = $logPathBefore
while ((Get-Date) -lt $deadline) {
  $logPath = Get-TodayLogPath
  $effectiveLinesBefore = if ($logPath -eq $logPathBefore) { $linesBefore } else { 0 }

  $allLines = @(Get-Content -Path $logPath -ErrorAction SilentlyContinue)

  # Find the most recent "Bot started" line's position in the FULL file and confirm
  # it's at or after where the file used to end BEFORE this restart - a reliable,
  # position-based way to detect a genuinely new startup. The old approach compared
  # the tail's last line's raw TEXT against a captured "before" line, which breaks
  # the moment the newest line happens to be a repeating, non-unique message like
  # the heartbeat line: once the new instance's own heartbeat became the tail's last
  # line, it coincidentally string-matched the stale pre-restart marker (also a
  # heartbeat line) and silently closed the gate for the rest of the run, on every
  # restart, right around the point it should have started succeeding.
  #
  # Re-scanned every iteration on purpose - an earlier version tried to cache this
  # (it can't move once it's truly the NEWEST "Bot started" line), but that broke
  # in practice: an early poll can find and cache an OLD "Bot started" line still
  # sitting in the tail (written before this restart began, since the new one
  # hasn't been logged yet), and because a match was "found," the cache never
  # re-checked for the actual new one once it appeared later in the same file -
  # confirmed live, this silently failed every restart. The scan itself is a cheap
  # in-memory backward loop; re-running it is not the expensive part here.
  $startIdx = -1
  for ($i = $allLines.Count - 1; $i -ge 0; $i--) {
    if ($allLines[$i] -match '^=== Bot started ') { $startIdx = $i; break }
  }
  $newStartup = ($startIdx -ge 0) -and ($startIdx -ge $effectiveLinesBefore)

  if ($newStartup) {
    $sinceStart = $allLines[$startIdx..($allLines.Count - 1)] -join "`n"
    if (($sinceStart -match 'KRAKEN ONLINE') -and ($sinceStart -match '\[SCHEDULE\] Kraken heartbeat OK')) {
      & $verifyScript -HeartbeatMaxAgeSec 120 -Quiet
      if ($LASTEXITCODE -eq 0) {
        $passed = $true
        break
      }
    }
  }

  Start-Sleep -Seconds $VerifyIntervalSec
}

if (-not $passed) {
  Write-Host '[FAIL] Restart did not reach online + heartbeat in time.' -ForegroundColor Red
  Write-Host "  Get-Content `"$logPath`" -Tail 20" -ForegroundColor Yellow
  Write-Host "  & $(Join-Path $PSScriptRoot 'kraken-verify.ps1')" -ForegroundColor Yellow
  exit 1
}

& $verifyScript -HeartbeatMaxAgeSec 120
exit $LASTEXITCODE
