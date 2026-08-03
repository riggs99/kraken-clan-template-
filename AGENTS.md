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

## Branch Workflow (Mandatory)
- Work only on a feature branch from `main`.
- After successful merge/push:
  - delete merged feature branch (local)
  - delete merged feature branch (remote if it exists)
  - create a new fresh feature branch
- Keep branch set minimal: `main` + current active branch.

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
4. **If changes touch runtime** (`src/`, `scripts/kraken-*.ps1`, `package.json`): restart with `scripts/kraken-restart.ps1` and confirm `scripts/kraken-verify.ps1` passes (bot online + heartbeat in log) **before committing**.
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
- `docs/commands.md` is the living, accurate command/feature reference (slash commands, panels, waitlist, appeals, server-leave grace period, automated behaviour). Keep it updated when behavior changes.
- `docs/bot-startup.md` is the canonical process-management reference.
- `README.md`, `COMMANDS.md`, `DEPLOYMENT.md`, `DEV.md` predate the multi-guild recruit system and may still describe legacy single-guild commands — verify against actual code (`src/`) before trusting them for anything Recruit-related.

## Windows/Process Management
- The bot runs via **Windows Task Scheduler** (task name `KrakenBot`), not PM2. PM2 was removed — its named-pipe IPC returns `EPERM` on this machine and cannot be fixed.
- **Restart:** `scripts/kraken-restart.ps1` (stop → re-enable task → start → wait for `KRAKEN ONLINE` + heartbeat). **Verify:** `scripts/kraken-verify.ps1`. Full reference: `docs/bot-startup.md`.
- `kraken-stop.ps1` disables the task — never use `Start-ScheduledTask` alone after a stop without `Enable-ScheduledTask` first.
- **Never commit runtime changes** unless `kraken-verify.ps1` passes. Install `scripts/install-git-hooks.ps1` once per clone to enforce via pre-commit.
- Provide stepwise commands.
- If a command fails, provide immediate diagnostic next command.
