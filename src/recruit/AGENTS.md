# Recruit Subsystem Rules

## Scope
These rules apply to `src/recruit/` and all subpaths.

## Core Goals
- Keep Recruit HQ safe, deterministic, and auditable.
- Every role move must have an explicit reason and a visible decision trail.
- Recruit state in Discord and SQLite must stay in sync.

## Command/Scope Rules
1. Recruit interactions must hard-stop outside `recruitGuildId`.
2. Recruit commands are guild-scoped only (never global).
3. OPS behavior must remain untouched unless explicitly requested.

## Decision Logging Rules
- Role moves (probation/underwatch/warcore/remove) must post to decisions channel.
- High-signal summaries may also go to logs/public channels, but decisions channel is mandatory.
- Decision posts must be non-pinging by default unless explicitly requested.

## War Evaluation Rules
- Evaluate with war-day-aware denominators.
- Do not penalize training days as missed war days.
- Use source precedence:
  1) live API war state
  2) configured fallback anchor cycle
  3) snapshot signal
- Include source in logs for every daily evaluation.

## Data Integrity Rules
- Keep `profiles.status` aligned with applied tier role.
- Offboarding must clear recruit-managed roles and apply remove role when configured.
- Break approval/expiry/escalation flows must update DB and role state consistently.

## Safety Rules
- Fail fast on missing critical IDs with actionable setup guidance.
- Do not silently swallow critical state-transition failures.
- Preserve append-only/audit behavior in ledger/log channels.

## UX Rules
- Keep outputs compact and readable (avoid walls of text).
- Prioritize actionable moderation info: who, what changed, why.
