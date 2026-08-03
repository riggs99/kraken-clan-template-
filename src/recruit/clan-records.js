import { cleanTag } from '../util.js';
import { evaluateRecordStreakChallenge } from './policy.js';

/** Minimum consecutive war weeks before a record can be set or announced. */
export const CLAN_RECORD_MIN_STREAK = 4;

export const CLAN_RECORD_KEYS = {
  donor: 'record.donorStreak',
  war: 'record.warChampionStreak',
  attendance: 'record.attendanceStreak',
};

// Single source of truth for how each record type is displayed — evaluator.js's
// Hall of Fame reconciliation log and the end-of-season report both name a
// player's record by this, so the same accolade can't silently read as two
// different things in two different bot messages.
export const CLAN_RECORD_LABELS = {
  donor: 'Top Donor',
  war: 'War Champion',
  attendance: 'Iron Attendance',
};

function isRecordEntry(v) {
  return v && typeof v.tag === 'string' && Number.isFinite(Number(v.streak));
}

/** @returns {{ holder: object|null, priorHolders: object[] }} */
export function parseClanRecordState(raw) {
  const empty = { holder: null, priorHolders: [] };
  if (!raw) return empty;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  // Legacy flat shape: { tag, streak, weekDonations, ... }
  if (isRecordEntry(parsed) && parsed.holder === undefined) {
    return { holder: parsed, priorHolders: [] };
  }

  const holder = isRecordEntry(parsed.holder) ? parsed.holder : null;
  const priorHolders = Array.isArray(parsed.priorHolders)
    ? parsed.priorHolders.filter(isRecordEntry)
    : [];
  return { holder, priorHolders };
}

export function serializeClanRecordState(state) {
  const holder = isRecordEntry(state?.holder) ? state.holder : null;
  const priorHolders = Array.isArray(state?.priorHolders)
    ? state.priorHolders.filter(isRecordEntry)
    : [];
  return JSON.stringify({ holder, priorHolders });
}

/**
 * When the current holder is no longer in the live clan roster, revert to the
 * most recent prior holder still in clan — or clear the record entirely.
 */
export function reconcileClanRecordState(state, clanTagsSet) {
  const normalized = parseClanRecordState(state);
  const holder = normalized.holder;
  if (!holder?.tag) return { changed: false, state: normalized, reason: null };

  const holderTag = cleanTag(holder.tag);
  if (clanTagsSet.has(holderTag)) return { changed: false, state: normalized, reason: null };

  const prior = normalized.priorHolders;
  let newHolder = null;
  let newPrior = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    if (clanTagsSet.has(cleanTag(prior[i].tag))) {
      newHolder = prior[i];
      newPrior = prior.slice(0, i);
      break;
    }
  }

  return {
    changed: true,
    state: { holder: newHolder, priorHolders: newPrior },
    reason: newHolder ? 'reverted-to-prior' : 'cleared-no-prior-in-clan',
    departedTag: holderTag,
  };
}

export function evaluateClanRecordChallenge(candidate, storedHolder) {
  return evaluateRecordStreakChallenge(candidate, storedHolder ?? null);
}

/**
 * Merge a challenge outcome into holder + priorHolders history.
 */
export function applyClanRecordOutcome(state, outcome, candidate) {
  const current = parseClanRecordState(state);
  if (outcome === 'none' || outcome === 'tiebreak-retained') {
    return { state: current, changed: false };
  }
  if (outcome === 'extended') {
    return {
      state: { holder: candidate, priorHolders: current.priorHolders },
      changed: true,
    };
  }
  const priorHolders = [...current.priorHolders];
  if (current.holder && cleanTag(current.holder.tag) !== cleanTag(candidate.tag)) {
    priorHolders.push(current.holder);
  }
  return {
    state: { holder: candidate, priorHolders },
    changed: true,
  };
}

export function loadClanRecordState(db, getRecruitSetting, key) {
  return parseClanRecordState(getRecruitSetting(db, key));
}

export function saveClanRecordState(db, setRecruitSetting, key, state) {
  setRecruitSetting(db, key, serializeClanRecordState(state));
}

/** Reconcile all hall-of-fame records against the live clan roster. Returns changes for logging. */
export function reconcileAllClanRecords(db, getRecruitSetting, setRecruitSetting, clanTagsSet) {
  const changes = [];
  for (const [recordKey, settingKey] of Object.entries(CLAN_RECORD_KEYS)) {
    const before = loadClanRecordState(db, getRecruitSetting, settingKey);
    const { changed, state, reason, departedTag } = reconcileClanRecordState(before, clanTagsSet);
    if (changed) {
      saveClanRecordState(db, setRecruitSetting, settingKey, state);
      changes.push({ label: CLAN_RECORD_LABELS[recordKey] ?? recordKey, key: recordKey, reason, departedTag, newHolderTag: state.holder?.tag ?? null });
    }
  }
  return changes;
}

export function candidateMeetsMinimum(candidate) {
  return candidate && Number(candidate.streak) >= CLAN_RECORD_MIN_STREAK;
}

/**
 * Returns tag -> [{ label, key, streak }] for every currently-held clan record —
 * lets a report decorate a player's name as a record holder without the caller
 * having to load and check all 3 CLAN_RECORD_KEYS itself. `label` is already the
 * resolved friendly text (CLAN_RECORD_LABELS), not the short key — callers don't
 * need their own copy of that lookup table.
 */
export function loadAllClanRecordHolders(db, getRecruitSetting) {
  const holders = new Map();
  for (const [recordKey, settingKey] of Object.entries(CLAN_RECORD_KEYS)) {
    const state = loadClanRecordState(db, getRecruitSetting, settingKey);
    const holder = state.holder;
    if (!holder?.tag) continue;
    const tag = cleanTag(holder.tag);
    const list = holders.get(tag) ?? [];
    list.push({ label: CLAN_RECORD_LABELS[recordKey] ?? recordKey, key: recordKey, streak: Number(holder.streak ?? 0) });
    holders.set(tag, list);
  }
  return holders;
}
