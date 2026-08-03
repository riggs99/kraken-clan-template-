import { seriesForTag, getLastCompletedWarWeek, getCompletedWarWeeks } from '../history.js';
import { cleanTag } from '../util.js';
import { isWarActivityPresent, isHistoricalWarDay, parseWarAnchorMsFromEnv, periodKeyForDay } from '../war-cycle.js';
import { deltaSeries } from '../window-delta.js';

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function summarizeWindow(history, tag, dayKeys, expectedDecksPerWarDay = 4, isWarDayForKey = null) {
  const series = seriesForTag(history, tag, dayKeys);
  const days = series.length;
  if (days === 0) return null;

  const fameCum = series.map(r => num(r.fame));
  const decksCum = series.map(r => num(r.decksUsed));
  const decksToday = series.map(r => num(r.decksUsedToday));
  const repair = series.map(r => num(r.repairPoints));
  const boat = series.map(r => num(r.boatAttacks));

  const fameDelta = deltaSeries(fameCum);
  const decksDelta = deltaSeries(decksCum, decksToday, expectedDecksPerWarDay);

  const warDayFlags = series.map((r) => {
    // Key off r.day (not dayKeys[idx]) — seriesForTag drops days with no snapshot
    // row for this tag, so series can be shorter than dayKeys and index-aligned
    // lookups against dayKeys silently drift onto the wrong day once a gap occurs.
    const dayKey = r.day;
    const rows = history?.days?.[dayKey]?.members ?? {};
    if (typeof isWarDayForKey === 'function') {
      const resolved = isWarDayForKey(dayKey, rows);
      if (resolved != null) return Boolean(resolved);
    }
    return isWarActivityPresent(rows);
  });
  // Group war-flagged buckets by the real Supercell day they belong to. One real
  // day straddles two calendar buckets (the ~09:40 UTC rollover), so counting
  // buckets directly over-counts war days mid-war (e.g. 2 colosseum days spread
  // across 3 dated buckets read as "3 war days / 12 expected decks") and can mark
  // a day "missed" when its play simply landed in the sibling bucket.
  const warPeriodDecks = new Map();
  series.forEach((r, idx) => {
    if (!warDayFlags[idx]) return;
    const key = periodKeyForDay(history, r.day);
    warPeriodDecks.set(key, num(warPeriodDecks.get(key) ?? 0) + num(decksDelta[idx]));
  });
  const warDays = warPeriodDecks.size;
  const expectedDecks = warDays * expectedDecksPerWarDay;

  const usedDecksOnWarDays = [...warPeriodDecks.values()].reduce((sum, v) => sum + v, 0);
  const fameOnWarDays = fameDelta.reduce((sum, v, idx) => sum + (warDayFlags[idx] ? num(v) : 0), 0);

  // A war day with zero decks is only "missed" once that day is actually over.
  // The still-running period is identified by the NEWEST bucket in history (the
  // flip snapshot always stamps it with the period that just started) — not by
  // today's calendar date, because for a stretch of every day (after UTC rolls
  // over but before anything snapshots the new date) no bucket exists for
  // "today" and a date-keyed lookup would wrongly flip the running day back to
  // "missed". By review time the newest bucket is the training-day flip, so no
  // war period matches and every zero-deck war day counts as genuinely missed —
  // tier decisions are unaffected by this split. (All live callers snapshot
  // before summarizing, so the newest bucket is never stale in practice.)
  const allBucketKeys = Object.keys(history?.days ?? {}).sort();
  const latestBucketKey = allBucketKeys.length ? allBucketKeys[allBucketKeys.length - 1] : null;
  let inProgressPeriodKey = null;
  if (latestBucketKey) {
    const latestRows = history?.days?.[latestBucketKey]?.members ?? {};
    let latestIsWar = null;
    if (typeof isWarDayForKey === 'function') {
      const resolved = isWarDayForKey(latestBucketKey, latestRows);
      if (resolved != null) latestIsWar = Boolean(resolved);
    }
    if (latestIsWar === null) latestIsWar = isWarActivityPresent(latestRows);
    if (latestIsWar) inProgressPeriodKey = periodKeyForDay(history, latestBucketKey);
  }

  let missedWarDays = 0;
  let yetToPlayWarDays = 0;
  for (const [key, decks] of warPeriodDecks) {
    if (decks > 0) continue;
    if (inProgressPeriodKey !== null && key === inProgressPeriodKey) yetToPlayWarDays += 1;
    else missedWarDays += 1;
  }

  const repairTotal = repair.reduce((a, b) => a + b, 0);
  const boatTotal = boat.reduce((a, b) => a + b, 0);
  const hasForbidden = (repairTotal > 0) || (boatTotal > 0);

  return {
    days,
    warDays,
    expectedDecks,
    usedDecks: usedDecksOnWarDays,
    fame: fameOnWarDays,
    missedWarDays,
    yetToPlayWarDays,
    repairTotal,
    boatTotal,
    hasForbidden,
    deckCompletion: expectedDecks > 0 ? clamp01(usedDecksOnWarDays / expectedDecks) : 0,
    isPerfectDecks: expectedDecks > 0 && usedDecksOnWarDays >= expectedDecks,
  };
}

export function hasFullWarWeek(sum7) {
  return Number(sum7?.expectedDecks ?? 0) >= 16;
}

export function hasTwoCompleteWars(sum14) {
  return Number(sum14?.expectedDecks ?? 0) >= 32;
}

export function isPerfectTwoWarWindow(sum14) {
  return hasTwoCompleteWars(sum14)
    && Number(sum14?.usedDecks ?? 0) >= 32
    && Number(sum14?.missedWarDays ?? 0) === 0
    && !sum14?.hasForbidden;
}

export function isTwoWarInactive(sum14) {
  return hasTwoCompleteWars(sum14)
    && Number(sum14?.usedDecks ?? 0) === 0
    && Number(sum14?.fame ?? 0) === 0
    && !sum14?.hasForbidden;
}

export function isOneWarInactive(sum7) {
  return hasFullWarWeek(sum7)
    && Number(sum7?.usedDecks ?? 0) === 0
    && Number(sum7?.fame ?? 0) === 0
    && !sum7?.hasForbidden;
}

export function isLargeTwoWarInconsistency(sum14) {
  const minBattlesToAvoidDemotion = 17;
  const maxMissedWarDaysToAvoidDemotion = 3;
  return hasTwoCompleteWars(sum14)
    && (
      Boolean(sum14?.hasForbidden)
      || Number(sum14?.usedDecks ?? 0) < minBattlesToAvoidDemotion
      || Number(sum14?.missedWarDays ?? 0) > maxMissedWarDaysToAvoidDemotion
    );
}

export function isLargeOneWarInconsistency(sum7) {
  const minBattlesToAvoidProbationFailure = 9;
  const maxMissedWarDaysToAvoidProbationFailure = 1;
  return hasFullWarWeek(sum7)
    && (
      Boolean(sum7?.hasForbidden)
      || Number(sum7?.usedDecks ?? 0) < minBattlesToAvoidProbationFailure
      || Number(sum7?.missedWarDays ?? 0) > maxMissedWarDaysToAvoidProbationFailure
    );
}

export function evaluateWarTierPolicy({ currentTier, sum7, sum14 }) {
  if (!hasFullWarWeek(sum7)) {
    return {
      desiredTier: currentTier === 'warcore' || currentTier === 'underwatch' ? currentTier : 'probation',
      reasons: ['TRACKING_WEEK_INCOMPLETE'],
      hold: true,
      remove: false,
    };
  }

  if (isOneWarInactive(sum7)) {
    return {
      desiredTier: 'underwatch',
      reasons: ['TWO_WAR_INACTIVE'],
      hold: false,
      remove: true,
    };
  }

  if (currentTier === 'warcore') {
    if (isLargeTwoWarInconsistency(sum14)) {
      return {
        desiredTier: 'probation',
        reasons: ['WARCORE_LARGE_2W_INCONSISTENCY'],
        hold: false,
        remove: false,
      };
    }
    return {
      desiredTier: 'warcore',
      reasons: ['WARCORE_LENIENCY_HOLD'],
      hold: false,
      remove: false,
    };
  }

  if (currentTier === 'underwatch') {
    if (isPerfectTwoWarWindow(sum14)) {
      return {
        desiredTier: 'probation',
        reasons: ['UNDERWATCH_RECOVERY'],
        hold: false,
        remove: false,
      };
    }
    return {
      desiredTier: 'underwatch',
      reasons: ['UNDERWATCH_CONTINUES'],
      hold: false,
      remove: false,
    };
  }

  if (isPerfectTwoWarWindow(sum14)) {
    return {
      desiredTier: 'warcore',
      reasons: ['PERFECT_2W_32_32'],
      hold: false,
      remove: false,
    };
  }

  if (isLargeOneWarInconsistency(sum7)) {
    return {
      desiredTier: 'underwatch',
      reasons: ['PROBATION_FAILED_2W_REVIEW'],
      hold: false,
      remove: false,
    };
  }

  return {
    desiredTier: 'probation',
    reasons: ['PROBATION_TRACKING_CONTINUES'],
    hold: false,
    remove: false,
  };
}

export function explainPolicyReason(reason) {
  const r = String(reason ?? '');
  if (r === 'TRACKING_WEEK_INCOMPLETE') return 'First full war week is not complete yet. Stay on probation while KRAKEN tracks the full week.';
  if (r === 'PERFECT_2W_32_32') return 'Perfect 32/32 across 2 complete wars with no forbidden actions.';
  if (r === 'WARCORE_LARGE_2W_INCONSISTENCY') return 'Large inconsistency across 2 complete wars. Warcore falls back to probation.';
  if (r === 'PROBATION_FAILED_2W_REVIEW') return 'Probation review failed across 1 full war week. Move to underwatch.';
  if (r === 'PROBATION_TRACKING_CONTINUES') return 'Tracking continues on probation until 2 complete wars prove consistent.';
  if (r === 'WARCORE_LENIENCY_HOLD') return 'Warcore leniency applied. Minor misses did not trigger demotion.';
  if (r === 'UNDERWATCH_RECOVERY') return 'Recovered with a perfect 2-war window. Move back to probation.';
  if (r === 'UNDERWATCH_CONTINUES') return 'Still underwatch. 2 complete clean wars are required to recover.';
  if (r === 'TWO_WAR_INACTIVE') return 'Inactive across 1 full war week. Remove role applied for admin boot review.';
  return r;
}

export function tierFromProfileStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'underwatch') return 'underwatch';
  if (s === 'approved' || s === 'warcore') return 'warcore';
  if (s === 'probation' || s === 'new' || s === 'applicant') return 'probation';
  return 'none';
}

// Shared by ops.js's Actions tab and war.js's decision-bucket blocks — both present
// the same tier-transition categories from the same policyRows shape, so the bucket
// rules live in one place instead of drifting the way the fame/decks delta math did.
//
// `extras.scoredByTag` (tag -> computeHistoryWeightedRisk's per-member result) and
// `extras.onBreakTags` (Set of on-break tags) are optional, defaulting to "no override
// data available" so existing callers that don't pass them keep their prior behavior.
// When provided, this applies the same risk-based override and on-break hold that
// war-board.js's own independent policy pass already applies and that evaluator.js's
// unattended auto role-mutation job actually enforces — without this, ops.js/war.js
// could show "keep warcore" for a member the nightly job is about to demote, or
// recommend action on a member who's fully exempt while on an approved break.
export function categorizeTierDecisions(policyRows, extras = {}) {
  const scoredByTag = extras.scoredByTag ?? new Map();
  const onBreakTags = extras.onBreakTags ?? new Set();

  const ranked = (Array.isArray(policyRows) ? policyRows : [])
    .filter(m => m.linked)
    .slice()
    .sort((a, b) => Number(a.sum14?.usedDecks ?? 0) - Number(b.sum14?.usedDecks ?? 0));

  for (const m of ranked) {
    const tag = cleanTag(m.tag);
    m.onBreak = onBreakTags.has(tag);
    const score = scoredByTag.get(tag) ?? null;
    const inOpsWeakRange = Boolean(score) && !score.inGrace && (
      Number(score.risk ?? 0) >= 0.55 ||
      Number(score.warParticipationRate ?? 0) <= 60 ||
      Number(score.daysInactive ?? 0) >= 7 ||
      Boolean(score.repeatOffender)
    );
    m.opsWeakOverride = Boolean(
      m.currentTier === 'warcore' &&
      !m.policy?.hold &&
      !m.policy?.remove &&
      inOpsWeakRange &&
      m.policy?.desiredTier === 'warcore'
    );
  }

  const watchClosely = ranked.filter(m => !m.onBreak && (
    (m.currentTier === 'warcore' && m.policy?.desiredTier === 'probation' && !m.policy?.remove) ||
    m.opsWeakOverride
  ));
  const moveUnderwatch = ranked.filter(m => !m.onBreak && m.policy?.desiredTier === 'underwatch' && !m.policy?.remove);
  const bootReview = ranked.filter(m => !m.onBreak && m.policy?.remove);
  const warcoreReady = ranked.filter(m => !m.onBreak && m.policy?.desiredTier === 'warcore' && !m.opsWeakOverride);
  return { ranked, watchClosely, moveUnderwatch, bootReview, warcoreReady };
}

export function latestKnownName(history, tag) {
  const clean = cleanTag(tag);
  if (!clean) return '';
  const keys = Object.keys(history?.days ?? {}).sort().reverse();
  for (const key of keys) {
    const row = history?.days?.[key]?.members?.[clean];
    const name = String(row?.name ?? '').trim();
    if (name) return name;
  }
  return '';
}

// Ranks every player who actually fought in a given completed war week (not just
// currently-linked members, and not people who've since left — the truest peer
// group for "how did that specific week go") by war performance (fame) and by
// donations separately, rather than blending them into one composite score —
// they measure different kinds of contribution and a leader/member should be able
// to tell which one a rank is about. Donations use a simple last-minus-first delta
// across the week (no per-day reset the way decksUsedToday has, so a day-by-day
// delta series isn't meaningful the way it is for fame/decks).
export function rankWarWeek(history, weekDays, expectedDecksPerWarDay = 4) {
  // Real Supercell days, not calendar buckets — one real day straddles two buckets
  // around the ~09:40 UTC rollover, so counting weekDays.length directly would inflate
  // the expected-decks target on a straddling week and could make a genuinely perfect
  // week fail the "every deck used" check.
  const realDayCount = new Set(weekDays.map(d => periodKeyForDay(history, d))).size;
  if (!weekDays.length) return { weekDays, realDayCount: 0, totalPeers: 0, byTag: {} };

  const allTags = new Set();
  for (const d of weekDays) {
    for (const tag of Object.keys(history?.days?.[d]?.members ?? {})) allTags.add(tag);
  }

  const rows = [];
  for (const tag of allTags) {
    const series = seriesForTag(history, tag, weekDays);
    if (!series.length) continue;

    const fameCum = series.map(r => num(r.fame));
    const decksCum = series.map(r => num(r.decksUsed));
    const decksToday = series.map(r => num(r.decksUsedToday));
    const donationsCum = series.map(r => num(r.donations));

    const fameTotal = deltaSeries(fameCum).reduce((a, b) => a + b, 0);
    const decksTotal = deltaSeries(decksCum, decksToday, expectedDecksPerWarDay).reduce((a, b) => a + b, 0);
    // Donations reset weekly on Supercell's own schedule, independent of the war
    // cycle — a plain last-minus-first delta went negative and got masked to 0 when
    // that reset happened to land mid-week (confirmed live: a member's real ~450
    // donated across the week read as 0). deltaSeries already has the right
    // reset-handling logic (same as fame's cumulative-within-a-race handling): a
    // detected drop is treated as a fresh restart, using the post-reset cumulative
    // value for that day instead of a negative diff.
    const donationsTotal = deltaSeries(donationsCum).reduce((a, b) => a + b, 0);

    rows.push({ tag, name: series[series.length - 1]?.name ?? tag, fameTotal, decksTotal, donationsTotal });
  }

  // Exact ties break on tag (alphabetical) so rank is deterministic across runs
  // instead of depending on incidental Set-insertion order from Object.keys().
  const byTag = {};
  rows.slice().sort((a, b) => b.fameTotal - a.fameTotal || a.tag.localeCompare(b.tag)).forEach((r, i) => {
    byTag[r.tag] = { ...byTag[r.tag], fameTotal: r.fameTotal, decksTotal: r.decksTotal, warRank: i + 1 };
  });
  rows.slice().sort((a, b) => b.donationsTotal - a.donationsTotal || a.tag.localeCompare(b.tag)).forEach((r, i) => {
    byTag[r.tag] = { ...byTag[r.tag], donationsTotal: r.donationsTotal, donationRank: i + 1 };
  });

  return { weekDays, realDayCount, totalPeers: rows.length, byTag };
}

export function rankLastCompletedWarWeek(history, expectedDecksPerWarDay = 4) {
  return rankWarWeek(history, getLastCompletedWarWeek(history), expectedDecksPerWarDay);
}

// Looks up (or computes and caches) one week's rankWarWeek result — shared by
// rankSeason and buildWarHistoryRecord instead of each hand-rolling the same
// lookup-or-compute block. Pass cache=null for a one-shot call with no caching
// (rankSeason never revisits the same week within one run — getCompletedWarWeeks
// partitions history.days into disjoint weeks — so caching there was pure
// overhead); pass a Map for callers that build results for many tags in the same
// run and want to share one rankWarWeek pass per week across tags
// (buildWarHistoryRecord, via evaluator.js's hall-of-fame checks).
function getRankedWeek(history, weekDays, expectedDecksPerWarDay, cache) {
  if (!cache) return rankWarWeek(history, weekDays, expectedDecksPerWarDay);
  const cacheKey = weekDays.join(',');
  let ranked = cache.get(cacheKey);
  if (!ranked) {
    ranked = rankWarWeek(history, weekDays, expectedDecksPerWarDay);
    cache.set(cacheKey, ranked);
  }
  return ranked;
}

// Aggregates every completed war week SINCE history.seasonStart into one
// whole-season total per player, for the end-of-season report. history.json is no
// longer wiped at a season boundary — scripts/season-reset.js just stamps a new
// seasonStart date (see history.js's getCompletedWarWeeks sinceDay param) so full
// history keeps accumulating for lifetime records/streaks (buildWarHistoryRecord).
// Falls back to trackingEpoch (the last full reset boundary — see
// scripts/full-clan-reset.js) when seasonStart isn't set yet, matching the same
// fallback src/recruit/season-rollover.js's checkCanRollSeason uses — without
// this, a history.json with trackingEpoch set but no seasonStart (a legacy file,
// or one restored from an old backup) would report "no season boundary, showing
// full history" here while the roll guard silently treated trackingEpoch AS the
// boundary, archiving a mismatched span into history.seasons that the report
// never warned about. If NEITHER is set, falls back to every week on record —
// matching the old wipe-based behavior for a history.json that predates both.
// warsPlayed only counts a week where the player actually used at least one deck
// (decksTotal > 0) — being on the roster with a snapshot row but sitting a week
// out shouldn't count as a "war played."
export function rankSeason(history, expectedDecksPerWarDay = 4) {
  const sinceDay = String(history?.seasonStart ?? history?.trackingEpoch ?? '').trim() || null;
  const weeks = getCompletedWarWeeks(history, { sinceDay });
  const totals = new Map();

  for (const weekDays of weeks) {
    const ranked = getRankedWeek(history, weekDays, expectedDecksPerWarDay, null);
    for (const [tag, entry] of Object.entries(ranked.byTag)) {
      const row = totals.get(tag) ?? { tag, fameTotal: 0, donationsTotal: 0, warsPlayed: 0 };
      row.fameTotal += num(entry.fameTotal);
      row.donationsTotal += num(entry.donationsTotal);
      if (num(entry.decksTotal) > 0) row.warsPlayed += 1;
      totals.set(tag, row);
    }
  }

  for (const row of totals.values()) {
    row.name = latestKnownName(history, row.tag) || row.tag;
  }

  return { weeksCounted: weeks.length, byTag: Object.fromEntries(totals) };
}

// Builds one player's full track record across every completed war week they
// fought in (newest first) — a different consumer of rankWarWeek than the
// single-week lookup above: this is /status's "Historical Record" section, so it
// needs streaks and personal bests, not just "how did last week go." Weeks before
// the player joined (or that they simply didn't fight) are skipped rather than
// counted as a broken streak or a zero — there's no meaningful "rank" for a week
// someone wasn't part of.
export function buildWarHistoryRecord(history, tag, expectedDecksPerWarDay = 4, maxWeeks = 52, weekRankCache = null, recordCache = null) {
  const clean = cleanTag(tag);
  // recordCache memoizes this function's full result per tag (unlike weekRankCache,
  // which only shares the per-week ranking pass) — lets a caller that builds records
  // for the same tag more than once in one run (e.g. evaluator.js's hall-of-fame
  // checks, where a member can be both the top donor and the attendance leader) skip
  // redoing the whole maxWeeks-deep walk.
  const cacheKey = recordCache ? `${clean}|${expectedDecksPerWarDay}|${maxWeeks}` : null;
  if (cacheKey && recordCache.has(cacheKey)) return recordCache.get(cacheKey);

  const anchorMs = parseWarAnchorMsFromEnv();
  // Attendance (showed up every war day) is a looser bar than perfectDecks (used
  // every deck every day) — both still need the SAME authoritative classifier
  // (isHistoricalWarDay) that selected weekDays in the first place, or a day it
  // correctly flags as a war day with zero recorded clan-wide activity would be
  // silently dropped from the missed-day count instead of counted as missed.
  const isWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, anchorMs);
  const weeks = getCompletedWarWeeks(history, { maxWeeks, anchorMs });

  const played = [];
  for (const weekDays of weeks) {
    const ranked = getRankedWeek(history, weekDays, expectedDecksPerWarDay, weekRankCache);
    const entry = ranked.byTag[clean];
    if (!entry) continue;
    const expectedDecks = expectedDecksPerWarDay * ranked.realDayCount;
    const weekSummary = summarizeWindow(history, clean, weekDays, expectedDecksPerWarDay, isWarDayForKey);
    played.push({
      weekDays,
      totalPeers: ranked.totalPeers,
      warRank: entry.warRank,
      donationRank: entry.donationRank,
      fameTotal: entry.fameTotal,
      decksTotal: entry.decksTotal,
      donationsTotal: entry.donationsTotal,
      perfectDecks: expectedDecks > 0 && entry.decksTotal >= expectedDecks,
      zeroMissed: Number(weekSummary?.missedWarDays ?? 0) === 0,
    });
  }
  // played is already newest-first — getCompletedWarWeeks returns weeks that way
  // and this loop preserves order.

  function currentStreak(predicate) {
    let n = 0;
    for (const w of played) {
      if (!predicate(w)) break;
      n++;
    }
    return n;
  }

  const streaks = {
    top1War: currentStreak(w => w.warRank === 1),
    perfectDecks: currentStreak(w => w.perfectDecks),
    top1Donor: currentStreak(w => w.donationRank === 1),
    attendance: currentStreak(w => w.zeroMissed),
  };

  let bests = null;
  if (played.length) {
    bests = {
      bestFameWeek: played.reduce((b, w) => (!b || w.fameTotal > b.fameTotal) ? w : b, null),
      bestDonationWeek: played.reduce((b, w) => (!b || w.donationsTotal > b.donationsTotal) ? w : b, null),
      bestWarRankWeek: played.reduce((b, w) => (!b || w.warRank < b.warRank) ? w : b, null),
      perfectWeekCount: played.filter(w => w.perfectDecks).length,
    };
  }

  // The most recent played week's full stats — needed by callers that want
  // "how did this specific week go" without a second rankWarWeek call (e.g. the
  // clan donor-record check, which needs this week's donation total alongside
  // the streak length above).
  const result = { weeksTracked: played.length, streaks, bests, latestWeek: played[0] ?? null };
  if (cacheKey) recordCache.set(cacheKey, result);
  return result;
}

// A clan hall-of-fame "longest streak at #1" record — donor, war champion, and
// attendance all share this exact shape (src/recruit/clan-records.js). Each is a
// single shared record, not a per-player achievement: one player holds it at a
// time, and a challenger has to either out-last it (a longer streak) or tie it
// and beat the incumbent on that record type's own tiebreak metric (donations,
// fame, or decks used — whatever the caller populates weekDonations with) in the
// deciding week. Pure decision function (no I/O) so the tie-break table can be
// unit-tested directly: candidate is this week's #1 + their current streak
// (from buildWarHistoryRecord's streaks.*), storedRecord is whatever's
// persisted for that record type (or null if never set).
//
// candidate: { tag, name, streak, weekDonations, weekLabel } — weekDonations is
//   generic: whichever numeric metric this record type breaks ties on.
// storedRecord: same shape, or null
// Returns { outcome, record } — record is the record to persist (unchanged
// from storedRecord when outcome is 'none' or 'tiebreak-retained').
export function evaluateRecordStreakChallenge(candidate, storedRecord) {
  if (!candidate || !(candidate.streak > 0)) return { outcome: 'none', record: storedRecord ?? null };

  if (!storedRecord) {
    return { outcome: 'first', record: candidate };
  }

  if (candidate.tag === storedRecord.tag) {
    // The current holder extending their own streak — only notable (and only
    // ever possible) when the streak actually grew since it was last recorded.
    if (candidate.streak > storedRecord.streak) {
      return { outcome: 'extended', record: candidate };
    }
    return { outcome: 'none', record: storedRecord };
  }

  if (candidate.streak > storedRecord.streak) {
    return { outcome: 'beaten', record: candidate };
  }

  if (candidate.streak === storedRecord.streak) {
    if (candidate.weekDonations > storedRecord.weekDonations) {
      return { outcome: 'tiebreak-claimed', record: candidate };
    }
    // Strictly less-than OR equal donations both keep the incumbent — "if both
    // player have same streak same donations the player that had the record
    // keeps the record."
    return { outcome: 'tiebreak-retained', record: storedRecord };
  }

  // candidate.streak < storedRecord.streak — not even a challenger this week.
  return { outcome: 'none', record: storedRecord };
}
