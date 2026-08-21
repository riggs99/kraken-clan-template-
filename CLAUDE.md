# Working rules for this project

This is **kraken-clan-template** — a genericized, portable copy of KRAKEN (a
Discord bot for Clash Royale clan management), derived from a real, currently
running production bot for the original clan it was built for. The goal of this
project is to make that same bot cloneable/deployable for **any** clan, with
zero hardcoded identity leaking from the original.

## The source project boundary — read this first

The original bot ("kraken1") lives at `c:\dev2\kraken` and is **live,
in-production, currently serving real users right now**.

- **Never modify, write to, or delete anything under `c:\dev2\kraken`** from
  within this project. Read-only access only, and only for the specific
  purpose of comparing against or re-copying a file into *this* project.
- Never run any command that could affect kraken1's running process — no
  restart/stop scripts, no `npm` commands, no `git` operations targeting that
  folder.
- If something in this project needs a file kraken1 has that wasn't part of
  the initial copy, **read it from kraken1, then create/edit the copy here**
  — never edit in place over there.
- This project has its own fresh git repository, independent of kraken1's
  history. Nothing here should ever be pushed to kraken1's remote.

**What was already copied** (curated, not a full mirror) — source code,
scripts, `config/*.json` (still containing kraken1's real IDs — see the task
list below), `.env.example`, `package.json`/`package-lock.json`, docs,
`assets/`, `patches/`.

**What was deliberately excluded and must never be pulled in later either**:
`data/` (kraken1's real production history/DB), `.env` (kraken1's real
secrets), `logs/` (real production logs), `.git/` (fresh history only),
`node_modules/` (regenerate via `npm install`), the stray `.bak_*` debug
files that were sitting in kraken1's `src/`.

## Model selection

- Default to Sonnet for the bulk of this work — the config-extraction pass,
  routine edits, verify cycles. ~90% of the time.
- Opus only for a specific bounded moment: designing the eventual multi-clan
  hosting rollout logic, or anything touching how a real clan's live data
  would be handled once this template is actually deployed for someone.
- Don't route to Haiku — same reasoning as kraken1: once this is deployed for
  a real clan, the stakes (their member data, their Discord roles) are the
  same as kraken1's.

## Context management

- Suggest `/compact` mid-task when deep into one part of the extraction pass
  that isn't finished yet.
- Suggest `/clear` at real boundaries — a phase of the task list below is
  verified and committed.
- Never trade quality for token savings on this project specifically —
  a mistake here doesn't just break one bot, it becomes the mistake every
  future clan's copy inherits.

## Genericization status — done, verified, and live-tested on a real server

This was produced by a three-angle audit of kraken1 (hardcoded-value hunt,
guardrail-portability check, crash-recovery trace) plus cross-referencing
kraken1's own `docs/kraken2-migration-plan.md` (note: that doc describes a
*different*, bigger architecture — one shared multi-tenant bot serving every
clan at once. That was considered and explicitly **not** chosen. This project
is the simpler model: every clan gets its own fully isolated instance, own
bot token, own database, no shared tenant state at all. Everything below
reflects that simpler model — nothing here requires the tenant-ID/shared-DB
rework that doc describes. See `docs/multi-clan-hosting.md` for the actual
one-host-many-clans hosting procedure this project is built around.)

Everything below is **done and verified** (syntax, lint, module-import smoke
test, `smoke-wiring.js` all pass — see the Verification checklist) **and has now
been live-tested end to end on a real throwaway Discord server** (step 5 below —
the one thing that previously couldn't be checked without a live connection).

### 1. Hardcoded clan identity — extracted into config ✅

- `src/recruit/commands/add-member.js`, `apply.js`, `src/recruit/index.js`,
  `src/recruit/messages.js`, `src/recruit/waitlist.js` — the clan name/tag
  that used to be hardcoded into user-facing message strings now reads from
  `config/recruit.config.json`'s `clanName` field (or, for `waitlist.js`,
  loads it directly via `loadRecruitConfig()` since those functions don't
  receive `recruitConfig` as a parameter).
- `src/recruit/welcome-guide.js` — the hardcoded fallback feedback-channel ID
  was removed entirely (a real ID belonging to one clan sitting there as the
  "default" would have silently routed a *different* clan's bug reports into
  the original clan's channel). The hardcoded personal author name is now
  `recruitConfig.clanName`.
- `src/dashboard-components.js` — `CLAN_BADGE_URL` now reads from the
  `CLAN_BADGE_URL` env var, defaulting to `null` (no badge shown) rather than
  a hardcoded image URL.
- `src/recruit/onboarding.js` — the hardcoded welcome-image filename/path is
  gone; the welcome post now optionally reads `recruitConfig.welcomeImagePath`
  and skips the image entirely if unset. The original clan's actual logo file
  was deleted from `assets/welcome/` — nothing ships by default.
- `src/war-cycle.js` — the war-anchor comment was reworded to note this is
  very likely a genuine global CR constant, not clan-specific, but to verify
  against your own clan's `periodType` data before relying on it. The
  underlying logic wasn't changed (already correctly a last-resort fallback).

### 2. Hardcoded paths — fixed ✅

- The absolute Windows path that used to default `KRAKEN_DB_PATH` in 5 files
  (`src/ops.js`, `src/recruit/db.js`, `scripts/full-clan-reset.js`,
  `scripts/dm-welcome-guide-blast.js`, `scripts/test-plan-smoke.js`) is now
  `path.join(process.cwd(), 'data', 'kraken.db')`, matching how
  `HISTORY_PATH` in `src/history.js` already did it correctly.
- `ecosystem.config.js` turned out to be **dead** — confirmed by actually
  requiring it: it silently returned an empty object given this project's
  `"type": "module"` setting, so it was deleted rather than fixed.
  `ecosystem.config.cjs` is the real one; its `cwd` is now derived from
  `__dirname` instead of hardcoded, and its two duplicate/misplaced `cwd`
  keys inside `env` (which did nothing) were removed.
- `scripts/kraken-boot.ps1` and `scripts/kraken-stop.ps1` now derive their
  root from `$PSScriptRoot`, matching the pattern `kraken-restart.ps1`/
  `kraken-verify.ps1` already used correctly. Cosmetic hardcoded-path hints
  in `Write-Host` messages across all four scripts were fixed too.
- `scripts/scrub-logs.ps1` had a hardcoded Windows username in its PM2 log
  paths (found during the final clean-check, not the original audit) — now
  derived from `$env:USERPROFILE`.

### 3. Config files — genericized, dead keys removed ✅

- `config/ops.config.json` and `config/recruit.config.json` now use the
  `PUT_*` placeholder convention `src/config/loadConfig.js`'s
  `findPutPlaceholders` guard already enforced — confirmed live that the
  guard actually blocks startup with a clear message until real values are
  filled in.
- Confirmed-dead keys were deleted outright rather than templated:
  `ops.config.json`'s `channels`/`roles`/`clan`/`features` blocks (nothing
  reads them beyond `enabled`+`opsGuildId`); `recruit.config.json`'s
  `roles.applicantRoleId`/`approvedRoleId` and the `cooldowns`/`probation`/
  `scoring` blocks.
- Added `clanName` (now a required key in `loadConfig.js`) and
  `welcomeImagePath` (optional) to `recruit.config.json`, and
  `channels.feedbackChannelId` to support the welcome-guide.js fix above.

### 4. `.env.example` — expanded ✅

Now documents every env var the code actually reads: `KRAKEN_DB_PATH`,
`REPORTS_CHANNEL_ID`, `GRACE_DAYS`, `RECRUIT_WAR_ANCHOR_UTC`/
`RECRUIT_WAR_ANCHOR_EPOCH_MS`, `RECRUIT_FEEDBACK_CHANNEL_ID`,
`RECRUIT_STARTUP_BACKFILL_DAYS`, `OPS_MAX_LINE_CHARS`,
`RECRUIT_DISABLE_COOLDOWNS`, `DEBUG_CR_API_BODY`, `CLAN_BADGE_URL` — each
with a one-line comment on what it controls and its default if unset.

### 5. `package.json`'s `"name"` field ✅

Now `"kraken-clan-template"`.

### 6. Also found and fixed during the final clean-check pass (beyond the original audit)

- Two throwaway dev-debug scripts at the repo root (`inspect-api-fields.js`,
  `test-cr.js`) hardcoded the clan tag and weren't referenced anywhere in
  `package.json` — deleted rather than genericized.
- The unused `landingMessage` export in `messages.js` (confirmed via grep to
  have zero callers) was dead code carrying the same hardcoded clan name —
  deleted rather than fixed.
- The `.claude/` folder (session-specific tool-permission config, of no value
  to anyone cloning this template) was removed entirely.
- Several doc files (`DEPLOYMENT.md`, `SECURITY.md`, `docs/commands.md`,
  `DEV.md`, `README.md`, `docs/bot-startup.md`) had example clan tags,
  example paths pointing at the original machine, or descriptive prose
  mentioning the original clan by name — all genericized.

## Guardrails already verified safe — don't weaken these while extracting config

A dedicated audit traced these against a **completely empty, fresh clan
state** (no history, no profiles, no prior tracking) — every one of them was
confirmed to degrade gracefully rather than crash or misbehave:

- `src/permissions.js` — `isLeaderOrAdmin` fails closed (only real Discord
  Administrators pass) when role IDs aren't configured yet, rather than
  silently letting everyone through. `confirmMemberGone` and
  `applyRolesVerified` have no stored-state dependency at all.
- `src/history.js` — every function (including the lock/backup helpers) was
  verified against a truly empty `{firstSeen:{}, days:{}}` starting state.
  No divide-by-zero, no null-deref.
- `src/circuit-breaker.js` — stateless in-memory, resets cleanly per process.
- `src/recruit/evaluator.js` — explicit fail-safe handling when role IDs
  aren't configured (`missingRoles` check, posts a clear "run
  `/recruit-setup`" message rather than crashing); `isFirstEverCheck`
  correctly bootstraps a brand-new clan's very first tick.
- `src/war-cycle.js` — the war-anchor fallback is genuinely last-resort; a
  fresh clan's own snapshots stamp real `periodType`/`periodIndex` data
  immediately, so the anchor essentially never gets reached for a new clan.

**Do not refactor any of this reasoning away while doing the config
extraction above** — the goal is making strings/IDs configurable, not
touching the empty-state handling that makes all of this safe already.

## Hard-won correctness rules — verify these survived the copy intact

Pulled from kraken1's own `docs/kraken2-migration-plan.md`, written after a
full season of production use plus multiple audit passes. These are specific
bugs that were found and fixed the hard way — re-verify each one is still
true in this copy before considering the port "clean," since a careless edit
during the config-extraction pass could silently reintroduce any of them:

- War-day classification must prefer, in order: the stored `warDay` flag →
  live race state → period-index math → decks-used activity that day →
  anchor-cycle tiebreaker (last resort). Never classify a day from
  cumulative fame alone — it lingers across the whole race week.
- Any participation-rate stat must exclude members with `historyDays < 3` or
  `inGrace` — otherwise a fresh tracking window reads as 0% participation
  for the entire clan simultaneously, not genuine inactivity.
- Participation/fame/deck math must stay restricted to actual war days, not
  every tracked calendar day — training days structurally have zero fame.
- `seriesForTag` can return fewer rows than the requested `dayKeys` (a gap
  day). Always key subsequent lookups off the row's own `.day` field, never
  assume row `i` corresponds to `dayKeys[i]`.
- Fame delta must be a true per-day delta, never `max(cumulative, diff)` —
  that collapses the delta into summing running totals instead.
- Only HTTP 429/5xx should trip the CR API circuit breaker. A 404/400 is a
  caller input error, not an upstream-health signal.
- A break shields a member from tier *evaluation*, not from clan-membership
  *sync* — someone who left the clan while on break still gets offboarded.
- Underwatch/probation streaks must pause (not reset, not keep accruing)
  while a member is on an active break.
- Any bot-initiated role change must suppress the manual-role-sync listener
  first, or the bot's own write double-processes itself through that
  listener. (This rule was found violated once, for real, in
  `evaluator.js`'s post-break underwatch escalation — see the deep-audit
  section below.)
- WAL-mode SQLite needs an explicit `wal_checkpoint(TRUNCATE)` before any raw
  file-copy backup, or recent writes sitting in the `-wal` file get missed.
- `player_tag` is stored without a leading `#`, everywhere, no exceptions.
- `history.js`'s JSON writes must be atomic (temp-file + rename, not a raw
  `writeFileSync`) — **this was already fixed in kraken1 this session**
  (matching `discipline.js`'s existing pattern) and should already be present
  in the copy. Verify it's there, don't reintroduce the non-atomic version.

## Verification checklist

Same five steps as kraken1, adapted for a project with no live bot running
yet:
1. ✅ `node --check` on every `.js` file in `src/` and `scripts/` — all pass.
2. ✅ `npx eslint "src/**/*.js" "scripts/**/*.js"` — zero errors/warnings.
3. ✅ Module-import smoke test — every changed file imports cleanly. `index.js`
   specifically was verified twice: once confirming it correctly *refuses* to
   start with placeholder config still in place (the guard working as
   designed), and once with temporary dummy real-shaped values confirming the
   full import chain works end to end. Config was reverted to placeholders
   immediately after.
4. ✅ `node scripts/smoke-wiring.js` — same two-pass approach: 6/8 pass against
   the real placeholder config (2 fail *only* because of the intentional
   `PUT_*` guard, which is correct), all 8/8 pass with temporary dummy config.
5. ✅ **Live-tested against a real throwaway test server** (2026-08-08). A
   separate test Discord bot + throwaway server + its own CR API key (pointed at
   a real clan tag) were stood up per the guidance below. Confirmed: clean
   `KRAKEN ONLINE` boot, `/recruit-setup` builds the whole server correctly and
   generically (no original clan name/badge/IDs anywhere), and `/apply` onboards
   a real member end to end. Config was reverted to `PUT_*` placeholders and the
   repo re-scanned clean (no secrets/real IDs) before committing.

   The live test also surfaced and fixed real issues, all committed: a new
   `npm run setup-check` pre-flight verifier; `/recruit-setup` hardening
   (leaders category grouping, ID-first channel/role resolution so a rename can
   never scramble an existing server, public/private decisions split, role
   hoisting + safe ordering, a role-hierarchy warning, and a guard against ever
   flipping a pre-existing private channel public); automatic `leaders`-role
   grant for in-game co-leaders/leaders on `/apply`; and refreshed setup docs
   (`SETUP.md` is now the authoritative guide).

All five steps are done — the template has been genuinely deployed and exercised
on a live Discord server, not just verified offline.

### How to safely run step 5's live test

Using the **original clan's real Clash Royale tag** for this test is fine,
and actually better than a fresh empty clan — `CLAN_TAG` is just a read-only
public API lookup, not something exclusive to kraken1, and real war/fame/deck
history exercises the tier system and season reports properly instead of
only the empty-state path (already separately verified above). What must
stay separate is everything Discord- and storage-side:

- **A different Discord bot application and a different (throwaway test)
  Discord server** — not kraken1's real server. `/recruit-setup` will create
  real roles/channels wherever it's pointed.
- **A different Clash Royale API key** — same clan tag is fine, but the key
  itself needs to be its own, bound to wherever this test actually runs, so
  it isn't sharing a rate-limit budget with kraken1's key.
- **This project's own `data/` folder** — already separate by construction
  (a different folder entirely from kraken1's), so this one takes care of
  itself as long as nothing is manually copied over from kraken1's `data/`.

The simplest first test doesn't need real hosting infrastructure set up yet
(see `docs/multi-clan-hosting.md` for that, once this passes) — running
`node src/index.js` locally, in this folder, against a free throwaway Discord
test server is enough to prove the genericized code actually works.

## Post-launch deep audit (2026-08-21) — full-codebase coverage check

The genericization audit above and the two `/code-review` passes both operate
on a diff (recent commits, or a branch vs `main`). That leaves a real blind
spot: this repo's history is one big bulk-copy commit (`c4ed2ef`, the entire
original codebase) plus a long tail of small targeted commits — meaning any
file untouched since that first commit had **never** been through a
diff-based review, no matter how many review passes ran. Checked concretely:

```
git log --name-only --format="" c4ed2ef..HEAD -- src scripts | sort -u
```

— only 21 of 62 `src`/`scripts` files had been touched by any commit since
the bulk import. The other 41 had zero targeted scrutiny from any commit-diff
review, ever. This section is what closing that gap turned up: every one of
those 41 files was read start-to-end, cross-checked against the correctness
rules above and against each other's call sites (e.g. every
`applyRolesVerified`/`.roles.add`/`.roles.remove` call site was grepped and
checked against `suppressManualTierSync`, not just spot-read in isolation).
The 7 files the sections above already claimed were audited
(`permissions.js`, `history.js`, `circuit-breaker.js`, `war-cycle.js`,
`cr-api.js`, `backup.js`, `config/loadConfig.js`) were also re-read fresh in
this pass rather than trusted on the strength of the earlier claim — all 7
still match what's documented above, no drift found.

### Real bugs found and fixed (all committed, all pushed)

- **`src/recruit/evaluator.js` — the manual-role-sync suppression rule,
  violated.** `runPostBreakEnforcement`'s escalation-to-underwatch role grant
  never called `suppressManualTierSync`. Concretely: the `GuildMemberUpdate`
  that role grant triggers was picked up by `manual-role-sync.js` as if a
  *leader* had manually changed the role — mislabeling a fully-automated
  post-break-inactivity escalation as `last_verdict='manual_override'` in the
  member's profile (a wrong, permanent audit-trail entry), and posting a
  second, confusing "Manual role sync" message to the decisions channel right
  next to the correct "moved to underwatch — post-break inactivity" message
  for the same event. Worse: this path had no `upsertUnderwatchState` call of
  its own — it was silently relying on manual-role-sync's side effect to
  create the underwatch state row *at all*. Fixed by adding the suppression
  call plus an explicit `upsertUnderwatchState` (mirroring the daily
  evaluation loop's own pattern, preserving an existing paused clock rather
  than always resetting).
- **`src/index.js` — recruit-guild component interactions had a silent
  fallthrough.** An unrecognized button/modal in the recruit guild (one
  `handleRecruitInteraction` doesn't match) fell through to the unrelated
  OPS/WAR "kraken"-role permission gate — a different guild's permission
  concept entirely — producing a confusing wrong-context denial, and it was
  never logged, so there'd be zero server-side trail if it ever fired.
  Separately, autocomplete for any recruit command *other than* `/status`
  (there are none today, but a tag-autocomplete on `/recruit-history` or
  `/recruit-add-member` would be a natural next feature) would have silently
  returned nothing to Discord — dead dropdown, no error, no log. Both fixed:
  recruit-guild component interactions are now a hard boundary (log +
  sensible reply/`interaction.respond([])` on anything unrecognized, never
  fall through). Also added `client.on(Events.Error/ShardError, ...)` — a
  classic discord.js gotcha: `Client` is a Node `EventEmitter`, and an
  `'error'` event with zero listeners is thrown by Node itself and crashes
  the whole process. Every other failure path in this file logs and keeps
  running; this was the one gap that could take the bot fully offline on a
  transient websocket/REST error.
- **`src/risk-score.js` — repeat-offender flag droppable from the display.**
  `reasons.slice(0, 4)` truncated the human-readable reasons list, but the
  `🔁 Repeat offender` reason was always pushed *last* (after up to 5 other
  possible reasons) — meaning members tripping the most other flags were the
  most likely to have that specific note silently cut from what leaders see.
  The underlying `repeatOffender` boolean was already correct everywhere it
  actually drives decisions (`promotions.js`, `analytics.js`,
  `evaluator.js`'s OPS-weak-range check) — display-only bug. Fixed by
  promoting it to the front of the list before truncating (safe: it can
  never coexist with the grace-period reason, so nothing gets displaced).

- **`src/metadata.js`'s warnings/notes system — was half-built, now closed
  (2026-08-21).** `addWarning`/`addNote` had zero callers anywhere despite
  the *display* side being fully wired into `/ops` in 4 places — every clan
  saw `📝0/0` next to every member forever, with no way to populate it. Built
  the missing UI rather than stripping the display: `/ops`'s actions-tab
  player drilldown now shows **⚠️ Add Warning** / **📝 Add Note** buttons
  (only once a player is selected) that open a modal for the text, write via
  `addWarning`/`addNote`, and re-render the same drilldown view in place.
  Two things worth knowing if this needs touching again:
  - `opsHandler`'s button/select flow unconditionally calls
    `interaction.deferUpdate()` before doing anything else — `showModal()`
    must be an interaction's *first* response, so the warn/note buttons are
    intercepted before that defer, not folded into the generic dispatch.
  - `index.js` didn't route `ops:`/`war:`-prefixed **modal** submits to
    `opsHandler`/`warHandler` at all before this — only buttons/selects were
    checked. Fixed by adding `interaction.isModalSubmit()` to that
    dispatch condition. Fixing this exposed a separate, more serious bug in
    the SAME `index.js` block: the recruit-guild "unhandled interaction"
    fallback added earlier this pass was catching `ops:`/`war:` components
    too, since `opsGuildId === recruitGuildId` in the documented standard
    single-server setup — meaning that earlier fix had (briefly, already
    pushed) broken every `/ops`/`/war` button click on the default
    deployment. Fixed by excluding `ops:`/`war:`-prefixed customIds from the
    recruit dispatch entirely; see the routing-gap fix commit for detail.

### Cosmetic-only, no behavior change

- `src/recruit/policy.js`'s `'TWO_WAR_INACTIVE'` reason-code constant
  actually labels a **one**-week (`sum7`) inactivity check, not two. Used
  consistently as an opaque display key in exactly 3 places (`policy.js`
  itself, `war-board.js`), and every human-facing string next to it correctly
  says "1 full war week" — zero behavioral impact, just a confusing name for
  a future reader. Left as-is.

## Shared helpers — reuse these, don't reinvent them

Identical to kraken1, since this is the same codebase:
- **War-day classification**: `isHistoricalWarDay` (`src/war-cycle.js`).
- **Cumulative-counter deltas**: `deltaSeries` (`src/window-delta.js`).
- **Discord membership checks**: `confirmMemberGone(guild, discordId)`
  (`src/permissions.js`) — three-state, never a bare
  `.fetch().catch(() => null)`.
- **Permission checks**: `isLeaderOrAdmin` / `isServerOwner`
  (`src/permissions.js`).

## Production data safety (once this is actually deployed for a real clan)

This project has no real data of its own yet. But the moment this template
is cloned and configured for an actual clan, the exact same rule from
kraken1 applies to that clan's `data/history.json` and `data/kraken.db`:
back up before any mutation (WAL-safe `.backup()` for the DB, never a raw
file copy while the bot may be writing), preview/dry-run before it happens,
and get explicit confirmation before anything irreversible.
