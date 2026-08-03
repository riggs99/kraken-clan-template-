# KRAKEN — Dev Guide

Private Discord bot for Clash Royale clan intel.

## Tech
- Node.js v20+
- Windows + PowerShell
- discord.js v14 (ESM)
- dotenv
- node-fetch
- Clash Royale API via: https://proxy.royaleapi.dev

## Project Layout
- C:/path/to/kraken-clan-template\
  - src\
    - index.js            (entry point, event wiring for both guilds)
    - ops.js               (main clan /ops command panel)
    - permissions.js, cr-api.js, circuit-breaker.js, cooldown.js, audit.js
    - schedule.js          (daily/weekly clan reports)
    - war-scheduler.js     (disabled no-op)
    - recruit\             (Recruit HQ subsystem — see src/recruit/AGENTS.md)
  - config\
    - ops.config.json, recruit.config.json  (per-guild IDs; PUT_* placeholders must be filled)
  - data\
    - history.json         (daily clan snapshots), history.archive-*.json, kraken.db (SQLite)
  - docs\
    - commands.md           (current command/feature reference — start here)
    - bot-startup.md        (process management: Task Scheduler, season reset)
  - scripts\
    - deploy-commands.js, kraken-boot.ps1, kraken-stop.ps1, season-reset.js, full-clan-reset.js
  - .env (NOT COMMITTED)
  - AGENTS.md, DEV.md, COMMANDS.md (legacy, see AGENTS.md note)

## Secrets Policy (Non-Negotiable)
- DO NOT hardcode tokens or IDs in code.
- Secrets live in .env only.
- .env must be in .gitignore.
- Share code using .env.example (never share real .env).

## Required Environment Variables (.env)
Discord:
- DISCORD_TOKEN=
- DISCORD_APP_ID=
- DISCORD_GUILD_ID=
- LEADER_CHANNEL_ID=        (the channel ID for #kraken output / scheduler posts)
Access control:
- ALLOWED_ROLE_IDS=         (comma-separated role IDs; the “kraken” role)
Clash Royale:
- CR_API_TOKEN=
- CR_API_BASE=https://proxy.royaleapi.dev
Clan:
- CLAN_TAG=                 (WITHOUT #)

Optional circuit breaker tuning:
- CR_BREAKER_WINDOW_MS=60000
- CR_BREAKER_THRESHOLD=5
- CR_BREAKER_OPEN_MS=600000

## Install
From project root:
- C:/path/to/kraken-clan-template

PowerShell:
- npm install

## Deploy Slash Commands (Guild scoped)
PowerShell:
- node C:/path/to/kraken-clan-template\scripts\deploy-commands.js

Expected:
- ✅ Commands deployed

## Run Bot
PowerShell:
- node C:/path/to/kraken-clan-template\src\index.js

Expected:
- 🐙 KRAKEN ONLINE as <bot#tag>

## Runtime Security Model
All commands require:
1) Correct Discord Guild (DISCORD_GUILD_ID)
2) Correct Channel (LEADER_CHANNEL_ID)
3) User has an allowed role from ALLOWED_ROLE_IDS

Default is deny (fail-closed).

## API Safety
KRAKEN uses:
- In-memory caching (clan/player/race data)
- Per-user command cooldowns
- Circuit breaker (opens after repeated failures and pauses CR requests)
- Degraded mode warning if failures approach threshold

This keeps API usage polite and prevents spam or accidental abuse.

## Troubleshooting

### Deploy fails: Missing Access (403)
Cause: bot invited without pplications.commands scope.
Fix:
- Re-invite bot with scopes: bot + applications.commands
- Then re-run deploy script.

### Bot fails: Missing DISCORD_TOKEN
Cause: .env not loaded or wrong path.
Fix:
- Confirm `.env` exists in the project root (same folder as `package.json`).
- If you keep your `.env` elsewhere, set `DOTENV_PATH` to point to it (Kraken loads env via `src/env.js`).

### ERR_MODULE_NOT_FOUND
Cause: missing file on disk or wrong import name.
Fix:
- Confirm file exists in C:/path/to/kraken-clan-template\src\
- Confirm import uses correct filename (case-sensitive in ESM environments).

### CR API failures / breaker open
Symptoms:
- Commands reply with CR cooldown messaging.
Fix:
- Run /status to see breaker remaining time and last error.
- Wait for breaker to close or tune breaker env vars.

## Recommended Local Test Flow
1) Deploy commands:
   - node scripts\deploy-commands.js
2) Start bot:
   - node src\index.js
3) In the main clan server, test `/ops` — opens the Overview/War/Donations/Actions panel.
4) If Recruit HQ is enabled, test recruit commands there — see [docs/commands.md](docs/commands.md) for the full list (`/apply`, `/status`, `/recruit-eval-now`, `/war-board`, etc.)

For production start/stop (Windows Task Scheduler, not `node src\index.js` directly), see [docs/bot-startup.md](docs/bot-startup.md).

## Notes for Future Public Release (Later)
When ready to release beyond a single clan:
- Move clan tag + role + channel into per-guild config (setup command)
- Keep only global secrets in .env (DISCORD_TOKEN, CR_API_TOKEN, CR_API_BASE)
- Add a setup + admin permission model

(Do not do this until private testing is stable.)
