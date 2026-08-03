$ErrorActionPreference = 'SilentlyContinue'
# Derived from this script's own location, matching kraken-restart.ps1's
# already-correct pattern — was previously a hardcoded absolute path that
# broke the moment this project was cloned or relocated.
$repoRoot = Split-Path -Parent $PSScriptRoot
# Disable the scheduled task first so Task Scheduler doesn't immediately restart the bot.
# Uses its own -ErrorAction Stop + try/catch (overriding the script-wide
# SilentlyContinue) so a failure here - e.g. the task was renamed, or this
# doesn't have permission - is surfaced instead of silently swallowed, which
# would otherwise let a future Task Scheduler-launched instance start back up
# with no indication this stop didn't fully take.
try {
  Disable-ScheduledTask -TaskName "KrakenBot" -ErrorAction Stop | Out-Null
} catch {
  Write-Warning "Failed to disable KrakenBot scheduled task: $($_.Exception.Message) - Task Scheduler could still relaunch the bot later."
}
# Signal kraken-boot.ps1's self-healing loop to exit instead of relaunching node -
# without this, killing node.exe below is just caught by that loop and undone
# ~10s later, silently leaving the bot running despite this script's output.
$null = New-Item -ItemType File -Force (Join-Path $repoRoot "logs\.stop-requested")
# Kill ONLY the bot's node process — a blanket "kill all node" also takes out the
# PM2 daemon, diagnostic scripts, and any other Node app on the machine.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Output "KrakenBot stopped. Auto-start is now disabled."
Write-Output ""
Write-Output 'To restart (recommended - includes health verification):'
Write-Output "  & $(Join-Path $PSScriptRoot 'kraken-restart.ps1')"
Write-Output ''
Write-Output 'Manual start (must re-enable task first):'
Write-Output "  Enable-ScheduledTask -TaskName 'KrakenBot'; Start-ScheduledTask -TaskName 'KrakenBot'"
Write-Output "  & $(Join-Path $PSScriptRoot 'kraken-verify.ps1')"