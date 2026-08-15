# KRAKEN — Dev Guide

Private Discord bot for Clash Royale clan intel.

## Tech
- Node.js v20+ (Windows, macOS, or Linux)
- discord.js v14 (ESM)
- better-sqlite3
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
    - deploy-commands.js, setup-check.js (pre-flight verifier), kraken-boot.ps1, kraken-stop.ps1, season-reset.js, full-clan-reset.js
  - .env (NOT COMMITTED)
  - SETUP.md (first-time setup), DEPLOYMENT.md (production/ops), AGENTS.md, DEV.md
  - COMMANDS.md (intentionally legacy — points to docs/commands.md)

## Secrets Policy (Non-Negotiable)
- DO NOT hardcode tokens or IDs in code.
- Secrets live in .env only.
- .env must be in .gitignore.
- Share code using .env.example (never share real .env).

## Environment Variables (.env)
Every variable the bot reads is documented inline in `.env.example`, with its
default and what it controls — that's the single source of truth, not a copy
here that can drift out of sync. Required at minimum: `DISCORD_TOKEN`,
`DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `CR_API_BASE`, `CR_API_TOKEN`,
`CLAN_TAG`. Notably: `KRAKEN_DB_PATH` — leave it unset (the default) unless
you have a specific reason to change it. An *empty string* value (rather
than truly unset) used to silently make the database temporary and wiped on
every restart — fixed, but worth knowing why that variable matters.

## Install
From project root:
- npm install

## Deploy Slash Commands (Guild scoped)
- npm run deploy

Expected:
- ✅ Commands deployed

## Run Bot
- npm start

Expected:
- 🐙 KRAKEN ONLINE as <bot#tag>

## Runtime Security Model
Fail-closed (default deny), two layers:
1) **Guild scoping** — commands only respond in their configured guild (`DISCORD_GUILD_ID` for OPS, `recruitGuildId` for Recruit).
2) **Role checks** — Recruit commands use `isLeaderOrAdmin` (`src/permissions.js`): Discord Administrator, or the `leaders` role `/recruit-setup` creates. OPS additionally supports the optional `ALLOWED_ROLE_IDS` + `LEADER_CHANNEL_ID` lock.

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
- Confirm the file exists in `src/`
- Confirm import uses correct filename (case-sensitive in ESM environments).

### CR API failures / breaker open
Symptoms:
- Commands reply with CR cooldown messaging.
Fix:
- Run /status to see breaker remaining time and last error.
- Wait for breaker to close or tune breaker env vars.

## Recommended Local Test Flow
1) Deploy commands:
   - npm run deploy
2) Start bot:
   - npm start
3) In the main clan server, test `/ops` — opens the Overview/War/Donations/Actions panel.
4) If Recruit HQ is enabled, test recruit commands there — see [docs/commands.md](docs/commands.md) for the full list (`/apply`, `/status`, `/recruit-eval-now`, `/standings`, etc.)

For production start/stop, see [DEPLOYMENT.md](DEPLOYMENT.md) (PM2 on Linux is the proven production model) or [docs/bot-startup.md](docs/bot-startup.md) for local Windows Task Scheduler.

## Multi-Clan Model (Done)
This template already supports "beyond a single clan" — via **isolated
instances**, not a shared multi-tenant bot: each clan gets its own bot token,
its own config, its own database, fully separate. See `SETUP.md` (one clan)
and `docs/multi-clan-hosting.md` (running many from one host).

A genuinely shared, single-bot multi-tenant rebuild (one bot invited by every
clan, per-guild config, isolated DB rows) was considered and deliberately
**not** built — it's a much bigger, riskier project, only worth it once
there's proven demand across many clans. If that day comes, treat it as its
own careful, dedicated project — not an incremental add-on.
