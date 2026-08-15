# KRAKEN Agent Rules

## Scope
These rules apply to the entire repository.

## Mission
Ship reliable changes for KRAKEN with zero OPS regressions and predictable Recruit behavior.

## Non-Negotiables
1. OPS must not regress unless explicitly requested.
2. Do not merge/push to `main` unless the user explicitly says to.
3. No global slash command registration unless explicitly requested.
4. Recruit features must remain Recruit-HQ guild-scoped.
5. Keep recruit logic isolated under `src/recruit/` whenever possible.
6. No unrelated refactors, renames, or formatting-only churn.

## Branch Workflow
- Default: commit directly to `main` — but only when the user explicitly approves each commit/push. Never commit or push unprompted.
- For a larger, riskier change (e.g. a multi-tenant rebuild), use a feature branch if the user asks for one — not a blanket requirement.
- Keep the branch set minimal either way.

## Recruit/OPS Sync Rules
- All recruit role moves and decisions must post to configured decisions channel.
- Keep evaluator, apply flow, break flow, and offboarding consistent across:
  - Discord roles
  - profile status in DB
  - decision logs/messages
- War judgment must be war-day aware (avoid training-day penalty inflation).
- If role/channel IDs are missing, fail fast with clear setup guidance.

## War-Day Policy
- Prefer live CR API war-state when reliable.
- Use deterministic fallback policy when API is ambiguous.
- Always log source used: `api-state`, `api-period`, `anchor`, or `snapshot`.
- Do not silently change policy.

## Change Discipline
1. Read relevant files first.
2. Patch minimal root cause.
3. Run syntax checks on changed files.
4. **If changes touch runtime** (`src/`, `scripts/`, `package.json`): restart the bot and confirm a clean `KRAKEN ONLINE` with no errors in the logs **before committing** — via PM2 on Linux, or `scripts/kraken-restart.ps1` + `scripts/kraken-verify.ps1` for local Windows dev.
5. Report:
   - what changed
   - why
   - files touched
   - commands the user should run

## Communication Style
- Concise, direct, technical.
- State assumptions and risks clearly.
- Provide copy-paste PowerShell commands for next actions.

## Docs
- `SETUP.md` is the authoritative first-time setup guide (start here for any new clan).
- `DEPLOYMENT.md` is the canonical production/ops reference (PM2, updates, backups).
- `docs/commands.md` is the living, accurate command/feature reference (slash commands, panels, waitlist, appeals, server-leave grace period, automated behaviour). Keep it updated when behavior changes.
- `docs/multi-clan-hosting.md` covers running many isolated clan instances from one host.
- `COMMANDS.md` is intentionally legacy (a pointer to `docs/commands.md`) — leave it as-is.
- `README.md` and `DEV.md` were brought up to date alongside this file — still worth a quick cross-check against actual code (`src/`) after any significant behavior change, since docs can drift.

## Process Management
- **Production (any real clan deployment):** PM2, on Linux — proven working (`pm2 start src/index.js --name <clan>`, `pm2 save`, `pm2 startup`). See `SETUP.md` and `DEPLOYMENT.md`. PM2 works fine on Linux; a Windows-specific `EPERM` named-pipe issue only affects PM2 *on Windows* and does not apply to Linux hosting.
- **Local Windows dev/testing:** the `scripts/kraken-*.ps1` scripts (`kraken-boot`, `kraken-stop`, `kraken-restart`, `kraken-verify`) remain available for running/testing on a local Windows machine via Task Scheduler — a dev convenience, not the production model.
- Provide stepwise commands.
- If a command fails, provide the immediate diagnostic next command.
