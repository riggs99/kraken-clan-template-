import { avg, todayKeyISO, daysBetweenISO, daysSinceLastSeen, participationRate } from './util.js';
import { getLastNDays, countEligibleBottomHits } from './history.js';
import { isWarActivityPresent, periodKeyForDay } from './war-cycle.js';
import { deltaSeries } from './window-delta.js';

// The "high risk" cutoff on the 0-1 risk score this module produces — shared so
// every view that flags high-risk members (ops.js's overview count, analytics.js's
// clan health, promotions.js's repeat-offender override, status.js's standing
// verdict) agrees on the same line instead of each hardcoding its own copy of 0.75.
export const HIGH_RISK_THRESHOLD = 0.75;

/**
 * Join grace ends when the current war week goes live — except for members who
 * genuinely joined after war started (firstSeen after the first war day). Members
 * present at a season/tracking reset (firstSeen <= trackingEpoch) are never held
 * in grace just because history was restamped.
 */
export function buildWarGraceContext(history, isWarDayForKey, { warActiveToday = null, today = todayKeyISO() } = {}) {
  const sortedDays = Object.keys(history?.days ?? {}).sort();
  const inProgressWarDays = [];
  let prevMs = null;
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    const d = sortedDays[i];
    if (!isWarDayForKey(d)) break;
    const dMs = Date.parse(`${d}T00:00:00Z`);
    // A gap of more than a day between two consecutive war-flagged buckets means
    // at least one full day has no snapshot at all — don't bridge across it. The
    // known ~09:40 UTC period-straddle case (one real war day split across two
    // calendar buckets) is always exactly 1 day apart, so this only trips on a
    // genuine missing day, not that. Without this, a missing snapshot right at a
    // war-start boundary (e.g. the evaluator's live refresh failing 3x that day)
    // can silently merge last week's trailing war days into this week's run,
    // misattributing firstWarDay to the wrong war.
    if (prevMs !== null && Number.isFinite(dMs) && (prevMs - dMs) > 2 * 24 * 60 * 60 * 1000) break;
    inProgressWarDays.unshift(d);
    prevMs = Number.isFinite(dMs) ? dMs : prevMs;
  }
  const liveWar = warActiveToday != null ? Boolean(warActiveToday) : isWarDayForKey(today);
  const warStarted = inProgressWarDays.length > 0 || liveWar;
  const firstWarDay = inProgressWarDays[0] ?? (liveWar ? today : null);
  return { warStarted, firstWarDay };
}

function computeMemberJoinGrace({ tag, firstSeen, today, graceDays, history, warGraceCtx }) {
  if (!firstSeen) return { inGrace: false, ageDays: null };

  const ageDays = daysBetweenISO(firstSeen, today);
  if (ageDays === null || ageDays >= graceDays) return { inGrace: false, ageDays };

  const trackingEpoch = String(history?.trackingEpoch ?? '').trim() || null;
  if (trackingEpoch && firstSeen <= trackingEpoch) {
    // firstSeen==trackingEpoch is ambiguous by date alone: every pre-existing member
    // gets restamped to trackingEpoch the moment they reappear in the first post-reset
    // snapshot, which looks identical to a brand-new member who happens to join on the
    // same calendar day as the reset. rosterAtReset (captured by scripts/full-clan-reset.js
    // right before it wipes history.json) resolves the ambiguity by actual tag identity.
    // Older resets predating that field leave rosterAtReset absent — fall back to the
    // coarser date-only behavior rather than grant grace to everyone in that case.
    const rosterAtReset = Array.isArray(history?.rosterAtReset) ? history.rosterAtReset : null;
    if (!rosterAtReset || (tag && rosterAtReset.includes(tag))) {
      return { inGrace: false, ageDays };
    }
  }

  if (!warGraceCtx.warStarted) {
    return { inGrace: true, ageDays };
  }

  const { firstWarDay } = warGraceCtx;
  if (!firstWarDay) return { inGrace: true, ageDays };

  // War is live — only members who joined after the first war day keep grace.
  return { inGrace: firstSeen > firstWarDay, ageDays };
}

export function computeHistoryWeightedRisk(history, members, opts = {}) {
  const daysWindow = Number(opts.daysWindow ?? 7);
  const minHistoryDays = Number(opts.minHistoryDays ?? 3);

  const graceDays = Number(opts.graceDays ?? 7);
  // Defaults match what every explicit caller (schedule.js, ops.js) actually passes (14/2) —
  // callers that omit these opts (recruit/evaluator.js's unattended auto-role-mutation job,
  // recruit/commands/war-board.js) used to silently fall back to a stricter 7/3 window here,
  // so a member could read as a repeat offender on every dashboard while the automation that
  // actually applies Discord roles judged them clean. Same bug shape GRACE_DAYS already had.
  const repeatWindowDays = Number(opts.repeatWindowDays ?? 14);
  const repeatThreshold = Number(opts.repeatThreshold ?? 2);

  const targetDonations = Number(opts.targetDonations ?? 10);

  const today = todayKeyISO();
  const dayKeys = getLastNDays(history, daysWindow);

  function toNum(v) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  // Optional authoritative classifier (matches the signature used by summarizeWindow /
  // isHistoricalWarDay elsewhere) — prefers the stored warDay flag captured live from the
  // API's periodType over the raw activity-presence heuristic. Falls back to the heuristic
  // when no classifier is given (back-compat) or it returns null for a given day.
  const isWarDayForKey = typeof opts.isWarDayForKey === 'function' ? opts.isWarDayForKey : null;
  function isClanWarDay(d) {
    if (isWarDayForKey) {
      const resolved = isWarDayForKey(d);
      if (resolved != null) return Boolean(resolved);
    }
    return isWarActivityPresent(history?.days?.[d]?.members ?? {});
  }

  const clanWarDayKeys = dayKeys.filter(isClanWarDay);
  const expectedDecksPerDay = Number(opts.expectedDecksPerDay ?? 4);

  const warGraceCtx = buildWarGraceContext(history, isClanWarDay, {
    warActiveToday: opts.warActiveToday,
    today,
  });

  const results = members.map(m => {
    const firstSeen = history?.firstSeen?.[m.tag] ?? null;
    const { inGrace, ageDays } = computeMemberJoinGrace({
      tag: m.tag,
      firstSeen,
      today,
      graceDays,
      history,
      warGraceCtx,
    });

    const baselineKeys = clanWarDayKeys.length > 0 ? clanWarDayKeys : dayKeys;
    const eligibleKeys = firstSeen ? baselineKeys.filter(d => d >= firstSeen) : baselineKeys.slice();
    const effectiveKeys = eligibleKeys.length > 0
      ? eligibleKeys
      : (firstSeen ? dayKeys.filter(d => d >= firstSeen) : dayKeys);

    const s = effectiveKeys.map(d => {
      const row = history?.days?.[d]?.members?.[m.tag];
      if (row) return { day: d, ...row };
      return {
        day: d,
        tag: m.tag,
        name: m.name,
        fame: 0,
        decksUsedToday: 0,
        decksUsed: 0,
        repairPoints: 0,
        boatAttacks: 0,
        donations: 0,
        donationsReceived: 0,
        trophies: 0,
        role: m.role ?? 'member',
        expLevel: 0,
        lastSeen: m.lastSeen ?? null,
        clanRank: 0,
      };
    });
    // "Days" here means real Supercell days, not calendar buckets — one real day
    // straddles two buckets around the ~09:40 UTC rollover, so bucket-counting
    // deflates participation (played 2/2 real days but 2/3 buckets = 67%) and
    // inflates miss rates for everyone at once.
    const periodKeys = s.map(x => periodKeyForDay(history, x.day));
    const days = new Set(periodKeys).size;

    // NOTE: `fame` and `decksUsed` from River Race participants are typically cumulative within a race.
    // For "per-day" scoring we derive deltas between snapshots and use `decksUsedToday` as a fallback.
    const fameCumSeries = s.map(x => toNum(x.fame));
    const decksUsedCumSeries = s.map(x => toNum(x.decksUsed));
    const decksTodaySeries = s.map(x => toNum(x.decksUsedToday));
    const repairSeries = s.map(x => toNum(x.repairPoints));
    const boatSeries = s.map(x => toNum(x.boatAttacks));
    // Donations reset weekly on Supercell's own schedule, independent of the war cycle — same
    // cumulative-counter shape as fame/decks, so it needs the same delta treatment (see the
    // recruit/policy.js fix for the live incident this exact mistake already caused there:
    // a mid-week reset masked a member's real ~450 donated as a raw-averaged near-zero figure).
    const donCumSeries = s.map(x => toNum(x.donations));
    const donDeltaSeries = deltaSeries(donCumSeries);

    const fameDeltaSeries = deltaSeries(fameCumSeries);
    const decksDeltaSeries = deltaSeries(decksUsedCumSeries, decksTodaySeries, expectedDecksPerDay);

    // Aggregate per real Supercell day (insertion order = chronological, since the
    // series is): sums within a period, activity if any bucket in it was active.
    const byPeriod = new Map();
    s.forEach((x, i) => {
      const key = periodKeys[i];
      const e = byPeriod.get(key) ?? { fame: 0, decks: 0, repair: 0, boat: 0 };
      e.fame += fameDeltaSeries[i];
      e.decks += decksDeltaSeries[i];
      e.repair += repairSeries[i];
      e.boat += boatSeries[i];
      byPeriod.set(key, e);
    });
    const periodVals = [...byPeriod.values()];

    const fameActiveDays = periodVals.filter(p => p.fame > 0).length;
    const anyWarActivityDays = periodVals
      .filter(p => p.fame > 0 || p.repair > 0 || p.boat > 0 || p.decks > 0).length;

    const fameMissRate = days ? 1 - fameActiveDays / days : 1;

    const deckCompletionSeries = periodVals.map(p => {
      if (!expectedDecksPerDay || expectedDecksPerDay <= 0) return p.decks > 0 ? 1 : 0;
      return Math.max(0, Math.min(1, p.decks / expectedDecksPerDay));
    });
    const deckCompletionAvg = avg(deckCompletionSeries) ?? 0;
    const deckMissRate = 1 - deckCompletionAvg;

    const warParticipationRate = participationRate(anyWarActivityDays, days);
    const warMissRate = days ? 1 - (anyWarActivityDays / days) : 1;

    const avgDon = avg(donDeltaSeries) ?? 0;
    const avgRepair = avg(repairSeries) ?? 0;
    const avgBoat = avg(boatSeries) ?? 0;
    const donLowRate = targetDonations <= 0 ? 0 : Math.max(0, 1 - (avgDon / targetDonations));

    const last2 = deckCompletionSeries.slice(-2);
    const recentZeroPenalty = last2.length === 2 && last2[0] === 0 && last2[1] === 0 ? 0.15 : 0;

    // Inactivity penalty (if lastSeen is very old)
    const daysInactive = m.lastSeen ? daysSinceLastSeen(m.lastSeen) : null;
    const inactivityPenalty = daysInactive !== null && daysInactive > 7 ? Math.min(0.20, (daysInactive - 7) * 0.02) : 0;

    // Weighted risk: war participation is most important (60%), then decks (25%), donations (10%).
    // inactivityPenalty and recentZeroPenalty are already pre-scaled to their intended direct
    // contribution (not 0-1 rates), so they're added as-is rather than run through another
    // weight multiplier — inactivityPenalty used to be multiplied by an extra 0.05 here on top
    // of its own 0.20 cap, capping its real contribution at 1% instead of a meaningful swing for
    // sustained inactivity.
    let risk = (0.60 * warMissRate) + (0.25 * deckMissRate) + (0.10 * donLowRate) + inactivityPenalty + recentZeroPenalty;

    // Grace softens risk but DOES NOT remove them from "Bottom overall" (choice B)
    if (inGrace) risk = Math.max(0, risk - 0.25);
    risk = Math.max(0, Math.min(1, risk));

    // Insufficient tracked history means there isn't enough evidence to judge fairly — the
    // miss-rate components above assume a full day-by-day record, so 1-2 tracked days with
    // no activity yet can hit the maximal 100%, even though `reasons` below explicitly says
    // "not enough history yet, hold judgment." Cap well under every real decision threshold
    // (lowest is 0.55) so a thin/new tracking window can never trigger a demotion, OPS-risk
    // override, or boot review on its own — only genuine sustained poor performance can.
    if (days < minHistoryDays) risk = Math.min(risk, 0.30);

    // Same "not enough evidence" situation as above, but keyed on real war days instead of
    // calendar days: when the whole window has zero detected war days (a long training
    // stretch, or the first days after a full reset), baselineKeys/eligibleKeys/effectiveKeys
    // all fell back to raw calendar days above, so warMissRate=1 here reflects an absence of
    // war activity to measure, not real absenteeism — don't let a data gap spike risk clan-wide.
    if (clanWarDayKeys.length === 0) risk = Math.min(risk, 0.30);

    // Repeat offender: only if NOT in grace, and only based on eligible-bottom history
    const repeatHits = inGrace ? 0 : countEligibleBottomHits(history, m.tag, repeatWindowDays);
    const repeatOffender = !inGrace && repeatHits >= repeatThreshold;

    const reasons = [];
    if (inGrace) reasons.push(`🆕 Grace period (${ageDays ?? 0}/${graceDays} days)`);

    if (days >= minHistoryDays) {
      if (warMissRate >= 0.5) reasons.push(`War inactive ${Math.round(warMissRate * 100)}% (${anyWarActivityDays}/${days} days)`);
      if (fameMissRate >= 0.5 && fameActiveDays === 0) reasons.push(`Zero fame in last ${days} days`);
      if (deckMissRate >= 0.35) {
        const avgDecks = expectedDecksPerDay > 0 ? Math.round(deckCompletionAvg * expectedDecksPerDay * 10) / 10 : Math.round(deckCompletionAvg * 10) / 10;
        reasons.push(`Deck usage avg ${avgDecks}/${expectedDecksPerDay} per day (last ${days} days)`);
      }
      if (avgDon === 0 && Number(m.donations ?? 0) === 0) reasons.push('No donations recorded');
      if (daysInactive !== null && daysInactive > 7) reasons.push(`Inactive ${daysInactive} days`);
      if (!reasons.length && warParticipationRate >= 80) reasons.push('Consistent performer');
      else if (!reasons.length) reasons.push('Moderate activity');
    } else if (!inGrace) {
      reasons.push(`Not enough history yet (${days}/${minHistoryDays} days)`);
    }

    if (repeatOffender) reasons.push(`🔁 Repeat offender (${repeatHits}/${repeatWindowDays} days)`);

    // Promoted to the front before truncation below — repeatOffender can never coexist with
    // inGrace (it's forced false there), so this never displaces the grace-period notice.
    // Without this, a member tripping 4+ of the window-specific reasons above (war/fame/deck/
    // donation/inactivity) silently loses the repeat-offender flag to reasons.slice(0, 4) —
    // exactly the members with the most going on wrong are the ones most likely to have it cut,
    // even though every actual decision (promotions.js, analytics.js, evaluator.js) reads the
    // repeatOffender boolean directly and is unaffected — this only fixes what leaders see.
    const repeatIdx = reasons.findIndex(r => r.startsWith('🔁'));
    const orderedReasons = repeatIdx > 0
      ? [reasons[repeatIdx], ...reasons.slice(0, repeatIdx), ...reasons.slice(repeatIdx + 1)]
      : reasons;

    return {
      ...m,
      historyDays: days,
      inGrace,
      ageDays,
      fameMissRate,
      deckMissRate,
      warMissRate,
      warParticipationRate,
      fameActiveDays,
      anyWarActivityDays,
      avgDon,
      avgRepair,
      avgBoat,
      daysInactive,
      risk,
      repeatHits,
      repeatOffender,
      repeatWindowDays,
      reasons: orderedReasons.slice(0, 4),
      series: s,
    };
  });

  results.sort((a, b) => b.risk - a.risk);
  return results;
}
