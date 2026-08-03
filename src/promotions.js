import { getLastNDays } from './history.js';
import { daysSinceLastSeen, participationRate, avg } from './util.js';
import { isWarActivityPresent, periodKeyForDay } from './war-cycle.js';
import { deltaSeries } from './window-delta.js';
import { HIGH_RISK_THRESHOLD } from './risk-score.js';

/**
 * Aggregate player stats over a time window
 */
function aggregatePlayerWindow(history, tag, windowDays, expectedDecksPerDay = 4, isWarDayForKey = null) {
  const dayKeys = getLastNDays(history, windowDays);
  const firstSeen = history?.firstSeen?.[tag] ?? null;
  const eligibleKeys = firstSeen ? dayKeys.filter(d => d >= firstSeen) : dayKeys;

  // Zero-fill days with no stored row for this tag (restricted to days at/after the member's
  // firstSeen, so pre-join days are never counted) — matches risk-score.js's
  // computeHistoryWeightedRisk, which explicitly zero-fills missing days as a miss. The previous
  // seriesForTag-based version silently skipped ALL missing days instead — including genuine
  // in-window gaps — shrinking both the numerator and denominator together and producing a
  // different (often more favorable) warParticipationRate than risk-score.js computes for the
  // exact same member/window on the same leader-facing report.
  const series = eligibleKeys.map(d => {
    const row = history?.days?.[d]?.members?.[tag];
    if (row) return { day: d, ...row };
    return { day: d, fame: 0, decksUsedToday: 0, decksUsed: 0, repairPoints: 0, boatAttacks: 0, donations: 0 };
  });

  function toNum(v) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  const fameCum = series.map(x => toNum(x.fame));
  const decksUsedCum = series.map(x => toNum(x.decksUsed));
  const decksToday = series.map(x => toNum(x.decksUsedToday));
  const repairs = series.map(x => toNum(x.repairPoints));
  const boats = series.map(x => toNum(x.boatAttacks));

  const fameDelta = deltaSeries(fameCum);
  const decksDelta = deltaSeries(decksUsedCum, decksToday, expectedDecksPerDay);

  // Donations reset weekly on Supercell's own schedule, independent of the war cycle — same
  // cumulative-counter shape as fame/decks, so it needs the same delta treatment (see the
  // recruit/policy.js fix for the live incident this exact mistake already caused there: a
  // mid-week reset masked a member's real ~450 donated as a raw-averaged near-zero figure).
  const donationCum = series.map(x => toNum(x.donations));
  const donationDelta = deltaSeries(donationCum);

  // Restrict participation/deck-miss math to actual war days — a window otherwise
  // includes training days where fame/decks are structurally 0, which deflated
  // warParticipationRate and inflated deckMissRate for every member regardless of
  // real war performance. Mirrors the isWarDayForKey pattern used everywhere else
  // (policy.js summarizeWindow, risk-score.js), falling back to the cruder
  // activity-presence heuristic when no authoritative classifier is supplied.
  const warDayFlags = series.map((r) => {
    const dayKey = r.day;
    const rows = history?.days?.[dayKey]?.members ?? {};
    if (typeof isWarDayForKey === 'function') {
      const resolved = isWarDayForKey(dayKey, rows);
      if (resolved != null) return Boolean(resolved);
    }
    return isWarActivityPresent(rows);
  });
  // Group war-flagged buckets by real Supercell day (periodIndex when stamped,
  // date-key fallback) — calendar buckets straddle the ~09:40 UTC rollover, so
  // bucket-counting over-counts war days and misfiles per-day activity.
  const warPeriods = new Map(); // key -> { decks, active }
  series.forEach((r, i) => {
    if (!warDayFlags[i]) return;
    const key = periodKeyForDay(history, r.day);
    const entry = warPeriods.get(key) ?? { decks: 0, active: false };
    entry.decks += toNum(decksDelta[i]);
    entry.active = entry.active || fameDelta[i] > 0 || decksDelta[i] > 0 || repairs[i] > 0 || boats[i] > 0;
    warPeriods.set(key, entry);
  });
  const warDays = warPeriods.size;

  const fameSum = fameDelta.reduce((sum, v) => sum + v, 0);
  const decksSum = decksDelta.reduce((sum, v) => sum + v, 0);
  const repairsSum = repairs.reduce((sum, v) => sum + v, 0);
  const boatAtkSum = boats.reduce((sum, v) => sum + v, 0);

  const donationAvg = avg(donationDelta) ?? 0;

  // Count war days (real periods) with any activity
  const anyWarActivityDays = [...warPeriods.values()].filter(p => p.active).length;

  const totalDays = series.length;
  const warParticipationRate = participationRate(anyWarActivityDays, warDays);

  const expectedDecks = Number.isFinite(expectedDecksPerDay) && expectedDecksPerDay > 0 ? expectedDecksPerDay : 4;
  const deckCompletion = [...warPeriods.values()].map(p => Math.max(0, Math.min(1, p.decks / expectedDecks)));
  const deckMissRate = warDays > 0 ? Math.round((1 - (avg(deckCompletion) ?? 0)) * 100) : 0;

  return {
    totalDays,
    warDays,
    fameSum,
    decksSum,
    repairsSum,
    boatAtkSum,
    donationAvg,
    warParticipationRate,
    deckMissRate,
    anyWarActivityDays,
    deckActiveDays: decksDelta.filter(v => v > 0).length,
  };
}

/**
 * Generate 3-6 reasons for a promotion decision
 */
function buildPromotionReasons(player, agg, flags, existingReasons = []) {
  const reasons = [];

  // Promotion reasons
  if (agg.warParticipationRate >= 90) {
    reasons.push(`Consistent war participation (${agg.warParticipationRate}%)`);
  }
  if (agg.deckMissRate <= 10) {
    reasons.push(`Strong deck discipline (${100 - agg.deckMissRate}% usage)`);
  }
  if (agg.fameSum > 0) {
    reasons.push(`Fame contribution: +${agg.fameSum} over ${agg.totalDays}d`);
  }
  if (agg.repairsSum > 100 && agg.boatAtkSum <= 2) {
    reasons.push(`Good support via repairs (+${agg.repairsSum})`);
  }

  const daysInactive = player.lastSeen ? daysSinceLastSeen(player.lastSeen) : null;
  if (daysInactive !== null && daysInactive <= 1) {
    reasons.push('Recently active');
  }

  if (!flags.repeatOffender && player.risk !== undefined && player.risk <= 0.15) {
    reasons.push('Clean history, no flags');
  }

  // Cap locally-derived reasons before merging in the risk engine's own reasons, so a member
  // hitting every local condition (up to 6 here) doesn't leave zero room for existingReasons.
  if (reasons.length > 4) reasons.length = 4;

  // Append existing reasons from risk engine if available
  if (Array.isArray(existingReasons) && existingReasons.length > 0) {
    for (const r of existingReasons) {
      if (!reasons.includes(r) && reasons.length < 6) {
        reasons.push(r);
      }
    }
  }

  // Ensure we have 3-6 reasons
  if (reasons.length < 3) {
    reasons.push('Meets promotion criteria');
  }

  return reasons.slice(0, 6);
}

/**
 * Generate 3-6 reasons for a demotion/kick decision
 */
function buildDemotionReasons(player, agg, flags, existingReasons = []) {
  const reasons = [];

  // Demotion/kick reasons
  if (agg.warParticipationRate < 60) {
    reasons.push(`War no-shows (${agg.warParticipationRate}% participation)`);
  }
  if (agg.deckMissRate >= 40) {
    reasons.push(`Missed decks (${agg.deckMissRate}% miss rate)`);
  }
  if (agg.fameSum === 0 && agg.repairsSum === 0) {
    reasons.push(`Zero war contribution over ${agg.totalDays}d`);
  } else if (agg.fameSum < 100) {
    reasons.push(`Low war contribution (${agg.fameSum} fame)`);
  }

  const daysInactive = player.lastSeen ? daysSinceLastSeen(player.lastSeen) : null;
  if (daysInactive !== null && daysInactive >= 7) {
    reasons.push(`Inactivity trend (${daysInactive}d since last seen)`);
  }

  if (flags.repeatOffender) {
    reasons.push(`Repeat offender (${flags.repeatHits} flags in ${flags.repeatWindowDays}d)`);
  }

  // Threshold matches the lowest risk-based demotion gate that calls this function (demoteCo,
  // risk>=0.55) instead of the old 0.65 — a co-leader demoted specifically for risk in
  // [0.55, 0.65) used to get no risk-related reason here at all, just the generic fallback below.
  if (player.risk !== undefined && player.risk >= 0.55) {
    reasons.push(`High risk score (${Math.round(player.risk * 100)}%)`);
  }

  if (agg.boatAtkSum > 2) {
    reasons.push(`Boat attacks detected (${agg.boatAtkSum} — discipline issue)`);
  }

  // Cap locally-derived reasons before merging in the risk engine's own reasons — with up to 7
  // possible local reasons here, the append loop below used to never run at all (already >=6
  // before it could check), silently dropping the risk engine's own diagnosis every time, and
  // slice(0,6) always cut the same last-computed (boat-attack) reason regardless of importance.
  if (reasons.length > 4) reasons.length = 4;

  // Append existing reasons from risk engine if available
  if (Array.isArray(existingReasons) && existingReasons.length > 0) {
    for (const r of existingReasons) {
      if (!reasons.includes(r) && reasons.length < 6) {
        reasons.push(r);
      }
    }
  }

  // Ensure we have 3-6 reasons
  if (reasons.length < 3) {
    reasons.push('Below performance threshold');
  }

  return reasons.slice(0, 6);
}

/**
 * Format stats line for a player
 */
function formatStatsLine(player, agg) {
  const daysInactive = player.lastSeen ? daysSinceLastSeen(player.lastSeen) : null;
  const inactiveStr = daysInactive !== null ? `${daysInactive}d` : '?';
  const riskPct = player.risk !== undefined ? Math.round(player.risk * 100) : 0;

  return `war:${agg.warParticipationRate}% • deckMiss:${agg.deckMissRate}% • fame:+${agg.fameSum} • decksUsed:${agg.decksSum} • repairs:+${agg.repairsSum} • boatAtk:${agg.boatAtkSum} • donAvg:${Math.round(agg.donationAvg)} • inactive:${inactiveStr} • risk:${riskPct}%`;
}

/**
 * Classify players into promotion/demotion/kick categories
 *
 * `members` is expected to be computeHistoryWeightedRisk's own output (see schedule.js) — each
 * entry already carries `.risk`/`.inGrace`/`.repeatOffender`/`.repeatHits`/`.repeatWindowDays`
 * computed against the same `history`, so those are trusted as-is here rather than independently
 * recomputed.
 */
export function classifyPlayers(history, members, windowDays = 14, expectedDecksPerDay = 4, isWarDayForKey = null) {
  const minHistoryDays = 7;

  const results = {
    promoteToElder: [],
    promoteToCo: [],
    demoteCo: [],
    demoteElder: [],
    kick: [],
  };

  for (const m of members) {
    const agg = aggregatePlayerWindow(history, m.tag, windowDays, expectedDecksPerDay, isWarDayForKey);
    const flags = {
      inGrace: Boolean(m.inGrace),
      repeatOffender: Boolean(m.repeatOffender),
      repeatHits: Number(m.repeatHits ?? 0),
      repeatWindowDays: Number(m.repeatWindowDays ?? 14),
    };

    const daysInactive = m.lastSeen ? daysSinceLastSeen(m.lastSeen) : null;

    // Kick-by-inactivity has no real dependency on war-day history (unlike promote/demote below,
    // which need `agg`'s stats to be meaningful) — m.risk and flags.repeatOffender already carry
    // their own independent minHistoryDays-style safeguards from risk-score.js. Evaluating this
    // ahead of the war-day guard below means a member who never plays a single war day (and so
    // could never clear `agg.warDays >= minHistoryDays`) can still be caught by sustained
    // real-world inactivity, instead of being permanently exempt from the one check meant for them.
    const kickEligible = (
      m.role === 'member' &&
      !flags.inGrace &&
      (
        (m.risk ?? 0) >= 0.85 ||
        (daysInactive !== null && daysInactive >= 14) ||
        (flags.repeatOffender && (m.risk ?? 0) >= HIGH_RISK_THRESHOLD)
      )
    );

    if (kickEligible) {
      const reasons = buildDemotionReasons(m, agg, flags, m.reasons);
      const statsLine = formatStatsLine(m, agg);
      results.kick.push({ player: m, statsLine, reasons });
    }

    // Skip promote/demote if insufficient war-day history — a member could have `minHistoryDays`
    // worth of tracked calendar days while having seen very few actual war days (training days
    // don't count toward proving real war performance either way). Kick's inactivity path above
    // doesn't need war history at all, so it isn't gated by this.
    if (agg.warDays < minHistoryDays) continue;

    // Classify: Promote → Elder (never alongside a kick recommendation for the same member —
    // handing out more responsibility to someone flagged for a kick review is contradictory)
    if (
      !kickEligible &&
      m.role === 'member' &&
      !flags.inGrace &&
      !flags.repeatOffender &&
      agg.warParticipationRate >= 90 &&
      agg.deckMissRate <= 10 &&
      (m.risk ?? 1) <= 0.15
    ) {
      const reasons = buildPromotionReasons(m, agg, flags, m.reasons);
      const statsLine = formatStatsLine(m, agg);
      results.promoteToElder.push({ player: m, statsLine, reasons });
    }

    // Classify: Promote → Co-Leader
    if (
      !kickEligible &&
      m.role === 'elder' &&
      !flags.inGrace &&
      !flags.repeatOffender &&
      agg.warParticipationRate >= 95 &&
      agg.deckMissRate <= 5 &&
      (m.risk ?? 1) <= 0.10
    ) {
      const reasons = buildPromotionReasons(m, agg, flags, m.reasons);
      const statsLine = formatStatsLine(m, agg);
      results.promoteToCo.push({ player: m, statsLine, reasons });
    }

    // Classify: Demote Co → Elder
    if (
      m.role === 'coLeader' &&
      ((m.risk ?? 0) >= 0.55 || agg.warParticipationRate < 60 || flags.repeatOffender)
    ) {
      const reasons = buildDemotionReasons(m, agg, flags, m.reasons);
      const statsLine = formatStatsLine(m, agg);
      results.demoteCo.push({ player: m, statsLine, reasons });
    }

    // Classify: Demote Elder → Member
    if (
      m.role === 'elder' &&
      ((m.risk ?? 0) >= 0.65 || agg.warParticipationRate < 50 || flags.repeatOffender)
    ) {
      const reasons = buildDemotionReasons(m, agg, flags, m.reasons);
      const statsLine = formatStatsLine(m, agg);
      results.demoteElder.push({ player: m, statsLine, reasons });
    }
  }

  return results;
}
