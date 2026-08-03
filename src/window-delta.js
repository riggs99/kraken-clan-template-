// Converts a cumulative per-day series (fame/decksUsed are cumulative within a
// race, not per-day) into per-day deltas. Written independently three times
// before this (ops.js, risk-score.js, recruit/policy.js), each drifting out of
// sync as edge cases were found and fixed in only one copy at a time — e.g.
// policy.js already had the correct day-one handling below while the other two
// silently returned 0 for everyone's first tracked day. One shared
// implementation so a future fix only has to happen once.
function toNum(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Default day cap when a caller doesn't pass one — matches the clan's default
// expected-decks-per-day setting (recruit/db.js), NOT a hardcoded game rule.
// Callers that track decks should pass their own configured value (admin-adjustable
// via /recruit-settings, 1-10) so a clan running a non-default expectation doesn't
// get a legitimate day's decks silently zeroed out by a cap that no longer matches
// what they've configured.
const DEFAULT_DAY_CAP = 4;

// fallbackSeries (e.g. decksUsedToday) is an optional same-day-only reading used:
//   - on day one, in place of the cumulative value, when a member's first
//     tracked day may already carry several days' worth of pre-tracking
//     cumulative total (joined mid-race, or tracking started mid-race);
//   - on a detected reset (cumulative counter drops — a new race/period began),
//     as a defensive floor alongside the post-reset cumulative reading, so
//     neither signal alone can undercount right at the boundary.
// Without a fallback (e.g. fame, which has no same-day-only counterpart), day
// one and a reset both fall back to the raw cumulative value — the whole
// cumulative total IS that day's contribution when there's no prior day (or no
// pre-reset value) to subtract it from.
// dayCap: only used to disambiguate fallbackSeries===0 on day one — see below.
export function deltaSeries(cumSeries, fallbackSeries = [], dayCap = DEFAULT_DAY_CAP) {
  const out = [];
  for (let i = 0; i < cumSeries.length; i++) {
    const cur = toNum(cumSeries[i]);
    const fallback = fallbackSeries[i];
    const hasFallback = fallback !== undefined && fallback !== null;

    if (i === 0) {
      const fb = hasFallback ? toNum(fallback) : null;
      if (fb !== null && fb > 0) {
        // Same-day reading is authoritative when present (mid-race join who played today).
        out.push(fb);
      } else if (fb === 0 && cur > dayCap) {
        // Mid-race first snapshot on a day they didn't play — cumulative spans prior days.
        out.push(0);
      } else {
        // Either no fallback at all (e.g. fame), or fb===0 with cur within one day's
        // cap (post-flip snapshot where decksUsedToday reset but decksUsed already
        // reflects today's play) — both cases use the raw cumulative value.
        out.push(cur);
      }
      continue;
    }

    const prev = toNum(cumSeries[i - 1]);
    const diff = cur - prev;
    if (diff < 0) {
      out.push(hasFallback ? Math.max(toNum(fallback), cur) : cur);
      continue;
    }

    // Trust the real cumulative delta once it's non-negative — a same-day
    // fallback reading can repeat the same value across two consecutive
    // snapshots when a calendar-day boundary doesn't match the real period
    // rollover, and inflating a legitimate non-negative diff upward via that
    // fallback double-counts it.
    out.push(diff);
  }
  return out;
}
