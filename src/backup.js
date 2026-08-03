import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb, getRecruitRuntimeIds, getRecruitSetting, setRecruitSetting } from './recruit/db.js';
import { HISTORY_PATH } from './history.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DISCIPLINE_PATH = path.join(DATA_DIR, 'discipline.json');
const BACKUP_STAGING_DIR = path.join(DATA_DIR, 'backup-staging');
// Daily backups, kept for 30 days. At ~14 KB/day combined (measured against
// real production data) even a year of history.json/kraken.db growth stays
// far under Discord's per-file upload limit, so retention depth costs
// essentially nothing — 30 days trades a bit more channel history for a
// meaningfully bigger recovery window than the original 2-week default.
const RETENTION_COUNT = 30;

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function gzipFile(srcPath, destPath) {
  fs.writeFileSync(destPath, zlib.gzipSync(fs.readFileSync(srcPath)));
}

async function pruneOldBackups(channel, db, newMessageId) {
  let history;
  try {
    history = JSON.parse(String(getRecruitSetting(db, 'backup.messageHistory') ?? '[]'));
  } catch { history = []; }
  if (!Array.isArray(history)) history = [];

  if (isValidDiscordId(String(newMessageId ?? ''))) history.push(String(newMessageId));

  while (history.length > RETENTION_COUNT) {
    const oldestId = history.shift();
    if (!isValidDiscordId(oldestId)) continue;
    try {
      const msg = await channel.messages.fetch(oldestId);
      if (msg) await msg.delete();
    } catch {
      // already deleted or inaccessible — drop it from history anyway
    }
  }

  setRecruitSetting(db, 'backup.messageHistory', JSON.stringify(history));
}

// Daily snapshot of the files that hold everything KRAKEN knows: kraken.db
// (roster, tiers, probation/underwatch state, achievement records), history.json
// (every day's war stats, the source every tier decision is computed from), and
// discipline.json (per-member SEEN/WARNED/KICK REVIEW escalation state — same
// live-production risk profile as history.json, but previously had zero backup
// coverage). Uploaded to the logs channel as the storage/infra backing — no
// cloud credentials configured anywhere in this project, and a private Discord
// channel with a 2-week rolling window is a reasonable zero-setup home for a
// clan this size.
export async function runDatabaseBackup(client) {
  const db = initDb();
  const runtime = getRecruitRuntimeIds(db);
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  if (!isValidDiscordId(logsChannelId)) {
    console.error('[BACKUP] No logs channel configured, skipping backup.');
    return { ok: false, reason: 'no-logs-channel' };
  }

  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(BACKUP_STAGING_DIR, { recursive: true });

  const dbSnapshotPath = path.join(BACKUP_STAGING_DIR, `kraken-${today}.db`);
  const dbGzPath = `${dbSnapshotPath}.gz`;
  const historyGzPath = path.join(BACKUP_STAGING_DIR, `history-${today}.json.gz`);
  const disciplineGzPath = path.join(BACKUP_STAGING_DIR, `discipline-${today}.json.gz`);

  try {
    // WAL-safe: better-sqlite3's own .backup() checkpoints the write-ahead log
    // into a consistent snapshot — a raw copy of kraken.db could miss data still
    // sitting in the -wal file while the bot is actively writing to it.
    await db.backup(dbSnapshotPath);
    gzipFile(dbSnapshotPath, dbGzPath);
    fs.unlinkSync(dbSnapshotPath);

    // history.json and discipline.json are both written via a single synchronous
    // fs.writeFileSync (discipline.json now via a temp-file-then-rename, still
    // synchronous) — sync fs calls block Node's single thread for their duration,
    // so there's no window where this process could read either mid-write.
    gzipFile(HISTORY_PATH, historyGzPath);
    const hasDiscipline = fs.existsSync(DISCIPLINE_PATH);
    if (hasDiscipline) gzipFile(DISCIPLINE_PATH, disciplineGzPath);

    const ch = await client.channels.fetch(logsChannelId);
    if (!ch?.send) throw new Error('logs channel not sendable');

    const files = [
      { attachment: dbGzPath, name: `kraken-${today}.db.gz` },
      { attachment: historyGzPath, name: `history-${today}.json.gz` },
    ];
    if (hasDiscipline) files.push({ attachment: disciplineGzPath, name: `discipline-${today}.json.gz` });

    const sentMsg = await ch.send({
      content: `📦 KRAKEN daily backup — ${today}`,
      files,
      allowedMentions: { parse: [] },
    });

    await pruneOldBackups(ch, db, sentMsg?.id);

    console.log(`[BACKUP] Daily backup uploaded for ${today}.`);
    return { ok: true };
  } catch (e) {
    console.error('[BACKUP] Daily backup failed:', e?.message ?? String(e));
    return { ok: false, reason: String(e?.message ?? e) };
  } finally {
    for (const p of [dbSnapshotPath, dbGzPath, historyGzPath, disciplineGzPath]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort cleanup */ }
    }
  }
}

// Fires once per calendar day, independent of the war cycle — mirrors
// schedule.js's shouldSendDailyReport/shouldSendWeeklyReport gates exactly, so
// a crash/restart mid-day can't cause a duplicate backup (the persisted
// timestamp is checked the same way).
export function shouldRunBackup(lastBackup) {
  const now = new Date();
  const lastDate = lastBackup ? new Date(lastBackup) : null;
  const targetHour = 3; // 03:00 UTC — outside the 20:00 UTC report window and typical war-day activity

  if (!lastDate || lastDate.toDateString() !== now.toDateString()) {
    if (now.getUTCHours() === targetHour) return true;
  }
  return false;
}
