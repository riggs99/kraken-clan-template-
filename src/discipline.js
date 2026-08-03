import fs from 'node:fs';
import path from 'node:path';
import { cleanTag, todayKeyISO } from './util.js';

const DISCIPLINE_PATH = path.join(process.cwd(), 'data', 'discipline.json');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    // A corrupt/truncated file (e.g. a hard kill mid-write) used to silently fall back here
    // with no trace, and the very next save would then persist that empty state over the real
    // one — log it so a wiped discipline history is at least visible in the console/logs.
    console.error(`[DISCIPLINE] Failed to read ${filePath}, falling back to default:`, e?.message ?? String(e));
    return fallback;
  }
}

function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Write to a temp file then rename — a raw writeFileSync can leave a truncated/invalid file
  // if the process is killed mid-write (CLAUDE.md's own restart procedure is a hard `taskkill`,
  // not a graceful shutdown), and the next readJson() would then silently reset to empty and
  // persist that. A rename is atomic on the same filesystem, so readers never see a partial file.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function loadDiscipline() {
  return readJson(DISCIPLINE_PATH, { players: {} });
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

