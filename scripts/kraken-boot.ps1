$ErrorActionPreference = 'SilentlyContinue'
# Derived from this script's own location, not hardcoded — this used to pin a
# specific machine's absolute path, which meant the script silently pointed at
# the WRONG folder (or none at all) the moment this project was cloned or
# relocated anywhere else. kraken-restart.ps1/kraken-verify.ps1 already used
# this pattern; kraken-boot.ps1 and kraken-stop.ps1 just never got it.
$repoRoot = Split-Path -Parent $PSScriptRoot
$null = New-Item -ItemType Directory -Force (Join-Path $repoRoot "logs")

# Signalled by kraken-stop.ps1 to make this loop exit instead of relaunching node.
# Without this, killing node.exe alone (kraken-stop.ps1's old behavior) would just
# be caught by the loop below and relaunched ~10s later, silently undoing the stop
# - a real risk given docs/bot-startup.md's "always stop the bot first" step before
# season-reset.js mutates production history.json/kraken.db.
$stopFlag = Join-Path $repoRoot "logs\.stop-requested"
if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force }

# Self-healing: restart node from inside this script on ANY exit (crash, kill,
# clean exit), instead of relying on the KrakenBot task's own RestartCount /
# RestartInterval settings. Confirmed live those aren't reliable here - the task
# died silently multiple times (no error, no crash log) and simply never
# restarted until the next Windows logon, once leaving the bot down for over
# 24 hours. Task Scheduler's restart settings are still configured as a secondary
# safety net for the one case this loop can't cover (the wrapper process itself
# being killed), but that's the same mechanism already observed to be unreliable,
# so don't treat it as guaranteed - a killed wrapper may still need a manual
# restart via kraken-restart.ps1.
#
# Consecutive-fast-failure backoff: a run that exits within $fastFailThresholdSec
# counts as a fast failure (crash-on-startup, not a real outage after a healthy
# run). Backoff escalates through $backoffStepsSec per consecutive fast failure
# and resets the moment a run survives past the threshold. Without this, a
# permanently broken deploy (bad token, syntax error) retries every 10s forever -
# hundreds of fresh Discord Gateway IDENTIFY attempts within a few hours, risking
# Discord's own per-token daily IDENTIFY limit and turning a recoverable bad
# deploy into the exact extended outage this fix exists to end.
$fastFailThresholdSec = 30
$backoffStepsSec = @(10, 30, 60, 120, 300)
$consecutiveFastFailures = 0

:mainLoop while ($true) {
  # Re-run every iteration (not hoisted before the loop) so a one-time transient
  # failure here can't permanently wedge every future restart on the wrong cwd.
  Set-Location $repoRoot

  # Prune log files older than 30 days, matching src/backup.js's retention window.
  Get-ChildItem -Path (Join-Path $repoRoot "logs") -Filter "kraken-*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $log = Join-Path $repoRoot "logs\kraken-$(Get-Date -Format 'yyyy-MM-dd').log"

  # Check for a stop request BEFORE (re)launching node — without this, a stop
  # requested while this loop was asleep in its backoff window (no node.exe
  # running for kraken-stop.ps1 to kill) was silently swallowed and node got
  # relaunched anyway once the sleep finished, despite kraken-stop.ps1 having
  # already reported "KrakenBot stopped."
  if (Test-Path $stopFlag) {
    Remove-Item $stopFlag -Force
    Add-Content -Path $log -Value "=== Stop requested $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') before launch - wrapper exiting ===" -Encoding utf8
    break
  }

  Add-Content -Path $log -Value "=== Bot started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -Encoding utf8

  $runStart = Get-Date
  cmd /c "node src\index.js >> `"$log`" 2>&1"
  $runSeconds = [int]((Get-Date) - $runStart).TotalSeconds

  if (Test-Path $stopFlag) {
    Remove-Item $stopFlag -Force
    Add-Content -Path $log -Value "=== Bot exited $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exit code $LASTEXITCODE, ran ${runSeconds}s) - stop requested, wrapper exiting ===" -Encoding utf8
    break
  }

  if ($runSeconds -lt $fastFailThresholdSec) {
    $consecutiveFastFailures++
  } else {
    $consecutiveFastFailures = 0
  }
  # consecutiveFastFailures is already incremented above (0 -> 1 on the first fast
  # failure), so indexing backoffStepsSec directly by that count skips index 0
  # (10s) entirely - the 1st consecutive fast failure would jump straight to 30s.
  # Subtract 1 to map the Nth consecutive fast failure to backoffStepsSec[N-1].
  if ($consecutiveFastFailures -gt 0) {
    $stepIndex = [Math]::Min($consecutiveFastFailures - 1, $backoffStepsSec.Count - 1)
  } else {
    $stepIndex = 0
  }
  $delaySec = $backoffStepsSec[$stepIndex]

  Add-Content -Path $log -Value "=== Bot exited $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exit code $LASTEXITCODE, ran ${runSeconds}s, consecutive fast failures: $consecutiveFastFailures) - restarting in ${delaySec}s ===" -Encoding utf8

  # Sleep in 1s increments (instead of one Start-Sleep for the whole delay) so a
  # stop request made mid-backoff takes effect within ~1s instead of only being
  # checked once the full delay (up to 300s) has already elapsed.
  $slept = 0
  while ($slept -lt $delaySec) {
    if (Test-Path $stopFlag) {
      Remove-Item $stopFlag -Force
      Add-Content -Path $log -Value "=== Stop requested $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') during backoff - wrapper exiting ===" -Encoding utf8
      break mainLoop
    }
    Start-Sleep -Seconds 1
    $slept++
  }
}
