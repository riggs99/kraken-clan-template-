# KRAKEN Bot — Startup & Process Management

## How it works

The bot runs as a background process managed by **Windows Task Scheduler**.
It starts automatically when you log into your PC and stops when the PC turns off.
If the bot crashes, Task Scheduler restarts it within 2 minutes.

There is no PM2. PM2 was removed because its named-pipe IPC (`//./pipe/rpc.sock`) returns
`EPERM` on this machine at the OS level and cannot be fixed.

---

## Task Scheduler task

- **Task name:** `KrakenBot`
- **Trigger:** At logon (your user account)
- **Action:** Runs `scripts/kraken-boot.ps1` hidden in the background
- **Restart on crash:** Every 2 minutes, up to 99 attempts
- **Execution time limit:** None (runs indefinitely)

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/kraken-boot.ps1` | Starts the bot; logs output to `logs/kraken-YYYY-MM-DD.log` |
| `scripts/kraken-stop.ps1` | Disables the task + kills the bot (prevents auto-restart) |
| `scripts/kraken-restart.ps1` | **Canonical restart** — stop, re-enable task, start, wait for `KRAKEN ONLINE` + heartbeat |
| `scripts/kraken-verify.ps1` | Health check — process/task running, log shows online + recent heartbeat |
| `scripts/install-git-hooks.ps1` | Installs pre-commit hook (blocks commits when bot is offline after runtime changes) |
| `scripts/scrub-logs.ps1` | Redacts tokens/secrets from log files |
| `scripts/season-reset.js` | Terminal script to roll a completed Clash Royale season into a new one — posts the outgoing season's report, keeps all history/records/roles intact (see below) |
| `scripts/full-clan-reset.js` | Terminal script for a full baseline reset — wipes war history, resets every member to probation (rare; see below) |

---

## Maintenance: season rollover (routine, ~monthly)

Rolls the season boundary when a Clash Royale season ends (seasons are
calendar-based, roughly monthly, starting the first Monday of each month — the
game does not expose this via the clan/war API, so this is always a manual,
leader-judged trigger, not something KRAKEN detects automatically; it does post
a reminder to the leader channel on the first Monday of each month as a nudge).

Two ways to trigger it — same underlying logic (`src/recruit/season-rollover.js`),
so they can't drift on behavior:

- **`/recruit-season-reset` in Discord** — for any leader, no computer/terminal
  access needed. Shows a preview with Confirm/Cancel buttons before doing anything.
  Use `/recruit-season-report` first if you just want to check standings without
  rolling anything.
- **`scripts/season-reset.js` from the terminal** — for whoever's comfortable
  running commands on the bot's machine. Supports `DRY_RUN=1` for a preview.

What it does:
- Posts the outgoing season's top-5 report (fame, wars played, donations) to the
  leader channel — the same content `/recruit-season-report` would show, generated
  fresh at the moment of rollover
- Backs up `data/history.json`, then stamps a new `seasonStart` date and appends the
  outgoing season's start/end dates to `history.seasons`
- Does **NOT** wipe `history.json`, touch member profiles, change any Discord role,
  or clear any discipline/break state — full history keeps accumulating indefinitely
  so lifetime records (Hall of Fame donor/war/attendance streaks, `/status`'s
  cross-week history) keep working across season boundaries. Only the season-scoped
  totals `rankSeason` reports (used by `/recruit-season-report` and this script) reset,
  by starting to count from the new `seasonStart` instead of the beginning of history.

**Stop the bot first** so nothing else writes to `history.json` while this runs, then restart after.

```powershell
& C:/path/to/kraken-clan-template\scripts\kraken-stop.ps1

# Preview first (no changes made):
$env:DRY_RUN = '1'; node scripts/season-reset.js; $env:DRY_RUN = $null

# Apply for real:
node scripts/season-reset.js

Enable-ScheduledTask -TaskName KrakenBot
& C:/path/to/kraken-clan-template\scripts\kraken-restart.ps1
```

---

## Maintenance: full clan reset (rare)

`scripts/full-clan-reset.js` is the old `season-reset.js` behavior, renamed to match
what it actually does — a full baseline reset, not a routine season transition. Use
this only for a genuine "start completely over" moment (e.g. the 2026-07-09 full
reset), where you want every member back on probation and war history wiped clean.
It is intentionally a terminal script, **not** a Discord command, so a leader can't
trigger it by accident.

What it does:
- Sets every active profile to `probation` in the DB and clears their score/verdict/probation timers
- Removes warcore / underwatch / on-break / remove roles and adds `probation` for each linked member still in the server
- Wipes the `breaks`, `underwatch_state`, `probation_state`, and `post_break_enforcement` tables
- Clears stale eval settings (rate-limit stamps, message history) while **preserving** channel/role config and panel message IDs
- Archives `data/history.json` to `history.archive-YYYY-MM-DD.json` and writes a fresh empty history with a `trackingEpoch` date so the existing roster is not held in new-joiner grace when war starts

**Always stop the bot first** so the evaluator can't run mid-reset, then restart after.

```powershell
& C:/path/to/kraken-clan-template\scripts\kraken-stop.ps1

# Preview first (no changes made):
$env:DRY_RUN = '1'; node scripts/full-clan-reset.js; $env:DRY_RUN = $null

# Apply for real:
node scripts/full-clan-reset.js

Enable-ScheduledTask -TaskName KrakenBot
& C:/path/to/kraken-clan-template\scripts\kraken-restart.ps1
```

Guild ID is read from `config/recruit.config.json`; tokens come from `.env`.

---

## Day-to-day commands

**Restart the bot** (use this after code changes — verifies health before finishing):
```powershell
& C:/path/to/kraken-clan-template\scripts\kraken-restart.ps1
```

**Verify the bot is healthy** (online + heartbeat in today's log):
```powershell
& C:/path/to/kraken-clan-template\scripts\kraken-verify.ps1
```

**Start the bot now** (without a full stop/restart cycle):
```powershell
Enable-ScheduledTask -TaskName KrakenBot
Start-ScheduledTask -TaskName KrakenBot
& C:/path/to/kraken-clan-template\scripts\kraken-verify.ps1
```

> **Important:** `kraken-stop.ps1` **disables** the scheduled task. `Start-ScheduledTask` alone after a stop will not work until you run `Enable-ScheduledTask -TaskName KrakenBot` first. Prefer `kraken-restart.ps1` to avoid leaving the task stuck in `Ready`.

**Stop the bot** (and prevent auto-restart):
```powershell
& C:/path/to/kraken-clan-template\scripts\kraken-stop.ps1
```

**Watch live logs:**
```powershell
Get-Content "C:/path/to/kraken-clan-template\logs\kraken-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait
```

**Check if the bot is running:**
```powershell
Get-ScheduledTask -TaskName KrakenBot | Select-Object TaskName, State
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]index\.js' } |
  Select-Object ProcessId, CreationDate
& C:/path/to/kraken-clan-template\scripts\kraken-verify.ps1
```

---

## Pre-commit bot health gate

After runtime changes (`src/`, kraken scripts, `package.json`), **do not commit** unless the bot passes `kraken-verify.ps1`.

Install the git hook once per clone (enforces this automatically):
```powershell
& C:/path/to/kraken-clan-template\scripts\install-git-hooks.ps1
```

Agents and operators: restart with `kraken-restart.ps1`, then verify, **then** commit.

---

## Logs

Daily log files are written to `C:/path/to/kraken-clan-template\logs\kraken-YYYY-MM-DD.log`.
Each file appends a `=== Bot started ... ===` header on every (re)start.
Run `scrub-logs.ps1` to redact any sensitive values before sharing logs.

---

## Resource usage

| | Old (PM2) | Current (Task Scheduler) |
|---|---|---|
| Node processes | 2 (PM2 daemon + bot) | 1 (bot only) |
| Background overhead | PM2 daemon ~50–80 MB RAM | None (Task Scheduler is a built-in Windows service) |

---

## Re-registering the task from scratch

If the task is ever deleted or corrupted, run this in PowerShell to recreate it:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"C:/path/to/kraken-clan-template\scripts\kraken-boot.ps1`"" `
  -WorkingDirectory "C:/path/to/kraken-clan-template"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -RestartCount 99 `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "KrakenBot" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Force
```

---

## Why not PM2

PM2 was the original process manager (`ecosystem.config.cjs` is still in the repo).
It was abandoned because `pm2` commands fail with:

```
Error: connect EPERM //./pipe/rpc.sock
```

This is a Windows OS-level restriction on the named pipe PM2 uses for IPC.
Wiping `~/.pm2` does not fix it. The Task Scheduler approach is equivalent in behaviour
and uses fewer resources.
