import fs from 'node:fs';
import path from 'node:path';
import { todayKeyISO, cleanTag } from './util.js';
import { extractLatestClanLogParticipants } from './war-intel.js';
import { isHistoricalWarDay, parseWarAnchorMsFromEnv } from './war-cycle.js';

// Exported so every script/command that needs to check-for/back-up this exact
// file (scripts/season-reset.js, scripts/full-clan-reset.js,
// src/recruit/commands/season-reset.js) shares one source of truth instead of
// each re-deriving the same path.join(...) independently.
export const HISTORY_PATH = path.join(process.cwd(), 'data', 'history.json');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    // A corrupt/truncated file (e.g. a hard kill mid-write, matching
    // src/discipline.js's same fix) used to silently fall back here with no
    // trace, and the very next save would then persist that empty state over
    // the real one — log it so a wiped history.json is at least visible.
    console.error(`[HISTORY] Failed to read ${filePath}, falling back to default:`, e?.message ?? String(e));
    return fallback;
  }
}

function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Write to a temp file then rename — a raw writeFileSync can leave a
  // truncated/invalid file if the process is killed mid-write (this
  // project's own restart procedure is a hard taskkill, not a graceful
  // shutdown), and the next readJson() would then silently reset to empty
  // and persist that. A rename is atomic on the same filesystem, so readers
  // never see a partial file. Matches src/discipline.js's identical fix.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function loadHistory() {
  return readJson(HISTORY_PATH, { firstSeen: {}, days: {} });
}

export function saveHistory(h) {
  writeJson(HISTORY_PATH, h);
}

// Backs up history.json before a mutation, per CLAUDE.md's production-data-safety
// rule — shared by every script/command that mutates this file instead of each
// hand-rolling its own existsSync+copyFileSync. Keyed by date AND a millisecond
// timestamp (not just the date) so two backups taken the same day can never
// collide and silently overwrite each other's pre-mutation snapshot — the exact
// failure mode that would otherwise destroy the one recovery artifact right when
// a same-day double-run needed it most. Returns the backup path, or null if
// history.json doesn't exist yet (nothing to back up).
export function backupHistoryFile() {
  if (!fs.existsSync(HISTORY_PATH)) return null;
  const stamp = `${todayKeyISO()}-${Date.now()}`;
  const backupPath = HISTORY_PATH.replace('.json', `.bak-${stamp}.json`);
  fs.copyFileSync(HISTORY_PATH, backupPath);
  return backupPath;
}

// Cross-process mutual exclusion for history.json, via atomic exclusive file
// creation (the 'wx' flag throws EEXIST if the lock file already exists — this
// is what makes acquisition atomic across processes, unlike a check-then-write).
// Shared by every writer of this file: the always-running bot's own periodic
// upsertTodaySnapshot below, the two season-rollover entry points
// (scripts/season-reset.js, src/recruit/commands/season-reset.js), and
// scripts/full-clan-reset.js — so none of them can silently clobber another's
// concurrent read-modify-write of the same file. A 5-minute staleness override
// lets a crashed holder's lock self-clear instead of jamming the file forever;
// keeping any single critical section well under that (crFetch in cr-api.js
// now has a hard timeout) is what makes 5 minutes a safe margin rather than a
// window a live-but-slow holder could get force-evicted inside of.
const LOCK_PATH = path.join(path.dirname(HISTORY_PATH), '.history.lock');
const STALE_LOCK_MS = 5 * 60 * 1000;

export function acquireHistoryLock() {
  try {
    fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' });
    return { acquired: true };
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    try {
      const age = Date.now() - Number(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (Number.isFinite(age) && age > STALE_LOCK_MS) {
        fs.rmSync(LOCK_PATH, { force: true });
        fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: 'wx' });
        return { acquired: true };
      }
    } catch { /* fall through */ }
    return {
      acquired: false,
      reason: 'history.json is being written by another process right now (a season rollover, a full reset, or a routine snapshot) — try again in a moment. If nothing is actually running and this persists, delete data/.history.lock.',
    };
  }
}

export function releaseHistoryLock() {
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* already gone */ }
}

function yesterdayKeyISO(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function upsertTodaySnapshot(members, meta = {}) {
  // Called from many places (ops.js, war.js, schedule.js's scheduled ticks,
  // evaluator.js, war-board.js) throughout the bot's normal operation, none of
  // which know or care about a season rollover happening elsewhere. If one IS
  // in progress (a rare, short-lived critical section), skip this write rather
  // than racing it — saveHistory is a full overwrite, not a merge, so losing
  // this race would silently discard whichever side wrote second. The next
  // normal call (the very next command run or scheduled tick) picks the day's
  // snapshot back up; nothing here depends on every single call succeeding.
  const lock = acquireHistoryLock();
  if (!lock.acquired) {
    console.warn(`[HISTORY] Skipping snapshot write — ${lock.reason}`);
    return { history: loadHistory(), day: todayKeyISO(), nameChanges: [], resetPrevDay: null };
  }
  try {
    return upsertTodaySnapshotLocked(members, meta);
  } finally {
    releaseHistoryLock();
  }
}

function upsertTodaySnapshotLocked(members, meta = {}) {
  let h = loadHistory();
  const day = todayKeyISO();

  // Detect a "war days just ended" transition from ANY caller, not just the
  // scheduled evaluator tick. Right at that flip, the live API can still report
  // the just-ended war day's final cumulative totals under the NEW period's
  // periodIndex/periodType — filing them only under "today" (about to be stamped
  // training/non-war) leaks the last stretch of that war day's play into a bucket
  // every war-window computation excludes as non-war (confirmed live: a member's
  // real final-day fame gain went missing from every war total because it landed
  // in a training-flagged bucket, TWICE — once at an actual race-to-race reset,
  // and again at an ordinary war-day-4-to-training boundary WITHIN the same race,
  // where periodIndex increases rather than resets, so the original decrease-only
  // check below never fired and the whole roster's day-4 numbers went stale).
  // Merging into yesterday via mergeMembersIntoDay's Math.max rule is safe
  // regardless of how long ago the transition happened, since a fresh period's
  // totals start at/near 0 (or, within a race, are the prior day's totals plus
  // nothing yet) and can never Math.max-inflate yesterday's higher final total.
  // Exposed to the caller as resetPrevDay so a completed-race-log reconciliation
  // (reconcileFinalWarDayFromLog) can target this EXACT day instead of independently
  // guessing which day just ended — guessing was the bug: an open-ended backward scan
  // for "last day flagged warDay" matches TODAY the instant a new war day's bucket is
  // written (which happens above, moments before any reconciliation would run), so it
  // was comparing today's correct, fresh, low totals against the previous race's
  // final log numbers and Math.max-corrupting live data with stale data. Only ever
  // set on a genuine detected transition, so reconciliation only ever runs right at
  // a real war-day boundary, against the one day that transition actually concerns.
  let resetPrevDay = null;
  const incomingPeriodIndex = Number(meta?.periodIndex);
  // Reuse the caller's own `meta.warDay` — every caller already computes this via
  // war-cycle.js's warDayFromPeriodType(), which correctly treats 'colosseum' (not
  // just the literal string 'warDay') as a war day. An earlier version of this
  // check compared meta.periodType against the literal string 'warDay' directly,
  // which silently missed a colosseum-ending race week: colosseum's own periodType
  // isn't 'warDay', so that day never got recorded as "last seen war day," and the
  // colosseum->training transition never triggered reconciliation — the exact
  // stale-final-day bug this mechanism exists to prevent, just under a different
  // periodType spelling. Tracked independently of periodIndex's validity (below),
  // not nested under it, so a snapshot with a momentarily-missing/invalid
  // periodIndex (e.g. a degraded API response) can't leave this stuck stale.
  const incomingIsWarDay = typeof meta?.warDay === 'boolean' ? meta.warDay : null;
  const justLeftWarDays = incomingIsWarDay === false && h.lastSeenWasWarDay === true;
  if (Number.isFinite(incomingPeriodIndex)) {
    const lastSeen = Number.isFinite(Number(h.lastSeenPeriodIndex)) ? Number(h.lastSeenPeriodIndex) : null;
    // A genuine race-to-race reset (periodIndex rolls back, e.g. 34 -> 0) OR the
    // ordinary end of this race's own war days (just detected above) — both mean
    // the war day that just ended needs the same protection, whether or not
    // periodIndex happened to decrease for it.
    const isPeriodIndexReset = lastSeen !== null && incomingPeriodIndex < lastSeen;
    if (isPeriodIndexReset || justLeftWarDays) {
      const prevDay = yesterdayKeyISO(day);
      if (prevDay) {
        // Only trust prevDay as the completed race's actual last day — and therefore
        // safe to hand to the log-based reconciliation below — when there's an
        // unbroken snapshot right up to it (the day before prevDay already has a
        // bucket, or prevDay is the very first tracked day). The scheduled evaluator's
        // 24h safety net (evaluator.js's startRecruitEvaluator) guarantees a snapshot
        // every real day the bot process is alive, so a gap here means genuine
        // extended downtime — in which case raceLog.items[0] ("the most recently
        // completed race") may not be the race that actually ended at prevDay, and
        // Math.max-merging its totals in would corrupt an unrelated day. The plain
        // merge just below is safe regardless (Math.max can't inflate a lower fresh
        // value over a higher stored one), so it always runs; only the riskier
        // log-based correction is withheld when continuity can't be confirmed.
        const priorDayKeys = Object.keys(h.days).filter(d => d < prevDay).sort();
        const lastPriorDay = priorDayKeys.length ? priorDayKeys[priorDayKeys.length - 1] : null;
        const hasContinuity = lastPriorDay === null || lastPriorDay >= yesterdayKeyISO(prevDay);

        mergeMembersIntoDay(prevDay, members);
        h = loadHistory(); // mergeMembersIntoDay saved its own changes — reload before continuing

        if (hasContinuity) {
          resetPrevDay = prevDay;

          // Self-healing reconciliation against the CR API's permanent race log — run
          // once, here, instead of every caller (ops.js, war.js, schedule.js,
          // evaluator.js, war-board.js) duplicating this same try/catch wiring. Only
          // runs when the caller passes raceLog/clanTag; a caller that omits them just
          // gets the plain merge above, matching the old opt-out behavior.
          if (meta.raceLog !== undefined && meta.clanTag) {
            try {
              const logParticipants = extractLatestClanLogParticipants(meta.raceLog, meta.clanTag);
              const { corrected } = reconcileFinalWarDayFromLog(prevDay, logParticipants);
              if (corrected.length) {
                console.log(`[HISTORY] Reconciled ${corrected.length} member(s) against completed race log for ${prevDay}: ${corrected.map(c => c.tag).join(', ')}`);
                h = loadHistory();
              }
            } catch (e) {
              console.error('[HISTORY] Race log reconciliation failed:', e?.message ?? String(e));
            }
          }
        } else {
          console.warn(`[HISTORY] Snapshot gap detected before ${prevDay} — skipping race-log reconciliation (cannot confirm it is the true last day of the completed race).`);
        }
      }
    }
    h.lastSeenPeriodIndex = incomingPeriodIndex;
  }
  if (incomingIsWarDay !== null) h.lastSeenWasWarDay = incomingIsWarDay;

  h.firstSeen = h.firstSeen ?? {};
  h.days = h.days ?? {};
  h.days[day] = h.days[day] ?? { members: {}, bottomOverallEligibleTags: [] };

  // Precompute sorted previous days (newest first) for name-change detection.
  const prevDays = Object.keys(h.days).filter(d => d < day).sort().reverse();
  const nameChanges = [];

  // Record the day-level war classification while the live API still knows it.
  // Stored authoritatively so later windows never have to guess from cumulative fame.
  if (meta && typeof meta === 'object') {
    if (typeof meta.periodType === 'string' && meta.periodType.trim()) {
      h.days[day].periodType = meta.periodType.trim();
    }
    if (typeof meta.warDay === 'boolean') {
      h.days[day].warDay = meta.warDay;
    }
    // The real Supercell day this bucket's data belongs to. Calendar buckets and
    // Supercell days are offset (~09:40 UTC rollover), so day-counting stats group
    // buckets by this instead of assuming one bucket = one war day.
    if (Number.isFinite(Number(meta.periodIndex))) {
      h.days[day].periodIndex = Number(meta.periodIndex);
    }
  }

  function num(v) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  for (const m of members) {
    if (!h.firstSeen[m.tag]) h.firstSeen[m.tag] = day;

    // Detect name changes by comparing against the most recently stored name.
    const newName = String(m.name ?? '').trim();
    if (newName) {
      for (const pd of prevDays) {
        const prev = h.days[pd]?.members?.[m.tag];
        if (prev?.name) {
          const oldName = String(prev.name).trim();
          if (oldName && oldName !== newName) {
            nameChanges.push({ tag: m.tag, oldName, newName, day });
          }
          break;
        }
      }
    }

    const existing = h.days[day].members[m.tag] ?? null;
    const next = {
      tag: m.tag,
      name: m.name,
      fame: num(m.fame),
      decksUsedToday: num(m.decksUsedToday),
      decksUsed: num(m.decksUsed),
      repairPoints: num(m.repairPoints),
      boatAttacks: num(m.boatAttacks),
      donations: num(m.donations),
      donationsReceived: num(m.donationsReceived),
      trophies: num(m.trophies),
      role: m.role ?? 'member',
      expLevel: num(m.expLevel),
      lastSeen: m.lastSeen ?? null,
      clanRank: num(m.clanRank),
    };

    // Protect against transient API lag that can temporarily drop war numbers to 0.
    // War fields should be monotonic within a given day; keep the max seen for today.
    if (existing) {
      next.fame = Math.max(num(existing.fame), next.fame);
      next.decksUsedToday = Math.max(num(existing.decksUsedToday), next.decksUsedToday);
      next.decksUsed = Math.max(num(existing.decksUsed), next.decksUsed);
      next.repairPoints = Math.max(num(existing.repairPoints), next.repairPoints);
      next.boatAttacks = Math.max(num(existing.boatAttacks), next.boatAttacks);
    }

    h.days[day].members[m.tag] = next;
  }

  saveHistory(h);
  return { history: h, day, nameChanges, resetPrevDay };
}

// Merge a snapshot's member rows into a specific existing day bucket using the same
// monotonic-max rule as upsertTodaySnapshot, WITHOUT touching that bucket's
// war/training classification. Used at a detected period transition: the flip-moment
// API state holds the just-ended period's final cumulative totals, and those belong
// to the bucket that period's earlier polls wrote to — filing them only under
// "today" (whose flag the new period owns) leaks the final stretch of war play
// (last daily-report poll → flip, i.e. most of the Sydney daytime) into a
// training-flagged bucket, where it is excluded from every war-deck sum.
export function mergeMembersIntoDay(day, members) {
  const dayKey = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;

  const h = loadHistory();
  h.days = h.days ?? {};
  // Create the bucket if missing (bot offline all of yesterday) but leave it
  // unflagged — isHistoricalWarDay's fallback classification handles flagless days.
  h.days[dayKey] = h.days[dayKey] ?? { members: {}, bottomOverallEligibleTags: [] };

  function num(v) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  for (const m of members ?? []) {
    if (!m?.tag) continue;
    const existing = h.days[dayKey].members[m.tag] ?? null;
    const next = {
      tag: m.tag,
      name: m.name,
      fame: num(m.fame),
      decksUsedToday: num(m.decksUsedToday),
      decksUsed: num(m.decksUsed),
      repairPoints: num(m.repairPoints),
      boatAttacks: num(m.boatAttacks),
      donations: num(m.donations),
      donationsReceived: num(m.donationsReceived),
      trophies: num(m.trophies),
      role: m.role ?? 'member',
      expLevel: num(m.expLevel),
      lastSeen: m.lastSeen ?? null,
      clanRank: num(m.clanRank),
    };
    if (existing) {
      next.fame = Math.max(num(existing.fame), next.fame);
      next.decksUsedToday = Math.max(num(existing.decksUsedToday), next.decksUsedToday);
      next.decksUsed = Math.max(num(existing.decksUsed), next.decksUsed);
      next.repairPoints = Math.max(num(existing.repairPoints), next.repairPoints);
      next.boatAttacks = Math.max(num(existing.boatAttacks), next.boatAttacks);
    }
    h.days[dayKey].members[m.tag] = next;
  }

  saveHistory(h);
  return h;
}

// Reconciles a specific completed war day's cumulative totals against the CR API's
// own permanent race log — the authoritative record for a race once it's over.
// KRAKEN only snapshots when someone runs /ops, /war, or /war-board (no independent
// scheduler polls the live race), so a member's final burst of play can land after
// the last snapshot before the race ends and before anyone runs a command again —
// silently under-recording their true total with no error anywhere (confirmed live:
// a member's real 2nd-place 2550/16 stored as 2050/12, a full war day short, with
// every other member's numbers correct).
//
// targetDay MUST come from upsertTodaySnapshot's resetPrevDay — the exact day a
// just-detected race transition says just ended — not independently rediscovered
// here. An earlier version scanned backward for "the last day flagged warDay" on
// every call, which matched TODAY'S bucket the instant a new war day started
// (already written and warDay-flagged by upsertTodaySnapshot moments before this
// runs) and Math.max-corrupted today's correct, fresh, low totals with the
// *previous* race's higher final numbers from the log. Only ever reconciling the
// one day a transition just identified makes this safe to call unconditionally
// and impossible to point at the wrong race.
//
// Math.max-only (never lowers a stored value), so a log that hasn't finished
// updating yet, or a member with no discrepancy, is a harmless no-op — safe to
// call every time a reset is detected, not just the first.
export function reconcileFinalWarDayFromLog(targetDay, logParticipants) {
  const dayKey = String(targetDay ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { corrected: [] };
  if (!Array.isArray(logParticipants) || !logParticipants.length) return { corrected: [] };

  const h = loadHistory();
  h.days = h.days ?? {};
  h.days[dayKey] = h.days[dayKey] ?? { members: {}, bottomOverallEligibleTags: [] };
  // Must be the true calendar day before dayKey, not just whichever key happens to
  // sort immediately before it — a snapshot gap (a day with no bucket at all) would
  // otherwise silently splice in an unrelated, possibly much-earlier day's cumulative
  // decksUsed as the baseline for decksUsedToday below.
  const trueCalendarPrevDay = yesterdayKeyISO(dayKey);
  const prevDay = (trueCalendarPrevDay && h.days[trueCalendarPrevDay]) ? trueCalendarPrevDay : null;

  const corrected = [];
  for (const p of logParticipants) {
    const tag = cleanTag(p?.tag);
    if (!tag) continue;
    const logFame = Number(p?.fame ?? 0);
    const logDecks = Number(p?.decksUsed ?? 0);
    const logRepair = Number(p?.repairPoints ?? 0);
    const logBoat = Number(p?.boatAttacks ?? 0);
    if (!logFame && !logDecks && !logRepair && !logBoat) continue;

    // A participant who left the clan before this day's snapshot got written may
    // have no existing row at all (pre-dates the war-intel.js fix that now keeps
    // mid-war leavers) — build one from the log rather than skipping them.
    const existing = h.days[dayKey].members[tag] ?? null;
    const storedFame = Number(existing?.fame ?? 0);
    const storedDecks = Number(existing?.decksUsed ?? 0);
    const storedRepair = Number(existing?.repairPoints ?? 0);
    const storedBoat = Number(existing?.boatAttacks ?? 0);
    if (logFame <= storedFame && logDecks <= storedDecks && logRepair <= storedRepair && logBoat <= storedBoat) {
      continue; // already correct, or log not fresh yet
    }

    const prevDecks = prevDay ? Number(h.days[prevDay]?.members?.[tag]?.decksUsed ?? 0) : 0;
    const newDecks = Math.max(logDecks, storedDecks);
    const newFame = Math.max(logFame, storedFame);

    h.days[dayKey].members[tag] = {
      tag,
      name: existing?.name ?? p?.name ?? tag,
      fame: newFame,
      decksUsedToday: Math.max(0, newDecks - prevDecks),
      decksUsed: newDecks,
      repairPoints: Math.max(logRepair, storedRepair),
      boatAttacks: Math.max(logBoat, storedBoat),
      donations: Number(existing?.donations ?? 0),
      donationsReceived: Number(existing?.donationsReceived ?? 0),
      trophies: Number(existing?.trophies ?? 0),
      role: existing?.role ?? 'member',
      expLevel: Number(existing?.expLevel ?? 0),
      lastSeen: existing?.lastSeen ?? null,
      clanRank: Number(existing?.clanRank ?? 0),
    };
    corrected.push({ tag, day: dayKey, fame: newFame, decksUsed: newDecks });
  }

  if (corrected.length) saveHistory(h);
  return { corrected };
}

export function markBottomEligible(day, tags) {
  const h = loadHistory();
  h.days = h.days ?? {};
  h.days[day] = h.days[day] ?? { members: {}, bottomOverallEligibleTags: [] };
  h.days[day].bottomOverallEligibleTags = Array.isArray(tags) ? tags : [];
  saveHistory(h);
  return h;
}

export function getLastNDays(history, n) {
  const keys = Object.keys(history?.days ?? {}).sort(); // ISO YYYY-MM-DD
  return keys.slice(-n);
}

// The day-keys of every FINISHED war week (each a contiguous run of warDay:true
// buckets), newest-first, for ranking/reporting on "how did that week actually go"
// rather than a rolling window that can straddle a still-in-progress week. If the
// clan is currently mid-war, that in-progress run is skipped entirely — its week
// isn't "completed" yet — in favor of the most recent real week before it. Stops
// early once `maxWeeks` completed weeks are collected (a generous safety cap for
// callers walking arbitrarily far back, e.g. /status's cross-week history — with
// no cap, a very old, never-reset clan's history.json could make that walk
// unnecessarily large). Returns [] if no completed war week exists yet (e.g. right
// after a fresh reset, before any war days have been tracked at all).
export function getCompletedWarWeeks(history, { maxWeeks = null, anchorMs = null, sinceDay = null } = {}) {
  const resolvedAnchor = anchorMs ?? parseWarAnchorMsFromEnv();
  // Same classifier every other war-day computation in the codebase uses (ops.js,
  // schedule.js, evaluator.js, war-board.js) — unlike a raw `warDay` flag check, this
  // has fallback classification for flagless buckets (e.g. a bot-downtime gap), so a
  // missing flag can't be misread as "not a war day" and silently split/truncate the week.
  const isWarDay = (d) => isHistoricalWarDay(history, d, resolvedAnchor);
  // sinceDay bounds the walk to one season (rankSeason passes history.seasonStart) —
  // callers that want a player's FULL lifetime history for streaks/records
  // (buildWarHistoryRecord, getLastCompletedWarWeek) leave it null and see everything,
  // since a season rollover no longer wipes history.json the way it used to.
  //
  // sinceDay is applied AFTER building each week, not by pre-filtering sortedDays —
  // filtering days first let a week that physically straddles the season boundary
  // survive as a fake "complete" partial week (e.g. a 4-day war week rolled mid-week
  // would look like a clean 2-day week to the new season). Because fame/donations
  // have no same-day fallback in deltaSeries, that partial week's first day silently
  // absorbed the missing days' cumulative total — misattributing real contributions
  // into the wrong season with no error. A week that isn't wholly on-or-after
  // sinceDay is excluded entirely instead, the same way an in-progress week already
  // gets excluded until it's cleanly complete.
  const sortedDays = Object.keys(history?.days ?? {}).sort();
  let i = sortedDays.length - 1;

  // Skip a currently in-progress war week (most recent day is still a war day).
  while (i >= 0 && isWarDay(sortedDays[i])) i--;

  const weeks = [];
  while (i >= 0) {
    // Walk back through any training/colosseum-gap days to reach the next war day.
    while (i >= 0 && !isWarDay(sortedDays[i])) i--;
    if (i < 0) break;

    const weekDays = [];
    while (i >= 0 && isWarDay(sortedDays[i])) {
      const day = sortedDays[i];
      // A real calendar gap between this day and the day already at the
      // front of the week means one or more days are entirely missing from
      // history.days — almost always an extended outage that swallowed the
      // training days between two separate real war weeks. Without this
      // check, the two weeks' war-day entries end up adjacent in sortedDays
      // (since only EXISTING keys are walked, not every calendar day) and
      // get silently merged into one fake week, corrupting Hall of Fame
      // streaks and season rankings. Stop the week here instead; the
      // earlier day(s) start their own (possibly separate) week on the next
      // outer-loop iteration.
      if (weekDays.length > 0 && yesterdayKeyISO(weekDays[0]) !== day) break;
      weekDays.unshift(day);
      i--;
    }
    // Once we hit a week that isn't entirely on-or-after sinceDay (walking
    // newest-to-oldest), every earlier week is too — safe to stop scanning.
    if (sinceDay && !weekDays.every(d => d >= sinceDay)) break;
    weeks.push(weekDays);
    if (Number.isFinite(maxWeeks) && weeks.length >= maxWeeks) break;
  }
  return weeks;
}

// The day-keys of just the most recently completed war week — see
// getCompletedWarWeeks above for the full explanation. Kept as its own function
// since this single-week lookup is by far the more common call site (every current
// caller except /status's cross-week history wants only the latest week).
export function getLastCompletedWarWeek(history, anchorMs = null) {
  return getCompletedWarWeeks(history, { maxWeeks: 1, anchorMs })[0] ?? [];
}

export function seriesForTag(history, tag, dayKeys) {
  const out = [];
  for (const d of dayKeys) {
    const row = history?.days?.[d]?.members?.[tag];
    if (row) out.push({ day: d, ...row });
  }
  return out;
}

export function countEligibleBottomHits(history, tag, windowDays) {
  const keys = getLastNDays(history, windowDays);
  let hits = 0;
  for (const d of keys) {
    const arr = history?.days?.[d]?.bottomOverallEligibleTags ?? [];
    if (Array.isArray(arr) && arr.includes(tag)) hits++;
  }
  return hits;
}
