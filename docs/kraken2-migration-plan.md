# KRAKEN → KRAKEN2 Migration Plan

**Status:** Reference document. Not a build in progress. Revisit once KRAKEN's current
logic has been running clean for a few more weeks of live testing.

**Premise:** KRAKEN2 is a new project, not a fork. The current codebase is single-tenant
(one clan, one Discord guild, one SQLite file, one `.env`) by design. KRAKEN2 is meant
to serve multiple clans from one deployment. Don't re-derive the business rules from
memory — port the validated logic modules below, and build tenancy/onboarding/billing
as genuinely new work around them.

---

## 1. Hard-won behaviors — do not lose these

These are correctness rules that took a full season of production use plus a multi-pass
audit to get right. None of them were obvious from a single read of the code — they
were found by testing against live data. If KRAKEN2 re-derives this logic from scratch
instead of porting it, expect to rediscover every one of these the hard way.

- **War-day classification priority.** Prefer the stored `warDay` flag captured live
  from the API (`periodType`) → live race state → period-index math → decks-used
  activity that day → anchor-cycle tiebreaker (last resort). Never classify a day from
  cumulative fame — fame lingers across the whole race week and makes post-war training
  days look "active." (`war-cycle.js`)
- **Insufficient-history gate.** Any stat derived from `warParticipationRate` must
  exclude members with `historyDays < 3` or `inGrace`. Without this, the first day or
  two of a fresh tracking window reads as 0% participation for the *entire* clan
  simultaneously — not genuine inactivity, just no data yet. Found and fixed in five
  separate places this session: `analytics.js` (clan health), `schedule.js` (daily +
  weekly reports), `ops.js` (Overview tab, War tab).
- **Restrict participation/fame/deck math to actual war days**, not every tracked
  calendar day. Training days structurally have zero fame (Supercell only pays medals
  on battle days) — including them in the denominator silently deflates
  `warParticipationRate` and inflates `deckMissRate` for every member regardless of real
  performance. (`promotions.js`, `policy.js`'s `summarizeWindow`)
- **`seriesForTag` can return fewer rows than the requested `dayKeys`** (a member with
  a gap day — e.g. left and rejoined — has no snapshot row for that date). Always key
  subsequent per-day lookups off the row's own `.day` field, never assume the row at
  index `i` corresponds to `dayKeys[i]`.
- **Fame delta must be a true per-day delta**, not `max(cumulative, diff)`. Passing the
  cumulative series as its own fallback collapses the "delta" into summing the running
  totals instead (900+1800+2700+3600 instead of 900×4). First day keeps its cum-to-date
  value since there's no prior day to diff against; a negative diff means the race week
  reset the counter.
- **CR API failure classification.** Only HTTP 429/5xx should trip the circuit breaker
  — those are real upstream-health signals. A 404/400 (bad player/clan tag) is a caller
  input error and must not contribute to opening the breaker for everyone.
- **A break shields a member from tier evaluation, not from clan-membership sync.** If
  someone verifiably left the clan while on an active break, offboard them anyway —
  don't let the break silently mask their departure.
- **Underwatch/probation streaks must pause, not reset or keep accruing,** while a
  member is on an active break. "Break days don't count against you" cuts both ways —
  it doesn't clear a bad streak either.
- **Suppress the manual-role-sync listener before any bot-initiated role change.** The
  bot reactively watches for leader-driven role changes on `GuildMemberUpdate` to detect
  manual overrides; without suppression, every bot-initiated role write would
  double-process itself through that same listener.
- **WAL-mode SQLite needs an explicit `wal_checkpoint(TRUNCATE)` before any raw
  file-copy backup.** Recent writes live in a separate `-wal` file until checkpointed —
  a naive `fs.copyFileSync` can silently miss them.
- **`player_tag` is stored without a leading `#`, everywhere, no exceptions.** A single
  query that added one (`/recruit-history`) silently never matched anything and always
  showed "unlinked."
- **Key history buckets by Supercell period, not calendar date.** KRAKEN's UTC-date
  buckets don't align with Supercell's real period rollover (~09:40 UTC / 7:40 PM
  Sydney observed), so a snapshot taken at the flip files the just-ended war day's
  final totals into a bucket flagged with the *new* period's type — leaking the last
  stretch of war play into a training bucket and silently capping daytime players
  below 32/32. KRAKEN patches this with a "finalize yesterday" merge at each detected
  transition (`mergeMembersIntoDay`); KRAKEN2 should eliminate the class entirely by
  making the period itself (e.g. `periodIndex`) the bucket key.

---

## 2. File-by-file inventory

### Port as-is (pure logic, no DB/Discord/tenant coupling)

| File | Why it's safe to carry over |
|---|---|
| `util.js` | Pure helpers — tag parsing, date math, participation rate. Zero coupling. |
| `war-cycle.js` | The whole war-day classification cascade. Operates on plain `race`/`history` objects passed in. This is the single highest-value file to preserve exactly. |
| `recruit/policy.js` | `summarizeWindow`, `evaluateWarTierPolicy`, the perfect-32/32 thresholds. Pure given `history`/`tag`/`dayKeys`/`currentTier`. Just had two real bugs fixed this session (day-index misalignment, fame cum-sum) — port the fixed version. |
| `analytics.js` | `calculateClanHealth(members, history, scored)` — pure given its inputs. Carries the insufficient-history gate fix. |
| `risk-score.js` | `computeHistoryWeightedRisk` — pure given `history`/`members`/options. |
| `discipline.js` | Streak-tracking logic, no external coupling. |
| `war-intel.js` | `buildMemberIntel`/`extractRaceMeta` — pure transforms of raw CR API responses. |
| `security.js` | Error sanitization/formatting helpers. |
| `audit.js` | Trivial console logger. |

### Port with light rework (real logic, minor coupling to unwind)

| File | What needs to change |
|---|---|
| `promotions.js` | `classifyPlayers` calls `loadHistory()` internally instead of receiving it as a param — make it an argument like `policy.js` already does. Otherwise pure. Carries this session's war-day-filtering fix. |
| `cooldown.js` | In-memory, keyed by user ID — check whether cooldowns should also key by tenant (probably not, since they're per-user, but verify no cross-tenant bleed in a shared process). |
| `validation.js` | `sanitizeErrorMessage`/rate-limit helpers are portable; `validateEnvironmentConfig` is single-tenant-shaped and needs a rethink. |

### Port with real rework (correct decision logic, single-tenant wiring)

| File | What's staying | What's changing |
|---|---|---|
| `recruit/evaluator.js` | Per-member tier decisions, break-expiry escalation, offboarding rules, at-risk warnings — all validated, all correct. | The outer loop currently evaluates one clan; needs to iterate registered tenants, resolving each one's config/DB/history. |
| `ops.js` | Every stat calculation (health, war summary, deck%, risk) — including all five history-gate fixes from this session. | Pagination state, channel/guild resolution, and command wiring assume one guild throughout. |
| `schedule.js` | Daily/weekly report aggregation and embed building — including this session's three fixes. | `CLAN_TAG`/channel-ID env reads and the single global `lastDailyReport`/`lastWeeklyReport` timestamps need to become per-tenant. |
| `recruit/breaks.js` | Break request/approval/expiry state machine. | Channel/panel management needs tenant scoping. |
| `recruit/waitlist.js` | Queue/ping/expiry logic. | Tenant scoping. |
| `recruit/manual-role-sync.js` | Manual-override detection logic. | Runtime role-ID lookup needs tenant scoping. |
| `recruit/onboarding.js` | Welcome-post logic. | Channel resolution + tenant scoping; the welcome image asset path is currently a fixed local file. |
| `cr-api.js` | Fetch wrapper, circuit-breaker integration, endpoint functions. | `getClan(tag = process.env.CLAN_TAG)`-style defaults need to go — every call becomes tenant-explicit. |
| `circuit-breaker.js` | Sliding-window failure tracking, fail-fast logic. | Currently one global breaker state — needs to key by tenant/clan-tag so one clan's API trouble doesn't throttle everyone. |
| All `recruit/commands/*.js` | Auth checks, field semantics, messaging — all sound. | `ctx.recruitConfig`/`ctx.db`/`ctx.runtime` need to resolve from a tenant lookup instead of one global config. `setup.js` is the interesting one — it already does dynamic per-guild role/channel creation, so it's the closest thing to an onboarding flow that exists; it mainly needs its writes redirected to tenant-scoped storage instead of one flat settings table. |
| `recruit/messages.js` | The tone/voice is a real product feature. | *(Resolved in the kraken-clan-template project via a different, simpler architecture than this doc describes — see that project's CLAUDE.md.)* The unused `landingMessage` export was dead code and removed; `welcomeMarkdown` became `buildWelcomeMarkdown(clanName)`, taking the clan name as a parameter instead of hardcoding it, while keeping KRAKEN's fixed brand voice for everything else. |

### Rebuild (the actual multi-tenancy work)

| File | Why it can't just be ported |
|---|---|
| `recruit/db.js` | Every table needs a tenant_id column (composite key with `discord_id` where relevant). `recruit_settings`'s flat keys (`roles.warcoreRoleId`) would silently collide across tenants sharing the table today — this is the one that actually breaks if skipped. Function-level semantics (what "clear underwatch state" does) stay the same; the schema and every call site's parameters change. |
| `history.js` | The in-memory shape (`{firstSeen, days: {day: {members: {tag: {...}}, warDay, periodType}}}`) is sound and every consumer already takes it as a plain parameter — so the fix is "scope the storage layer per tenant," not "redesign the shape" (see the per-tenant-file lean in §3). While touching this file, also switch its writer to atomic temp-file+rename — flagged separately in §3 as a gap worth fixing regardless of tenancy model. |
| `config/loadConfig.js` | Static JSON files → per-guild config (a row in `master.db`'s tenant registry, or its own per-tenant file if going the per-tenant-file route) populated through onboarding instead of hand-edited files. Needs to carry `CLAN_TAG` per guild too — that mapping doesn't exist anywhere today. |
| `permissions.js` | `isAuthorized()` is env-var role-gating today. Multi-tenant means each guild sets its own admin/leader role — becomes DB-driven. |
| `index.js` | The entire bootstrap/event-routing layer. Becomes "resolve tenant from this guild ID on every event" instead of "load one config at boot." |
| `recruit/index.js` | Command router — same shape conceptually, but every dispatch needs tenant resolution baked in. |
| `env.js` | Bot-level secrets (Discord token, CR API token) still come from env/secrets manager; per-tenant config does not. |

### Don't port

| File | Why |
|---|---|
| `metadata.js` | `addWarning`/`addNote`/`addMilestone` were already dead code in KRAKEN (confirmed via grep, never called) — the `📝{warnings}/{notes}` counter in `/ops` always reads 0/0. Either drop it or build it properly this time. |
| `war-scheduler.js` | Empty stub ("River race reminders disabled"). |
| `scripts/full-clan-reset.js` | A single-tenant terminal maintenance script. The *concept* (wipe all state, reset roles, backup first) belongs in KRAKEN2 as a proper in-app admin action scoped to one tenant, not a standalone script. |
| `scripts/season-reset.js` | Routine season rollover (posts the outgoing season's report, rolls the season boundary, keeps history intact). Same porting note as above — belongs as an in-app admin action, not a standalone script. |

---

## 3. Open questions to resolve before starting

- **Supercell CR API ToS** for a commercial token used across multiple clans/customers —
  flagged earlier, not yet checked. Cheap to verify now, expensive to find out about
  after customers are paying.
- **Storage choice for `history.js`'s data**: N per-tenant JSON files (minimal rewrite,
  keeps the exact in-memory shape) vs. a proper relational table (cleaner long-term
  given the DB is being reworked anyway, but a bigger structural change to every reader).
- **SQLite-per-tenant-file vs. one shared Postgres/MySQL with `tenant_id` columns —
  leaning per-tenant-file as the starting architecture.** It needs zero schema changes
  and zero query rewrites in `db.js`/`history.js` — every existing query stays exactly
  as-is; only the *path* passed to `new Database(...)` / `loadHistory()` changes per
  guild (`./data/guilds/[guildId]/kraken.db`, `.../history.json`, `.../discipline.json`).
  That shrinks "rebuild `db.js`" from a full schema/query rewrite down to a path-routing
  layer, which fits the "validate demand with a handful of clans before investing in the
  bigger rework" plan. Two things this *doesn't* solve on its own, still open below:
  per-tenant static config, and where a guild's `CLAN_TAG` gets stored. Real tradeoff to
  accept: cross-tenant admin queries ("members across all rented clans") mean opening N
  files instead of one `WHERE guild_id` — a non-issue at "a handful of clans," a real
  limitation if this ever grows into a large SaaS.
  - **Needs, regardless of which side wins:** validate `guildId` against
    `/^\d{17,20}$/` before it ever touches a file path or directory name — it's the
    same discipline `isValidDiscordId` already applies everywhere in KRAKEN, just
    extended to a risk surface (path construction) that doesn't exist in the current
    single-tenant design. And an in-memory `guildId -> dbInstance` connection cache
    with an idle-timeout sweep — opening/closing a SQLite handle per interaction is
    real disk I/O overhead; holding hundreds open forever leaks file descriptors.
- **Licensing/subscription gate — no design existed for this before; sketch one out.**
  A single new `data/master.db` (or a table in whatever tenant registry exists) with
  `guild_id | owner_id | status | expires_at`, checked once at the top of every
  interaction before any tenant data loads. Simple enough to build alongside the tenant
  data layer rather than bolt on later. Needs a `clan_tag` column too (or equivalent) —
  nothing in the current schema maps a guild to its Clash Royale clan; that mapping has
  to live *somewhere* central since every tenant's `CLAN_TAG` today is one hardcoded
  env var.
- **`history.js`'s JSON writes aren't atomic today, and that's worth knowing about
  independent of KRAKEN2.** `writeJson` is a plain `fs.writeFileSync` — a crash mid-write
  leaves `history.json` corrupted, no temp-file-then-rename swap. Single-tenant KRAKEN
  gets away with it (one process, low odds of hitting the exact crash window); it's a
  real, currently-existing gap, not just a multi-tenant concern. KRAKEN2 should build
  every JSON writer with a temp-file + `fs.renameSync` swap from day one, since
  concurrent tenant writes make the low-odds window come up far more often.
- **Brand voice**: does every clan get KRAKEN's "ancient sentinel of war discipline"
  tone, or does `recruit/messages.js` become a per-tenant template?

---

## 4. Suggested build order

1. Settle the remaining open questions above (per-tenant config shape, `CLAN_TAG`
   storage, brand voice, CR API ToS) — the DB-vs-file choice is no longer one of them
   (leaning per-tenant-file, §3).
2. Build the tenant registry (`master.db`: subscriptions + guild→clan_tag mapping),
   the path-routing layer (`guildId` → that tenant's `kraken.db`/`history.json`/
   `discipline.json`, with the `/^\d{17,20}$/` validation and connection-cache
   guardrails from §3), and the onboarding flow — proven against a single fake tenant
   before anything else.
3. Port the pure-logic modules (§2, table 1) verbatim — these should need zero changes
   beyond the import path.
4. Port the "real rework" tier (§2, table 3) one file at a time, starting with
   `cr-api.js` + `circuit-breaker.js` (small, well-isolated, everything else depends on
   them), then `recruit/db.js`/`history.js` (now a path-routing change, not a schema
   rewrite — fix the atomic-write gap while in there), then `evaluator.js` last since
   it's the most complex consumer of everything below it, including the per-tenant
   rate-limited iteration its background loop needs (§3).
5. Re-run the same kind of live-data verification used throughout KRAKEN's audits —
   synthetic edge-case tests (gap days, race resets, zero-history members) plus a real
   sanity pass against actual clan data — before trusting any ported stat.
