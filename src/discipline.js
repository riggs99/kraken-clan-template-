import path from 'node:path';
import { cleanTag, todayKeyISO } from './util.js';
import { readJson, writeJson } from './json-store.js';

const DISCIPLINE_PATH = path.join(process.cwd(), 'data', 'discipline.json');

export function loadDiscipline() {
  return readJson(DISCIPLINE_PATH, { players: {} }, 'DISCIPLINE');
}

export function saveDiscipline(d) {
  writeJson(DISCIPLINE_PATH, d);
}

function isNextDay(prevISO, nextISO) {
  if (!prevISO || !nextISO) return false;
  try {
    const a = new Date(prevISO + 'T00:00:00Z').getTime();
    const b = new Date(nextISO + 'T00:00:00Z').getTime();
    return (b - a) === 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export function stageLabel(stage) {
  if (stage >= 3) return 'KICK REVIEW';
  if (stage === 2) return 'WARNED';
  if (stage === 1) return 'SEEN';
  return 'OK';
}

/**
 * Update per-player discipline state based on today's "weak links" list.
 *
 * Stages are based on consecutive daily report appearances:
 *  - 1st consecutive day: SEEN
 *  - 2nd consecutive day: WARNED
 *  - 3rd+ consecutive day: KICK REVIEW
 *
 * If a player does not appear in today's weak links list, their streak resets to 0.
 */
export function updateDisciplineFromDailyReport(flaggedPlayers, day = todayKeyISO()) {
  const d = loadDiscipline();
  d.players = d.players ?? {};

  const flaggedTags = new Set(
    (flaggedPlayers ?? [])
      .map(p => cleanTag(p?.tag))
      .filter(Boolean)
  );

  // Reset streaks for anyone not flagged today (only if they were tracked before).
  for (const [tag, rec] of Object.entries(d.players)) {
    if (!rec) continue;
    if (rec.lastDay === day) continue; // idempotency
    if (!flaggedTags.has(cleanTag(tag))) {
      rec.streak = 0;
      rec.stage = 0;
    }
  }

  const updated = [];

  for (const p of (flaggedPlayers ?? [])) {
    const tag = cleanTag(p?.tag);
    if (!tag) continue;

    const rec = d.players[tag] ?? { streak: 0, stage: 0, total: 0, lastDay: null, lastName: null };

    // Idempotency for repeated runs on the same day.
    if (rec.lastDay === day) {
      rec.lastName = p?.name ?? rec.lastName;
      d.players[tag] = rec;
      updated.push({ tag, ...rec });
      continue;
    }

    const nextStreak = rec.lastDay && isNextDay(rec.lastDay, day) ? (Number(rec.streak ?? 0) + 1) : 1;
    const stage = Math.min(3, nextStreak);

    rec.streak = nextStreak;
    rec.stage = stage;
    rec.total = Number(rec.total ?? 0) + 1;
    rec.lastDay = day;
    rec.lastName = p?.name ?? rec.lastName;

    d.players[tag] = rec;
    updated.push({ tag, ...rec });
  }

  saveDiscipline(d);
  return { day, updated, discipline: d };
}

