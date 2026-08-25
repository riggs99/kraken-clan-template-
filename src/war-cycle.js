// Fallback only: the authoritative signal is the live API `periodType`, and going
// forward each daily snapshot stores its own war/training flag. The anchor is a
// last-resort tiebreaker for deep history that predates stored flags.
// Calibrated against one real clan's observed war cadence (war-1 begins the day
// this marks) — Clash Royale's Clan Wars 2 schedule is the same real-world UTC
// days for every clan, so this is very likely a universal constant rather than
// something that needs re-tuning per deployment, but verify it against your own
// clan's `periodType` data before relying on it for anything beyond the
// last-resort tiebreaker role described above. Override via
// RECRUIT_WAR_ANCHOR_UTC/RECRUIT_WAR_ANCHOR_EPOCH_MS if it ever doesn't match.
// One day earlier than the first calibration — Feb 27 lined up war-1 with the API's
// periodIndex-4 (war day 2); Feb 26 aligns war-1 with periodIndex-3.
const DEFAULT_WAR_ANCHOR_UTC = '2026-02-26T09:00:00Z';

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function isWarActivityPresent(rowsOrMembers) {
  const list = Array.isArray(rowsOrMembers)
    ? rowsOrMembers
    : Object.values(rowsOrMembers ?? {});
  if (!Array.isArray(list) || list.length === 0) return false;

  let total = 0;
  for (const r of list) {
    total += num(r?.fame) + num(r?.repairPoints) + num(r?.boatAttacks) + num(r?.decksUsedToday);
    if (total > 0) return true;
  }
  return false;
}

export function isLiveWarDayFromRaceState(race) {
  const state = String(race?.state ?? '').toLowerCase();
  if (!state) return null;

  if (state.includes('training')) return false;
  if (state.includes('collection')) return false;
  if (state.includes('warmup')) return false;
  if (state.includes('ended')) return false;
  if (state.includes('notinwar')) return false;
  if (state.includes('war')) return true;

  return null;
}

// Authoritative live signal: the CR API exposes periodType = training | warDay | colosseum.
export function warDayFromPeriodType(race) {
  const pt = String(race?.periodType ?? '').trim().toLowerCase();
  if (!pt) return null;
  if (pt.includes('training')) return false;
  if (pt.includes('warday') || pt === 'war' || pt.includes('colosseum')) return true;
  return null;
}

// `periodIndex` is the day-of-season counter (e.g. 0..27), so reduce it to the
// 0..6 position within the race week. Days 0..2 are training; 3..6 are war days.
// Explicitly null-checked before Number(): Number(null) is 0, not NaN, so an
// explicitly-null periodIndex used to silently read as day-index 0 ("training day
// 1") instead of "unknown."
export function raceWeekPosition(periodIndex) {
  if (periodIndex === null || periodIndex === undefined) return null;
  const idx = Number(periodIndex);
  if (!Number.isFinite(idx)) return null;
  return ((idx % 7) + 7) % 7;
}

export function isWarDayFromRacePeriod(race) {
  const inWeek = raceWeekPosition(race?.periodIndex);
  if (inWeek === null) return null;
  return inWeek > 2;
}

export function parseWarAnchorMsFromEnv() {
  const rawUtc = String(process.env.RECRUIT_WAR_ANCHOR_UTC ?? '').trim();
  const rawEpoch = String(process.env.RECRUIT_WAR_ANCHOR_EPOCH_MS ?? '').trim();

  if (rawEpoch) {
    const epoch = Number(rawEpoch);
    if (Number.isFinite(epoch) && epoch > 0) return epoch;
  }
  if (rawUtc) {
    const parsed = Date.parse(rawUtc);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fallback = Date.parse(DEFAULT_WAR_ANCHOR_UTC);
  return Number.isFinite(fallback) ? fallback : null;
}

export function warDayFromAnchorCycle(nowMs, anchorMs) {
  const now = Number(nowMs);
  const anchor = Number(anchorMs);
  if (!Number.isFinite(now) || !Number.isFinite(anchor) || anchor <= 0) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  const cycleMs = 7 * dayMs;
  const diff = now - anchor;
  const offsetMs = ((diff % cycleMs) + cycleMs) % cycleMs;
  const cycleDayIndex = Math.floor(offsetMs / dayMs);
  const isWarDay = cycleDayIndex >= 0 && cycleDayIndex <= 3;

  return {
    isWarDay,
    cycleDayIndex,
    cycleLabel: isWarDay ? `war-${cycleDayIndex + 1}` : `training-${cycleDayIndex - 3}`,
    anchorMs: anchor,
  };
}

export function getWarDayDecision({ race, snapshotWarDay = false, nowMs = Date.now(), anchorMs = null } = {}) {
  const periodTypeWarDay = warDayFromPeriodType(race);
  const periodWarDay = isWarDayFromRacePeriod(race);
  const liveWarDay = isLiveWarDayFromRaceState(race);
  const anchorDecision = warDayFromAnchorCycle(nowMs, anchorMs ?? parseWarAnchorMsFromEnv());

  let shouldJudgeToday = false;
  let source = 'none';

  // Priority: authoritative API periodType -> live state -> period index ->
  // today's observed activity -> anchor cycle (tiebreaker for missing API data).
  if (periodTypeWarDay != null) {
    shouldJudgeToday = periodTypeWarDay;
    source = 'api-periodType';
  } else if (liveWarDay != null) {
    shouldJudgeToday = liveWarDay;
    source = 'api-state';
  } else if (periodWarDay != null) {
    shouldJudgeToday = periodWarDay;
    source = 'api-period';
  } else if (snapshotWarDay) {
    shouldJudgeToday = true;
    source = 'snapshot';
  } else if (anchorDecision != null) {
    shouldJudgeToday = Boolean(anchorDecision.isWarDay);
    source = 'anchor';
  }

  return {
    shouldJudgeToday,
    source,
    periodTypeWarDay,
    periodWarDay,
    liveWarDay,
    snapshotWarDay: Boolean(snapshotWarDay),
    anchorDecision,
  };
}

// Classify a historical day as a war day, preferring evidence over the anchor.
// 1) the flag captured live in the snapshot (authoritative going forward),
// 2) actual battle activity that day (decks used, NOT cumulative fame which lingers
//    across the race week and made post-war training days look active),
// 3) the anchor cycle, only as a tiebreaker for low/ambiguous straggler activity.
export function classifyHistoricalWarDay(dayEntry, { anchorLabelIsWar = null, rosterSize = 0 } = {}) {
  if (dayEntry && typeof dayEntry.warDay === 'boolean') return dayEntry.warDay;

  const periodType = warDayFromPeriodType(dayEntry);
  if (periodType != null) return periodType;

  const periodWarDay = isWarDayFromRacePeriod(dayEntry);
  if (periodWarDay != null) return periodWarDay;

  const members = Object.values(dayEntry?.members ?? {});
  let usedDecks = 0;
  let battlers = 0;
  for (const m of members) {
    const decks = num(m?.decksUsedToday);
    if (decks > 0) {
      usedDecks += decks;
      battlers += 1;
    }
  }

  const roster = rosterSize > 0 ? rosterSize : members.length;
  const strongThreshold = Math.max(6, Math.round(roster * 0.2));
  if (battlers >= strongThreshold) return true;
  if (usedDecks === 0) return false;

  if (anchorLabelIsWar != null) return Boolean(anchorLabelIsWar);
  return battlers > 0;
}

// Identity of the real Supercell day a history bucket belongs to. Buckets are keyed
// by UTC calendar date, but Supercell's period rolls over ~09:40 UTC, so one real
// day can straddle two buckets (and two buckets can share one real day). Buckets
// written since periodIndex stamping began carry the authoritative period number;
// older buckets fall back to their date key, which degrades to the historical
// one-bucket-one-day behavior.
export function periodKeyForDay(history, dayKey) {
  const p = Number(history?.days?.[dayKey]?.periodIndex);
  return Number.isFinite(p) ? `p${p}` : `d${String(dayKey)}`;
}

export function isHistoricalWarDay(history, dayKey, anchorMs = null) {
  const dayEntry = history?.days?.[dayKey];
  if (!dayEntry) return false;
  const dayMs = Date.parse(`${String(dayKey)}T12:00:00Z`);
  const anchor = Number.isFinite(dayMs)
    ? warDayFromAnchorCycle(dayMs, anchorMs ?? parseWarAnchorMsFromEnv())
    : null;
  const rosterSize = Object.keys(dayEntry?.members ?? {}).length;
  return classifyHistoricalWarDay(dayEntry, {
    anchorLabelIsWar: anchor?.isWarDay ?? null,
    rosterSize,
  });
}
