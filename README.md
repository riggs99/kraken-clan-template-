# KRAKEN (Discord Bot) — Clash Royale Clan Intel
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.x-brightgreen)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-blue)](https://discord.js.org/)

KRAKEN is a private Discord bot for Clash Royale clan management, spanning two guild-scoped surfaces:
- **Main clan server (OPS)**: `/ops` — a single tabbed command center for clan health, war stats, donations, and promotion/demotion/kick recommendations
- **Recruit HQ (Recruit)**: application intake, automated tier tracking (probation → warcore/underwatch → boot review), self-service breaks, appeals, and a fair-queue waitlist for when the clan is full — see [docs/commands.md](docs/commands.md) for the full reference
- Role-based access, channel locking, caching + cooldowns, circuit breaker for API stability
- River Race reminders exist in code but are currently disabled (noisy, low value)

## Requirements
- Windows + PowerShell
- Node.js v20+
- A Discord Application + Bot token
- Clash Royale API token (used via RoyaleAPI proxy)

## Install
From project root:

1) Install deps:
- npm install

2) Create .env:
- Copy-Item .env.example .env

3) Edit .env (add your real values):
- notepad .env

## Invite Bot (Scopes)
Invite using:
- bot
- applications.commands

If commands fail to deploy with 403 Missing Access, the bot was invited without applications.commands. Re-invite correctly.

## Deploy Slash Commands
Guild-scoped deploy:

- node C:/path/to/kraken-clan-template\scripts\deploy-commands.js

Expected:
- ✅ Commands deployed

## Run
- node C:/path/to/kraken-clan-template\src\index.js

Expected:
- 🐙 KRAKEN ONLINE as <bot#tag>

## Security Model
All commands are restricted to:
- DISCORD_GUILD_ID (server lock)
- LEADER_CHANNEL_ID (channel lock)
- ALLOWED_ROLE_IDS (role lock; your kraken role)

Default is deny.

## Key Commands
See [docs/commands.md](docs/commands.md) for the current, full reference (`COMMANDS.md` at the repo root is legacy and describes a command set that no longer exists).

## Troubleshooting (Fast)
- Missing DISCORD_TOKEN:
  - ensure `.env` exists in the project root (or set `DOTENV_PATH` to your env file)
- Deploy fails (Missing Access):
  - re-invite bot with applications.commands scope
- API cooldown:
  - breaker may be open; use /status

## Sharing Safely
- Never share .env
- Share .env.example
- Ensure .env is in .gitignore
- No tokens or IDs should be present in source code

## Docs
- [docs/commands.md](docs/commands.md) — full, current command/feature reference (OPS + Recruit)
- [docs/bot-startup.md](docs/bot-startup.md) — process management (start/stop/logs, season reset)
- DEV.md — developer setup notes (partially legacy, see note in AGENTS.md)

## Recruit HQ Setup

Recruit runs in a second, separate Discord server ("Recruit HQ") and is entirely optional — set `"enabled": false` in `config/recruit.config.json` to run OPS-only.

- Both `config/ops.config.json` and `config/recruit.config.json` must have their guild IDs (and any placeholder values) filled in before startup, or the bot fails fast with a config error.
- Run `/recruit-setup` once in Recruit HQ (server owner/admin only) to create the required channels and roles and store their IDs in SQLite.
- `#appeals`, `#waiting-list`, and the `waitlist` role are **not** created by `/recruit-setup` — they must be created manually and their IDs added to `config/recruit.config.json` (`channels.appealsChannelId`, `channels.waitingListChannelId`, `roles.waitlistRoleId`).
- Recruit commands are hard-scoped to `recruitGuildId` and never appear in the main clan server; `/ops` is guild-scoped to `opsGuildId` and never appears in Recruit HQ (though it can also run in Recruit HQ for leaders — see docs/commands.md).

