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
  **Update (2026-08-22):** `src/metadata.js` (a separate `data/metadata.json`
  file, disconnected from every other player-state table) has since been
  retired entirely — warnings/notes now live in `kraken.db`'s
  `player_warnings`/`player_notes` tables (`recruit/db.js`'s `initDb`),
  keyed by `player_tag` to match how `/ops` already identifies players (not
  `discord_id` — a clan member who hasn't linked Discord yet still needs to
  be warnable, and `profiles.player_tag` has no `UNIQUE` constraint anyway,
  so a real foreign key isn't valid SQLite there). Read/written via `ops.js`'s
  own direct DB connections, matching every other DB access already in that
  file, not through recruit's shared handle. `loadWarningsNotesFromDb`
  reproduces the old file's exact `{tag: [{...}]}` shape, so `toTagCountMap`
  and everything downstream needed zero changes — only the storage moved.
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

- **A documented `/relink` command didn't exist anywhere a user could reach
  it — closed (2026-08-23).** `SETUP.md`/`docs/multi-clan-hosting.md` both
  told operators to have an existing clan's members run `/relink` to keep
  their standing when onboarding onto KRAKEN. There was no such slash
  command, and `apply.js`'s `relinkCore` — a fully-built function that does
  exactly this (preserves an existing member's tier instead of resetting to
  probation, even inferring it from their current Discord role if no KRAKEN
  profile exists yet, plus a bulk-rollout progress counter) — had **zero
  callers anywhere**. The only reachable flow (`applyCore`, via the "Agree &
  Join" button) unconditionally resets *everyone* to `probation`, no matter
  their prior standing. So the actual, live behavior for onboarding an
  existing clan's roster was either "follow docs, nothing happens" or "use
  the only working button, and every existing member gets demoted to a
  fresh recruit." Found by directly answering a user question about what
  happens when KRAKEN joins an already-established server — not part of
  the earlier systematic audit passes, which read this file but didn't
  trace whether `relinkCore` was ever actually invoked.

  Fixed by wiring `relinkCore` up as a **`#relink` channel** (a "Link My
  Account" button + modal), the same self-service-panel pattern as
  welcome/break/appeals/waitlist — not a slash command, since that's a
  bigger, more consistent UX for members who don't know Discord commands,
  and matches how the equivalent welcome flow already works. `/recruit-setup`
  now creates `#relink` alongside `#welcome` with identical visibility (both
  need to be visible to someone holding zero KRAKEN roles yet), stores its
  ID the same way every other managed channel does, and `channels.relinkChannelId`
  is a valid config override for pointing at an existing channel. All docs
  that referenced a nonexistent `/relink` command were corrected to describe
  the real panel.

- **`#welcome` and `#relink` merged into one shared `#link-account` channel
  (2026-08-26).** Both channels always had identical visibility (readable by
  everyone, including a `new-arrival` with zero KRAKEN roles), so having two
  separate channels for "Agree & Join" vs. "Link My Account" read as
  redundant to an operator seeing both listed for a brand-new clan with no
  actual prior roster distinction to justify it. `setup.js` now creates one
  channel (fresh clans get it named `link-account`; an existing clan's
  already-created `#welcome` channel is resolved and reused as-is, never
  renamed), and posts both panels into it — `relinkChannelId` is set to the
  same ID as `welcomeChannelId` whenever `enableRelinkChannel` is on, rather
  than pointing at a second physically separate channel. Neither panel's
  underlying logic changed at all: `applyCore` and `relinkCore` were checked
  directly and are NOT interchangeable (`relinkCore` never grants the
  `probation` role, has no blacklist/cooldown check, and doesn't attempt the
  leaders-role auto-detection `applyCore` does) — this was a channel
  consolidation, not a logic merge, and both buttons still route to their
  own distinct, already-tested function. An operator who explicitly sets
  `channels.relinkChannelId` to a different real channel ID in config still
  gets that override via `syncRecruitRuntimeFromConfig`; merging only
  changed the default. Also fixed a real adjacent gap found while touching
  this: `ensureRelinkPost` was previously only ever called from `index.js`'s
  `ClientReady` handler, never from `/recruit-setup` itself — meaning running
  `/recruit-setup` on an already-running bot (the normal case) left the Link
  My Account panel missing until the next full process restart. `setup.js`
  now calls it directly, same as it already did for `ensureWelcomePost`.
  Verified offline: syntax + eslint clean, `setup.js`/`apply.js`/`index.js`
  import cleanly, `smoke-wiring.js` at the documented 6/8 placeholder-config
  baseline. Not yet live-tested against a real Discord guild as of this
  writing — the next step is re-running `/recruit-setup` on `kraken-host`'s
  throwaway `test-provision` instance (already live from validating the new
  `provision-clan.mjs` provisioning script) to confirm the merged channel
  actually works end to end before this note is updated to say so.

- **First-boot DM setup wizard added (2026-08-26).** `/recruit-setup` always
  created its own fresh channels/roles even when an established clan already
  had an equivalent (most commonly a leaders/officer chat channel and role),
  and nothing told a clan leader `/recruit-setup` even existed — no in-app
  discovery at all. Built `src/recruit/wizard.js`: the moment KRAKEN boots
  for the very first time on a newly-invited server, it DMs the guild owner
  an interactive wizard (Discord select-menu pickers for an existing chat
  channel, leaders chat channel, and leaders role, plus Confirm/Start Fresh
  buttons) instead of requiring them to know a command exists at all.

  Required extracting `handleSetupInner`'s core logic out of `setup.js` into
  `runRecruitSetupCore(guild, { db, recruitConfig, client })` — a
  guild-and-db-driven function callable without a live Interaction, plus
  `formatSetupCompletionMessage(result)` shared verbatim between the slash
  command's reply and the wizard's DM notice. This was necessary, not just
  tidier: the wizard's Confirm button fires from a DM interaction, where
  `interaction.guild` is always `null`, so the original interaction-coupled
  function could never have been called from it. `/recruit-setup` itself is
  now a thin wrapper around the same core — verified byte-identical
  behavior/output, not just "should still work."

  Two real bugs found and fixed during design, before either shipped:
  1. The naive design would have written each dropdown pick directly into
     the *live* `roles.leadersRoleId`/`channels.*` settings the instant it
     was selected. `roles.leadersRoleId` is read live, on every interaction,
     by `isRecruitOpsAuthorized`/`isLeaderOrAdmin` — pre-seeding it before
     Confirm was ever clicked would have instantly granted ops/recruit-leader
     command access to anyone already holding that role, mid-wizard, before
     the owner confirmed anything. Fixed with staging keys
     (`wizard.pendingChatChannelId`/`wizard.pendingLeadersChatChannelId`/
     `wizard.pendingLeadersRoleId`) promoted into the real settings only
     inside the Confirm handler — restart-safe with zero in-memory state,
     since it's just more rows in `recruit_settings`.
  2. `src/index.js`'s existing ops/war component gate had no customId-prefix
     pre-filter — a `wizard:confirm` button click would have fallen into it,
     reduced to `isAuthorized(interaction)` (neither an ops nor war
     customId), which reads `interaction.member?.roles` — undefined in a DM
     — and incorrectly told the guild owner "You do not have the `kraken`
     role required" on their own setup wizard. Fixed with a dedicated
     `wizard:` dispatch branch placed *before* that gate, deliberately not
     keyed on `interaction.guildId` at all (always `null` in a DM, so
     neither that gate nor the recruit-guild boundary above it could ever
     have reached a wizard interaction correctly regardless).

  One design reversal worth recording: the chat-channel adoption picker was
  initially planned to be excluded from the wizard entirely, reasoning that
  locking a clan's real, already-active chat channel to
  `kraken-member`+`leaders` immediately is a guaranteed full-membership
  lockout (nobody can hold `kraken-member` yet — relinking is only possible
  *after* setup has run once). On review, excluding it outright was
  inconsistent with how the leaders-role risk is handled right next to it
  (also real, not hidden — just clearly warned about) — corrected to keep
  the option with the consequence spelled out plainly in the DM's warning
  text, so the owner makes an informed call for their own clan rather than
  the wizard silently deciding for them.

  Verified: syntax + eslint clean across every changed/new file
  (`wizard.js`, `setup.js`, `index.js`, `apply.js`'s now-exported `safeDm`),
  `smoke-wiring.js` extended with 3 new checks (wizard dispatch ordering,
  wizard handler ignoring non-wizard customIds, `runRecruitSetupCore`
  exported) — 9/11 passing, same 2 intentional `PUT_*`-placeholder failures
  as the documented baseline. Also ran the full import chain with temporary
  dummy real-shaped config values (reverted immediately after, confirmed
  clean via `git status`) — this one actually logged into live Discord with
  the real bot token already sitting in this checkout's `.env` and hit a
  clean `ClientReady` with the new wizard code in the startup path, no
  crashes. Not yet exercised against a genuinely fresh guild end-to-end
  (would need `test-provision`'s stored setup state cleared and a restart)
  — that real functional pass is the next step, not assumed done here.

- **Member-chat channel retired; celebrations/weekly summary merged into
  `#kraken-decisions` via two standing threads (2026-08-27).** Live-testing
  the wizard's actual DM (previous entry above) surfaced that its
  chat-channel-adoption warning described a genuine dealbreaker, not just a
  risk worth flagging: adopting a clan's real, already-active chat channel
  locks every current member out of it *immediately* (nobody holds
  `kraken-member` yet at the moment setup completes — relinking is only
  possible after this same run finishes). Investigating whether KRAKEN
  actually needed a dedicated member-chat channel at all found that it
  didn't — grepping every use of `memberChatChannelId`
  (`src/recruit/evaluator.js`, `src/schedule.js`) showed it was only ever a
  place for the bot to *post into* (perfect-war honors, warcore-promotion
  announcements, clan hall-of-fame records, a weekly member summary), never
  something requiring restricted visibility. `#kraken-decisions`
  (`publicDecisionsChannelId`) is always a channel KRAKEN creates and owns
  itself — never adopted from an existing server — so merging this content
  into it removes the lockout risk structurally instead of just re-wording
  the warning around it.

  Doing that naively would have just relocated the "wall of messages"
  problem into `#kraken-decisions`, so the merged content was organized into
  two new standing Discord threads instead of one continuous feed:
  **Celebrations & Records** and **Weekly Summary**, created under
  `#kraken-decisions` by `setup.js`'s new `findOrCreateThreadById` (same
  configured-ID → stored-ID → create-fresh, no-name-matching principle as
  every channel/role in that file). `memberChatChannelId` is retired
  outright — `setup.js` actively clears any previously-stored value on every
  run (same pattern already used for disabling `channels.relinkChannelId`),
  but never touches or deletes the actual Discord channel itself. Decision-
  verdict posts stay in the parent channel exactly where they were — only
  the *new* content being merged in got bucketed into threads.

  While in there, also restyled every post in this surface — decision
  verdicts, celebrations, and the weekly summary — using
  `buildDashboardContainer` (`src/dashboard-components.js`), the Components
  V2 helper already used by 18+ other surfaces in this codebase (`/ops`,
  `/war-board`, season reports, appeal/relink panels). `evaluator.js`'s
  `postCelebration` and `buildRichMemberEmbed` (renamed
  `buildRichMemberContainer`) were raw `EmbedBuilder`s predating this house
  style — migrated to match, including moving the celebration ping out of
  the (Components-V2-incompatible) top-level `content` field and into the
  first content block instead, with `allowedMentions` still explicitly
  allow-listing it so it keeps actually notifying. `buildRichMemberContainer`
  is shared by both the public decisions channel and the leaders-only admin
  logs channel — restyling it changed both surfaces, deliberately, for
  consistency. `schedule.js`'s weekly summary already used
  `buildDashboardContainer` — that one was a pure repoint (`memberChatChannelId`
  → `weeklySummaryThreadId`), no styling work needed. The wizard's DM lost
  its entire first dropdown and warning as a direct result — it now asks
  only 2 questions (leaders chat, leaders role) instead of 3, and ships with
  no chat-channel warning at all, since there's nothing left to adopt.

  Verified: syntax + eslint clean across every changed file (`setup.js`,
  `db.js`, `evaluator.js`, `schedule.js`, `wizard.js`, `welcome-guide.js`),
  a direct module-import test of every changed file confirming clean loads
  with the expected exports (skipped the full `index.js`/live-Discord-login
  path this time — not needed to prove the module graph itself is sound),
  and `smoke-wiring.js` extended with one new check confirming the wizard's
  chat-channel customId/staging key are actually gone — 10/12 passing, same
  2 intentional `PUT_*`-placeholder failures as the documented baseline.
  Config files were reverted to placeholders immediately after the import
  test, confirmed via `git status`. Not yet live-tested against a real
  Discord guild — the next step is resetting `test-provision`'s stored setup
  state and confirming the two new threads actually get created, and that
  `/recruit-eval-now` plus a manually-triggered weekly-summary/celebration
  post render correctly in their new locations with the new look.

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
