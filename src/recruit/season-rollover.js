// Shared season-boundary logic between scripts/season-reset.js (terminal, for
// whoever's comfortable with a computer/terminal) and the /recruit-season-reset
// Discord command (for any leader, no computer access needed) — one source of
// truth for the "can this roll happen" guard and the boundary-roll mutation
// itself, so the two trigger paths can never drift on either. The cross-process
// mutation lock itself lives in history.js (acquireHistoryLock/releaseHistoryLock)
// since it now also guards the bot's own routine snapshot writer, not just these
// two entry points — import it from there, not from here.

// User-facing description of what a season rollover does and doesn't touch —
// shared so the confirm dialog, the monthly reminder, and help text can't
// silently drift into describing different behavior for the same action.
export const SEASON_ROLLOVER_SCOPE_NOTE = 'Does not touch anyone\'s roles, tier status, or history — full history keeps accumulating and only the season-scoped stats reset.';

// Real CR seasons start on the first Monday of each month (per project intent —
// the game doesn't expose this via any API, so it's a hardcoded calendar rule,
// not real detection). Returns the day-of-month (1-7) of that month's first
// Monday.
function firstMondayDayOfMonth(year, monthIndex0) {
  const firstOfMonth = new Date(Date.UTC(year, monthIndex0, 1));
  const firstDow = firstOfMonth.getUTCDay(); // 0=Sun..6=Sat
  return 1 + ((1 - firstDow + 7) % 7); // 1=Monday
}

// True once `date` is on or after the first Monday of ITS OWN month — i.e.
// this month's rollover window has opened. "On or after," not "exactly on,"
// since a leader might roll a few days after the actual first Monday, not
// necessarily that exact day.
function isPastThisMonthsFirstMonday(date) {
  return date.getUTCDate() >= firstMondayDayOfMonth(date.getUTCFullYear(), date.getUTCMonth());
}

// Exported so schedule.js's monthly reminder checks the exact same "is today
// the day" rule as the guard below, instead of an independent copy that could
// silently drift from it (this was a real bug: schedule.js used to hand-roll
// its own version, plus a separate flat day-count "already rolled recently"
// heuristic that didn't match checkCanRollSeason's actual month-boundary logic
// at all — replaced there with a direct checkCanRollSeason(history).ok check).
export function isFirstMondayOfMonth(date) {
  return date.getUTCDate() === firstMondayDayOfMonth(date.getUTCFullYear(), date.getUTCMonth());
}

// Returns { ok: true, currentSeasonStart } or { ok: false, reason, currentSeasonStart }.
// Blocks a re-roll until the NEXT month's rollover window opens (not just N
// days later) — a leader who rolled a few days early last month still can't
// roll again until this month's actual first Monday arrives, matching the same
// calendar rule the monthly reminder uses. `force` bypasses this entirely (the
// terminal script's FORCE=1 — there is no Discord-side override, by design).
export function checkCanRollSeason(history, { force = false } = {}) {
  const currentSeasonStart = String(history?.seasonStart ?? history?.trackingEpoch ?? '').trim();
  if (force || !currentSeasonStart) return { ok: true, currentSeasonStart };

  const lastRollDate = new Date(`${currentSeasonStart}T00:00:00Z`);
  const now = new Date();
  if (!Number.isFinite(lastRollDate.getTime())) return { ok: true, currentSeasonStart };

  const sameCalendarMonth = lastRollDate.getUTCFullYear() === now.getUTCFullYear()
    && lastRollDate.getUTCMonth() === now.getUTCMonth();
  const rolloverWindowOpen = !sameCalendarMonth && isPastThisMonthsFirstMonday(now);

  if (!rolloverWindowOpen) {
    return {
      ok: false,
      reason: `The season was already rolled on ${currentSeasonStart} — it can't be rolled again until next month's rollover window opens (the first Monday of the month, or later).`,
      currentSeasonStart,
    };
  }
  return { ok: true, currentSeasonStart };
}

// Mutates a freshly-loaded history object in place to roll the season boundary
// forward. Caller owns loading fresh right before this (to avoid a stale-copy
// overwrite race with a concurrently-writing bot process) and saving afterward
// — this function does no I/O itself. outgoingStart is always derived from the
// SAME `history` object being mutated (never passed in externally) so a caller
// can't accidentally roll forward using a value read earlier, before the
// lock below was acquired, which could be stale by the time this runs.
export function rollSeasonBoundary(history, { today } = {}) {
  const todayKey = today ?? new Date().toISOString().slice(0, 10);
  const outgoing = String(history.seasonStart ?? history.trackingEpoch ?? '').trim();
  history.seasons = Array.isArray(history.seasons) ? history.seasons : [];
  if (outgoing) history.seasons.push({ start: outgoing, endedAt: todayKey });
  history.seasonStart = todayKey;
  return { outgoingStart: outgoing, today: todayKey };
}
