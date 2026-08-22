# 🐙 KRAKEN Features

A tour of what KRAKEN actually does today, organized by subsystem. For exact
per-command usage (options, permissions, channel restrictions), see
[docs/commands.md](docs/commands.md) — that file is the authoritative
reference; this one is the readable overview.

## Core commands (main clan server)

**`/ops`** — the main dashboard, four tabs:
- **Overview** — clan health score (0-100, graded A-F), member list, activity summary
- **War** — river race standings, deck usage, per-member war stats
- **Donations** — donation counts/ratios across 1/7/14-day windows
- **Actions** — promotion/demotion recommendations, discipline flags, reward candidates, plus a player drilldown with **Add Warning** / **Add Note** buttons

**`/war`** — standalone pull-out of the War tab, for a quick mid-war check without opening the full dashboard. Same underlying data as `/ops`'s War tab, plus a quick read on how tier decisions are shaping up (promote/watch/underwatch/boot counts) without the full panel.

## Tier/discipline automation

- Weighted risk score per player: war participation 60%, deck usage 25%, donations 10%, inactivity penalty, plus a recent-zero-days penalty
- Grace period (default 7 days from first-seen): can be promoted, never demoted or kicked while in grace
- Repeat-offender detection: 2+ bottom-list appearances in a 14-day window, only counted outside grace
- Promotion thresholds: Member→Elder needs ≥90% participation, ≤10% deck-miss, ≤15% risk; Elder→Co-Leader needs ≥95%/≤5%/≤10%
- Demotion thresholds: Co→Elder at ≥55% risk or <60% participation or repeat offender; Elder→Member at ≥65% risk or <50% participation or repeat offender
- Kick candidates: ≥85% risk, or 14+ days inactive, or repeat offender with ≥75% risk
- Boat attacks and repair points tracked as explicit discipline signals, separate from the risk number
- Every recommendation ships with 3-6 specific reasons, never a bare score
- Recruit HQ's own tier ladder (probation → warcore → underwatch → boot review) runs on the same rolling 7-day/14-day windows, evaluated automatically — never manual

## Recruit HQ — application & roles

- `/apply` (or "Agree & Join" button): verifies tag against the live clan roster, grants `kraken-member` + `probation` instantly, DMs a two-part welcome guide, 24h cooldown between attempts
- On Discord join (before applying): auto-tagged `new-arrival`; if the clan's at its 50-cap, also queued on the waitlist
- Waitlist: weekly check-in DM with a 48h window (no response = removed + role stripped), slot offers go to the longest-waiting person automatically when a spot opens, applying clears it immediately
- `/status` — self-check of current tier, break status, cooldowns (ephemeral, self only)
- `/help` — role-aware command list: a member sees member commands, a leader additionally sees leader tools, the owner additionally sees owner-only tools. A member's response never contains leader/owner content — it's excluded from what's built, not just hidden by formatting
- `/standings` — leader-only, full paginated decision board (stable/watch/underwatch/boot/hold), coverage/integrity checks (unlinked roster members, orphaned profiles, invalid tags), OPS-risk alignment so it never disagrees with the nightly evaluator

## Break system

- Self-service 7/14/30-day breaks via a panel button, pauses tracking with zero penalty
- "I'm Back" ends early and resumes exactly where it left off
- Day-before reminder DM, day-of warning DM if not returned, escalation to underwatch only after at least one full completed war day of inactivity post-expiry (not immediately)
- Underwatch/probation streak clocks pause (not reset) while on break

## Appeals

- `/recruit-appeal` or the panel button, 800-char reason, 7-day cooldown
- Posts to a leader-only channel with Overturn/Keep Decision buttons
- Atomic claim on resolution (a second leader clicking gets "already resolved," not a double-processed appeal)
- Resolved appeals are deleted from the live channel, kept permanently in the audit-log channel

## Emergency / moderation commands

- `/recruit-remove-member` — leader-only kick, requires Kick Members permission (opt-in, off by default), clears all tracking state before the kick fires, offers the freed slot to the next waitlist entry
- `/recruit-ban-member` — same pattern, Ban Members permission (also opt-in/off by default), explicit `deleteMessageSeconds: 0`
- `/recruit-add-member` — leader override to manually add someone outside the normal apply flow, hard-verifies the tag against the roster first
- Every one of these posts a permanent record naming the leader and the reason

## Warnings & notes

- **Add Warning** / **Add Note** buttons on `/ops`'s actions-tab drilldown, modal-based text entry
- Stored in `kraken.db` (`player_warnings`/`player_notes` tables, keyed by player tag — the same store as every other player-state table, not a separate file), with a timestamp and who issued it
- Surfaced as a count on the drilldown card and folded into the action-queue reasons

## Hall of Fame

- Three shared records: Top Donor, War Champion, Iron Attendance — longest streak at #1, minimum 4 consecutive war weeks to qualify
- Announced only when a record actually changes hands, never repeated
- If a record holder leaves the clan, it reverts to the most recent prior holder still in-clan, or clears — logged, not announced publicly

## Grace / continuity protections

- New-joiner tracking grace, separate from the break system, tied to `GRACE_DAYS`
- Server-leave grace: leaving Discord while still genuinely in the clan grants an automatic 7-day break instead of removal; leaving while actually gone from the clan marks removed immediately
- On return: tier role restored from stored profile status automatically, no reapplying

## Automated background jobs (no command needed)

- Daily evaluator: polls the live API every 10 minutes, fires the moment the real war-day/period actually rolls over (not a guessed clock), plus a 24h safety-net catch-up
- Role review fires exactly once per completed war week, on the first training day after it closes
- At-risk DM warnings for members under 50% deck completion, rate-limited to once per 4 days
- Break expiry reminders (day-before + day-of), rate-limited per break period
- Waitlist weekly check-ins and 48h expiry sweep
- Daily report of clan-roster members with no KRAKEN profile at all (dedup'd, never repeats the same tag)
- Daily clan activity report + Sunday weekly promotion/demotion summary, posted automatically
- Panels (welcome, break, appeals, waitlist) self-heal on startup and `/recruit-setup` if missing or deleted

## Season & history

- `/recruit-history` — season-by-season table per player (current + up to 3 archived seasons), 10-min cache
- `/recruit-season-report` — posts current-season top-5 (fame/wars-played/donations) on demand, read-only
- `/recruit-season-reset` — posts the final report and rolls to a new season, guarded against double-rolling the same month, backs up history before mutating
- Full history keeps accumulating across season boundaries — nothing gets wiped, just re-scoped

## Setup & admin

- `/recruit-setup` — one command builds every channel/role/permission; safe to re-run; adopts existing channels/roles only by stored ID or explicit config, never by guessing names (so it can't collide with anything already on a populated server)
- Leaders can pre-point KRAKEN at already-existing roles/channels via config before first setup, instead of getting duplicates
- `/recruit-settings` — adjust expected-decks-per-war-day live, no restart
- `/recruit-eval-now` — true dry-run preview of the evaluator, zero side effects
- `/recruit-decisions-reset` / `/recruit-break-reset` — purge + repost the public decisions/break channels, confirm-gated, logged

## Reliability & security

- Circuit breaker on the CR API — only 429/5xx trip it, not bad-tag 404s; auto-cools down
- TTL caching (clan/player/race data) to avoid hammering the API
- Atomic file writes everywhere (temp file + rename) so a hard kill mid-write can't corrupt `history.json`/`discipline.json`
- Cross-process file lock for season rollovers and routine snapshots, with stale-lock self-recovery
- Daily gzip'd backup of the DB (WAL-checkpointed, not a raw copy) + history + discipline files, uploaded to a private channel, 30-day retention
- Every Discord role mutation is verified against the actual resulting role cache, never assumed to have worked
- discord.js client-level error handling so a transient websocket blip can't crash the whole bot
- Fully isolated per-clan deployment — own bot token, own database, nothing shared between clans

---

For setup instructions, see [SETUP.md](SETUP.md)
For security details, see [SECURITY.md](SECURITY.md)
For the current command reference, see [docs/commands.md](docs/commands.md)
