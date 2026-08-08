# KRAKEN Bot — Command Reference

Commands are guild-scoped. Recruit commands only appear in **Recruit HQ**; `/ops` appears in both servers.

---

## `/ops` — Main Command Center

**Available in:** Main clan server + Recruit HQ (leaders only)
**Who can use:** Anyone with the `kraken` role (main server) or the `leaders` role (Recruit HQ)

The single entry point for all clan management. Opens an interactive panel with four tabs:

| Tab | What it shows |
|---|---|
| **Overview** | Clan health score, member list, activity summary |
| **War** | Current river race standings, deck usage, per-member war stats |
| **Donations** | Donation counts and ratios across configurable windows (1 / 7 / 14 days) |
| **Actions** | Promotion/demotion recommendations, discipline flags, reward candidates |

Use the dropdown and buttons inside the panel to navigate pages and switch tabs.

---

## Recruit Commands

All recruit commands only work inside **Recruit HQ** (guild ID set in `config/recruit.config.json`).

---

### `/apply`

**Who can use:** Any member of Recruit HQ
**Channel:** Anywhere in Recruit HQ (also triggered by the "Agree & Join" button in #welcome)

Submits your Clash Royale player tag to begin tracking.

- Verifies the tag is currently in the KRAKEN clan roster
- Grants `kraken-member` + `probation` roles immediately
- Starts war performance tracking for the automated weekly review
- DMs the full two-part welcome guide (roles, Hall of Fame, tools, feedback) on success; falls back to a short DM if DMs are blocked
- Has a 24-hour cooldown between applications

**Option:** `tag` — your player tag with or without `#` (e.g. `#ABC2YGV`)

---

### `/status`

**Who can use:** Any member of Recruit HQ
**Channel:** Anywhere in Recruit HQ

Shows your current tier and any active flags (only visible to you).

Displays one of:
- Your current tier (`probation`, `warcore`, `underwatch`, etc.)
- Whether you are on an active break and when it ends
- Whether you are in a re-application cooldown period

---

### `/standings`

**Who can use:** Leaders / Admin only
**Channel:** Recruit HQ (ops channel)

Posts a live war decision board for all tracked recruits, grouped by the action each member needs.

- Pulls current river race data from the Clash Royale API
- **Severity colour**: red if anyone is in boot review, amber if anyone is on the underwatch/watch path or there are linkage gaps, green when all clear
- **Count strip** at the top: stable / watch / underwatch / boot / hold totals at a glance
- **Coverage grid**: clan roster vs Recruit HQ size, linked vs not-linked, and members on break / in grace
- **Decision buckets**, each member shown with their recommendation, decks used, missed war days, and a short reason:
  - ✅ Safe / Keep Stable
  - 👀 Needs Watching
  - ⚠️ Underwatch Path
  - ⛔ Boot Review — Remove Role (shown separately so removal candidates aren't missed)
  - ⏸️ On Hold (members on a break or inside their grace period)
- **OPS-risk alignment**: warcore members whose OPS risk score will trigger a demotion are flagged here exactly as the evaluator will act on them, so the board never disagrees with the nightly eval
- **Integrity checks**: clan members not yet linked, tracked profiles that left the clan, server members without a profile, and invalid stored tags
- Uses the same `EXPECTED_DECKS_PER_DAY` setting and policy logic as `/ops` and the automated evaluator
- Useful for mid-war checks before automated eval fires

---

### `/recruit-add-member`

**Who can use:** Leaders / Admin only
**Channel:** Recruit HQ (ops channel only)

Leader override — manually add any Discord member to the clan on probation, bypassing the normal self-service `/apply` flow.

**Options:** `player` (Discord member to add) · `tag` (their Clash Royale player tag)

- Hard-verifies the tag is currently in the clan roster (same check `/apply` uses) — blocks if not found, so the leader adds them in-game first
- Blocks if the tag is already linked to a different Discord account
- Grants `kraken-member` + `probation` roles immediately and creates/resets their profile to a clean probation state (any old tracking state — trial ledger, breaks, underwatch — is cleared)
- If the target was on the waitlist, clears their waitlist role and DB entry automatically; works fine if they weren't on the waitlist at all
- DMs the member that a leader added them; posts a permanent decision record to the admin logs/decisions channel naming the leader who did it
- Sends the same welcome guide DM as `/apply` on success
- This is a trust-the-leader override: no cooldown, no blacklist check — use it deliberately

---

### `/recruit-remove-member`

**Who can use:** Leaders / Admin only
**Channel:** Anywhere in Recruit HQ (deliberately not restricted to the ops channel — this is an incident-response tool, a leader shouldn't have to switch channels to use it)

🚨 **Emergency leader override** — immediately kicks a member from the Discord server and marks them removed in KRAKEN. No grace period, no clan-status check, no benefit of the doubt — this is for "get them out now" situations.

**Options:** `player` (Discord member to remove) · `reason` (required, logged)

- Marks the profile `removed` and clears all tracking state (breaks, underwatch, probation, post-break enforcement, waitlist) **before** the kick fires — this is what makes it skip the normal soft 7-day grace period a regular server-leave gets
- Kicks the member from Discord (not a ban — they can rejoin immediately with a new invite)
- Does **not** touch the Clash Royale clan roster — KRAKEN cannot kick from the in-game clan (no API access for that), so remove them there separately if needed
- If the clan currently has space, the freed spot is offered to the next person on the waitlist
- Posts a permanent record to the removal-queue/logs channel naming the leader and the reason, for accountability
- Requires the bot to have **Kick Members** permission in the server

---

### `/recruit-eval-now`

**Who can use:** Leaders / Admin only
**Channel:** Recruit HQ (ops channel)

Manually triggers the recruit evaluator in **safe/manual mode**.

- Runs all the same tier logic as the automated daily eval
- Does **not** make real changes: no role updates, no DMs sent, no removal flags, no daily-run stamp
- Reports what the evaluator would decide for each member right now
- Use this to preview upcoming decisions or debug a member's standing mid-week

---

### `/recruit-decisions-reset`

**Who can use:** Leaders / Admin only
**Channel:** Anywhere in Recruit HQ

Purges the decisions channel and posts a fresh pinned rules embed.

- Bulk-deletes all messages in the configured public decisions channel
- Posts and pins a rich embed covering all 5 tiers (Probation, Warcore, Underwatch, Boot Review, On Break) with promotion/demotion rules
- Clears the tracked weekly message history so the next eval posts cleanly
- Use this when the channel gets cluttered or after a server restructure

---

### `/recruit-break-reset`

**Who can use:** Leaders / Admin only
**Channel:** Anywhere in Recruit HQ

Purges the on-a-break channel, clears all active break records from the database, and posts a fresh pinned info embed and break panel.

- Bulk-deletes all messages in `#on-a-break`
- Clears every active break entry from the DB
- Posts and pins the info embed (explaining how breaks work) followed by the break panel (7 / 14 / 30-day buttons)
- Logs the reset permanently to the admin logs channel, including who ran it and how many breaks were cleared
- ⚠️ Does **not** automatically remove the `on a break` role from affected members — leaders must do that manually

Use this when the channel gets cluttered, after a server restructure, or to force a clean slate at the start of a new season.

---

### `/recruit-setup`

**Who can use:** Server owner or Admin only
**Channel:** Anywhere in Recruit HQ

One-time setup command that wires up the entire Recruit HQ server.

- Creates or finds all required channels: `#welcome`, `#kraken-decisions` (public summary), `#kraken-decisions-leaders` (private log), `#on-a-break`, `#kraken-ops`, `#logs`, `#removal-queue` — the leaders-only channels are grouped under a "leaders" category
- Creates or finds all required roles: `probation`, `new-arrival`, `kraken-member`, `kraken-warcore`, `kraken-underwatch`, `on a break`, `remove`, `leaders`
- Sets correct permissions on every channel (members read-only, bot can post, leaders can post)
- Stores all channel and role IDs in SQLite (`kraken.db`) for the evaluator and other systems to use
- Posts/pins the welcome panel in `#welcome` and the break panel in `#on-a-break`

Run this once when setting up a new server. Safe to re-run — it refreshes IDs without breaking existing data.

> Note: `#appeals` and `#waiting-list` channels and the `waitlist` role are **not** created by `/recruit-setup` — they were added manually and their IDs are stored directly in `config/recruit.config.json` (`channels.appealsChannelId`, `channels.waitingListChannelId`, `roles.waitlistRoleId`).

---

### `/recruit-appeal`

**Who can use:** Any member of Recruit HQ
**Channel:** Anywhere in Recruit HQ

Slash-command fallback for submitting an appeal against a KRAKEN tier decision (probation/underwatch/removal). Same flow as clicking **Submit Appeal** on the appeals panel — see below.

**Option:** `reason` — what you're appealing and why (required, max 800 chars)

**Cooldown:** one appeal per 7 days per member.

---

### `/recruit-settings`

**Who can use:** Leaders / Admin only
**Channel:** Anywhere in Recruit HQ

View or change recruit policy settings stored in SQLite.

- `/recruit-settings view` — shows current settings (currently: expected decks per war day)
- `/recruit-settings set-decks-per-day value:<1-10>` — changes the expected decks-per-war-day used by the evaluator, `/ops`, and `/standings`. Takes effect on the next eval/refresh, no restart needed.

---

### `/recruit-history`

**Who can use:** Leaders / Admin only
**Channel:** Anywhere in Recruit HQ

Season-by-season war performance table for one tracked player.

**Option:** `tag` — player tag with or without `#`

Shows a table (current season + up to 3 archived seasons) of war days, decks used vs. expected, missed war days, and participation %, plus the player's current linked status. Archive data is cached for 10 minutes.

---

## Interactive Panels (not slash commands)

These are triggered by clicking buttons in the server, not by typing a command.

### Welcome panel — "Agree & Join" button (`#welcome`)

Opens a modal asking for your Clash Royale tag. Submitting it runs the same flow as `/apply`. This is the primary entry point for new recruits. Successfully applying also clears any waitlist entry (role + DB row) the member had.

### Break panel (`#on-a-break`)

| Button | Who | What it does |
|---|---|---|
| **Request a Break** | Any member | Opens a modal to set break duration; grants `on a break` role and pauses war tracking |
| **I'm Back** | Member on break | Ends the break early, removes `on a break` role, resumes tracking. Records the return time so the 21-day between-breaks cooldown counts from the actual return, not the original scheduled end. |
| **Acknowledge** | Leaders only | Confirms a break request in the leader view |

### Appeals panel (`#appeals`)

| Button | Who | What it does |
|---|---|---|
| **Submit Appeal** | Any member | Opens a modal for a reason; posts a pending-appeal embed to `#appeals` with **Overturn Decision** / **Keep Decision** buttons for leaders. Cooldown: 1 per 7 days. |
| **Overturn Decision** / **Keep Decision** | Leaders only | Opens a modal for a note to the member. Submitting it atomically claims the appeal (a second leader clicking gets "already resolved"), deletes the pending-appeal message from `#appeals`, logs the outcome to the admin logs channel, and DMs the member with the leader's note. |

Resolved appeals are never left sitting in `#appeals` — they're deleted from the channel and only survive in the permanent logs channel.

### Waitlist panel (`#waiting-list`)

| Button | Who | What it does |
|---|---|---|
| **Still Interested** | Any member on the waitlist | Resets their 7-day check-in timer. Anyone not currently on the waitlist gets an ephemeral "you're not on the waitlist" reply. |

---

## Waitlist System

Handles new arrivals when the clan is full (or a player joins the Discord before joining the clan).

- **On join** (`GuildMemberAdd`, for anyone without an existing non-removed profile): auto-assigned the `waitlist` role — and **only** that role, so it never interferes with KRAKEN's tier tracking — added to the waitlist DB table, and DMed one of two messages based on a live clan-capacity check:
  - Clan full → "you're on the waitlist, we'll DM you when a spot opens"
  - Clan has space but they haven't joined in-game → "join the clan first, then apply here"
- **Slot opens** (a tracked member is confirmed to have left the clan): the longest-waiting person is atomically claimed off the queue, DMed that a spot is theirs, has the `waitlist` role stripped, and the offer is logged to `#waiting-list` and the admin logs channel.
- **Weekly check-in**: every waitlist member is DMed 7 days after joining (or after their last confirmation) asking if they're still interested, with a 48-hour window to click **Still Interested**. No response in time removes them from the waitlist and strips the role automatically.
- **Applying clears the waitlist**: successfully running `/apply` (or relinking) removes the waitlist role/DB row immediately — no need to wait for a check-in cycle.

---

## New-Joiner Grace Period (tracking)

Separate from the server-leave grace break above. Controlled by `GRACE_DAYS` in `.env`.

- **During training days** before war starts: recently linked members stay in grace — held on `/standings`, OPS weak-range demotions suppressed, risk softened.
- **When war goes live**: grace ends for everyone already in the clan at war start (including after a season reset — `trackingEpoch` in `history.json` prevents a restamped roster from being held in grace).
- **Mid-war joiners**: members whose `firstSeen` is after the first war day of the current week keep grace until their window expires.
- Grace never stops snapshot tracking — it only affects judgment holds and OPS/eval overrides.

---

## Clan Hall of Fame (automated)

Three shared clan records, one holder each, announced in member chat **only when a record moves** (min. 4 consecutive war weeks):

| Record | Metric |
|---|---|
| Top Donor | Longest run as #1 clan donor |
| War Champion | Longest run as #1 war performer |
| Iron Attendance | Longest run with zero war days missed |

When a holder leaves the clan, the record reverts to the most recent prior holder still in clan, or clears until someone sets it again. Reverts are logged to the admin logs channel (not posted to member chat).

---

## Server-Leave Grace Period

Handles members who leave the Recruit HQ Discord server while still tracked.

- **On leave** (`GuildMemberRemove`, for anyone with a non-removed profile): KRAKEN checks the live clan roster.
  - **Still in the clan** → a 7-day grace break is granted automatically (reason: `left-server-auto`). This works exactly like a self-service break — it shields the member from evaluation — but if they never come back, it does **not** wait for war evidence to escalate: the offense is not returning, so it escalates to Underwatch the moment the 7 days expire.
  - **Confirmed not in the clan** → the profile is marked removed immediately, all tracking state is cleared, and the freed clan spot (if any) is offered to the next person on the waitlist.
  - If the clan roster can't be verified (API failure), KRAKEN defaults to the safe path (grace break) rather than risking a false removal.
- **On return** (`GuildMemberAdd`, for a member with an existing non-removed profile — skips the waitlist flow entirely): tier roles are restored from their stored profile status (`warcore` / `probation` / `underwatch`), any grace break is cleared, and they're DMed a welcome-back message. If they still have an active *regular* break running, the `on a break` role is restored instead and they're told the break is still counting down.
- **If a member on any kind of break is later confirmed to have left the clan itself** (not just the server), the break no longer shields them — they're offboarded on the next daily eval rather than waiting for the break to expire.

---

## Automated Behaviour (no command needed)

These fire on a schedule without any user action:

| Event | When | What happens |
|---|---|---|
| **Daily eval** | Polls the live API `periodIndex` every 10 min and fires **the moment Supercell's real day/period rolls over** (observed ~7:40 PM Sydney), plus once at startup (offline catch-up) and a 24 h safety-net run if no transition is ever detected. Role review fires on the first training day after each war week closes. | Refreshes the war snapshot, reviews all tracked members, applies tier changes, posts weekly decisions embeds, DMs affected members, logs permanently to admin logs channel |
| **At-risk warnings** | Each active war day | DMs members with <50% deck completion and 2+ war days tracked; rate-limited to once per 4 days per member |
| **Break expiry reminders** | Daily | Day before break ends: friendly reminder DM. On the day break expires (if no I'm Back / no return to the server): warning DM. Message wording differs for a self-service break vs. a server-leave grace break. If still no return, member is moved to Underwatch for leader review. Rate-limited per break period. |
| **Post-break escalation to Underwatch** | Daily, after break expiry | **Regular breaks**: escalate only after at least one *completed* war day has passed since expiry with zero war activity (so a break ending mid-training-week isn't unfairly judged, and a war day still in progress can still be played). **Server-leave grace breaks**: escalate immediately on expiry — the offense is not returning, war timing is irrelevant. |
| **Waitlist weekly check-in / expiry** | Daily | DMs anyone 7+ days since joining/confirming who hasn't been pinged yet this cycle; removes anyone pinged 48+ hours ago with no confirmation. |
| **New clan joiners report** | Daily (every eval tick, not just review days) | Posts a list of clan-roster members with no KRAKEN profile at all — no way to tell whether they're sitting in Recruit HQ unlinked or not on Discord at all, so it covers both. Only ever reports each tag once (persisted dedup set, not a date cutoff) — no repeats. Logged to the admin logs channel. |
| **Welcome panel** | Bot startup | Ensures the `#welcome` panel exists and is pinned |
| **Break panel** | Bot startup | Ensures the `#on-a-break` panel exists and is pinned |
| **Appeals panel** | Bot startup | Ensures the `#appeals` panel exists and is pinned |
| **Waitlist panel** | Bot startup | Ensures the `#waiting-list` panel exists and is pinned, showing the current queue size |
| **Daily / weekly clan reports** | Daily 20:00 UTC / Sunday 20:00 UTC | Posts the clan activity report and weekly promotion/demotion summary to the reports channel |

> **Note:** Player names in all decision/log messages are shown in **bold** so they stand out at a glance.
> **River Race reminders are disabled** (they were noisy and added no value); the code remains in `src/war-scheduler.js` as a no-op if ever needed again.
> **`/recruit-eval-now` (manual mode) is a true dry run** — it reports what the evaluator *would* do without applying any role changes, profile updates, DMs, public posts, or state stamps. It cannot consume that week's real review or desync roles from the DB.

---

## How KRAKEN Times Wars & Reviews

KRAKEN does not receive a "war started/ended" push. It **polls the Clash Royale API every 10 minutes** watching `periodIndex`, and runs the full evaluation the moment that counter changes — i.e. at Supercell's real day/period rollover, not at a guessed wall-clock hour. Everything else derives from the live river-race state at that moment.

**Deciding if today is a war day** — priority cascade (`src/war-cycle.js`, `getWarDayDecision`):

1. **API `periodType`** (`training` / `warDay` / `colosseum`) — authoritative. Colosseum counts as a war day.
2. API `state` (collection / war / ended) — backup
3. API `periodIndex` (day-of-season counter; days 3–6 of each week are war)
4. Observed activity — did anyone use war decks today?
5. Calendar anchor (`RECRUIT_WAR_ANCHOR_UTC`, default `2026-02-26`) — last-resort tiebreaker only

Every daily snapshot stores its own war/training flag, so history itself becomes the record of when wars happened.

**Deciding when to run the role review** — the review fires on the **first training day after a war week closes**. KRAKEN tracks the last war week it reviewed (`eval.lastReviewedWarDay` setting) and reviews whenever the most recent war day in history has not yet been reviewed. Guarantees:

- **Exactly one** review per war week (never repeated across multiple training days).
- The live API confirms the war has actually closed before reviewing — a review **never fires mid-war**, even on an early restart.

### Offline / PC-off catch-up (self-healing)

The bot runs on a home PC via Task Scheduler, so it may be off when a transition happens. The review is built to recover:

| PC comes back online… | Result |
|---|---|
| After a transition was missed | Startup tick runs an eval immediately; if the war week is unreviewed, it **catches it up** |
| After several days off | First eval after returning catches up the missed review, exactly once |
| Always on | Eval fires at each real period rollover; review runs once per war week |
| A transition-tick eval fails (API hiccup) | The transition is **not** marked as seen — the next 10-minute tick retries until one succeeds |

**Why transition-triggered evals are safe:** the snapshot is taken at the real period boundary, so the just-ended day's numbers are final at capture time. The review itself additionally confirms via the live API that the war week has closed before applying any tier changes.

**The one inherent limit:** KRAKEN can only judge war days it actually captured a snapshot for. As long as the PC is on at least once during or shortly after a war (Clash war stats are cumulative within the week), the data is complete. The only unrecoverable case is the PC being off for an entire 7-day cycle.

---

## Deploying Commands

After adding new slash commands or changing command definitions, redeploy with:

```bash
npm run deploy
```

Then restart the bot. Discord caches commands — changes may take a few minutes to appear in clients.
