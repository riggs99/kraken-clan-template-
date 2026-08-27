import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'kraken.db');

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function initDb() {
  const dbPath = String(process.env.KRAKEN_DB_PATH || DEFAULT_DB_PATH);
  ensureParentDir(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      discord_id TEXT PRIMARY KEY,
      player_tag TEXT,
      region TEXT,
      timezone TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      last_score INTEGER,
      last_verdict TEXT,
      last_reasons TEXT,
      cooldown_until INTEGER,
      probation_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trial_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      player_tag TEXT,
      score INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      reasons TEXT NOT NULL,
      stats_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trial_ledger_discord_id
      ON trial_ledger(discord_id);

    CREATE INDEX IF NOT EXISTS idx_trial_ledger_created_at
      ON trial_ledger(created_at);

    CREATE TABLE IF NOT EXISTS watchlist (
      player_tag TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      player_tag TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recruit_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS breaks (
      discord_id TEXT PRIMARY KEY,
      break_until INTEGER NOT NULL,
      reason TEXT,
      granted_by TEXT,
      granted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS break_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      days INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|started|acknowledged|approved|denied|cancelled
      requested_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_break_requests_discord_id
      ON break_requests(discord_id);

    CREATE INDEX IF NOT EXISTS idx_break_requests_requested_at
      ON break_requests(requested_at);

    CREATE TABLE IF NOT EXISTS underwatch_state (
      discord_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      pause_accum_ms INTEGER NOT NULL DEFAULT 0,
      pause_started_at INTEGER,
      last_notified_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS probation_state (
      discord_id TEXT PRIMARY KEY,
      clean_streak_days INTEGER NOT NULL DEFAULT 0,
      last_eval_day TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_break_enforcement (
      discord_id TEXT PRIMARY KEY,
      break_until INTEGER NOT NULL,
      warn_count INTEGER NOT NULL DEFAULT 0,
      last_warn_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS name_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_tag TEXT NOT NULL,
      old_name TEXT NOT NULL,
      new_name TEXT NOT NULL,
      day TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      UNIQUE(player_tag, day)
    );

    CREATE INDEX IF NOT EXISTS idx_name_changes_player_tag
      ON name_changes(player_tag);

    CREATE INDEX IF NOT EXISTS idx_name_changes_day
      ON name_changes(day);

    CREATE TABLE IF NOT EXISTS waitlist (
      discord_id   TEXT PRIMARY KEY,
      joined_at    INTEGER NOT NULL,
      confirmed_at INTEGER,
      pinged_at    INTEGER
    );

    -- Keyed by player_tag (not discord_id) to match how /ops already identifies players —
    -- the main-server dashboard tracks the clan roster by tag first, Discord linkage is
    -- secondary and often absent (a clan member who hasn't linked yet still needs to be
    -- warnable). No FK to profiles: profiles.player_tag has no UNIQUE constraint (discord_id
    -- is the real key there), so a real foreign key isn't valid SQLite here anyway. Previously
    -- lived in a separate data/metadata.json file, disconnected from every other player-state
    -- table — moved here so all player state lives in one place instead of split across a
    -- second, unrelated storage system.
    CREATE TABLE IF NOT EXISTS player_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_tag TEXT NOT NULL,
      reason TEXT NOT NULL,
      issued_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_player_warnings_player_tag
      ON player_warnings(player_tag);

    CREATE TABLE IF NOT EXISTS player_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_tag TEXT NOT NULL,
      note TEXT NOT NULL,
      issued_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_player_notes_player_tag
      ON player_notes(player_tag);
  `);

  // Migrate existing waitlist rows that lack the new columns
  for (const colSql of ['confirmed_at INTEGER', 'pinged_at INTEGER']) {
    try { db.prepare(`ALTER TABLE waitlist ADD COLUMN ${colSql}`).run(); } catch { /* already exists */ }
  }

  return db;
}

export function getRecruitSetting(db, key) {
  const row = db.prepare('SELECT value FROM recruit_settings WHERE key = ?').get(String(key));
  return row?.value ?? null;
}

export function setRecruitSetting(db, key, value) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO recruit_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  `).run(String(key), String(value), now);
}

export function getExpectedDecksPerDay(db) {
  try {
    const raw = getRecruitSetting(db, 'policy.expectedDecksPerDay');
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* ignore */ }
  return Number(process.env.EXPECTED_DECKS_PER_DAY ?? 4);
}

export function setExpectedDecksPerDay(db, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error(`Invalid value: ${value}. Must be 1–10.`);
  setRecruitSetting(db, 'policy.expectedDecksPerDay', String(n));
}

export function recordNameChanges(db, nameChanges) {
  if (!Array.isArray(nameChanges) || nameChanges.length === 0) return [];
  const now = Date.now();
  const recorded = [];
  const check = db.prepare('SELECT new_name FROM name_changes WHERE player_tag = ? AND day = ?');
  const upsert = db.prepare(`
    INSERT INTO name_changes (player_tag, old_name, new_name, day, detected_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_tag, day) DO UPDATE SET new_name = excluded.new_name, detected_at = excluded.detected_at
  `);
  for (const { tag, oldName, newName, day } of nameChanges) {
    if (!tag || !oldName || !newName || !day) continue;
    const existing = check.get(String(tag), String(day));
    if (existing?.new_name === newName) continue; // Already logged this exact change today
    upsert.run(String(tag), String(oldName), String(newName), String(day), now);
    recorded.push({ tag, oldName, newName, day });
  }
  return recorded;
}

export function getNameHistory(db, playerTag) {
  return db.prepare(
    'SELECT old_name, new_name, day FROM name_changes WHERE player_tag = ? ORDER BY day ASC'
  ).all(String(playerTag));
}

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

export function syncRecruitRuntimeFromConfig(db, { recruitConfig, opsConfig } = {}) {
  // Matches setup.js's own enableRelinkChannel check (default on) — without this, a leftover
  // channels.relinkChannelId value sitting in config would resurrect a stored ID that setup.js
  // just deliberately cleared, the next time the bot starts up. syncRecruitRuntimeFromConfig
  // runs unconditionally on every startup, so this has to agree with setup.js or the two paths
  // fight each other on whether relink is actually off.
  const relinkChannelEnabled = recruitConfig?.enableRelinkChannel !== false;
  const channelMappings = [
    ['channels.opsChannelId', opsConfig?.channels?.opsChannelId],
    ['channels.logsChannelId', recruitConfig?.channels?.decisionsLogChannelId],
    ['channels.decisionsChannelId', recruitConfig?.channels?.decisionsChannelId],
    ['channels.publicDecisionsChannelId', recruitConfig?.channels?.publicDecisionsChannelId],
    ['channels.welcomeChannelId', recruitConfig?.channels?.welcomeChannelId],
    ...(relinkChannelEnabled ? [['channels.relinkChannelId', recruitConfig?.channels?.relinkChannelId]] : []),
    ['channels.applyChannelId', recruitConfig?.channels?.applyChannelId],
    ['channels.celebrationsThreadId', recruitConfig?.channels?.celebrationsThreadId],
    ['channels.weeklySummaryThreadId', recruitConfig?.channels?.weeklySummaryThreadId],
    ['channels.leadersChatChannelId', recruitConfig?.channels?.leadersChatChannelId],
    ['channels.decisionsLogChannelId', recruitConfig?.channels?.decisionsLogChannelId],
    ['channels.removalQueueChannelId', recruitConfig?.channels?.removalQueueChannelId],
    ['channels.appealsChannelId', recruitConfig?.channels?.appealsChannelId],
    ['channels.waitingListChannelId', recruitConfig?.channels?.waitingListChannelId],
  ];

  const roleMappings = [
    ['roles.newArrivalRoleId', recruitConfig?.roles?.newArrivalRoleId],
    ['roles.applicantRoleId', recruitConfig?.roles?.applicantRoleId],
    ['roles.approvedRoleId', recruitConfig?.roles?.approvedRoleId],
    ['roles.probationRoleId', recruitConfig?.roles?.probationRoleId],
    ['roles.removeRoleId', recruitConfig?.roles?.removeRoleId],
    ['roles.waitlistRoleId', recruitConfig?.roles?.waitlistRoleId],
    // These five were missing entirely — meaning a clan that already has its own "leaders"
    // role (or any of the other tier roles) had no way to point KRAKEN at it. Without a
    // config override, /recruit-setup can only ever find a role by a stored ID from a
    // previous KRAKEN run (name-matching was deliberately removed as unsafe on a real
    // server), so it would silently create a second, separately-managed role with the same
    // name instead of adopting the clan's existing one.
    ['roles.leadersRoleId', recruitConfig?.roles?.leadersRoleId],
    ['roles.memberRoleId', recruitConfig?.roles?.memberRoleId],
    ['roles.warcoreRoleId', recruitConfig?.roles?.warcoreRoleId],
    ['roles.underwatchRoleId', recruitConfig?.roles?.underwatchRoleId],
    ['roles.onBreakRoleId', recruitConfig?.roles?.onBreakRoleId],
  ];

  for (const [key, value] of [...channelMappings, ...roleMappings]) {
    const next = String(value ?? '').trim();
    if (!isValidDiscordId(next)) continue;
    if (String(getRecruitSetting(db, key) ?? '') === next) continue;
    setRecruitSetting(db, key, next);
  }
}

export function getRecruitRuntimeIds(db) {
  const keys = [
    'channels.opsChannelId',
    'channels.logsChannelId',
    'channels.decisionsChannelId',
    'channels.publicDecisionsChannelId',
    'channels.welcomeChannelId',
    'channels.relinkChannelId',
    'channels.applyChannelId',
    'channels.celebrationsThreadId',
    'channels.weeklySummaryThreadId',
    'channels.leadersChatChannelId',
    'channels.decisionsLogChannelId',
    'channels.onBreakChannelId',
    'channels.removalQueueChannelId',
    'channels.appealsChannelId',
    'channels.waitingListChannelId',
    'channels.leadersCategoryId',
    'roles.leadersRoleId',
    'roles.memberRoleId',
    'roles.warcoreRoleId',
    'roles.underwatchRoleId',
    'roles.newArrivalRoleId',
    'roles.applicantRoleId',
    'roles.approvedRoleId',
    'roles.probationRoleId',
    'roles.onBreakRoleId',
    'roles.removeRoleId',
    'roles.waitlistRoleId',
  ];
  const out = {};
  for (const k of keys) out[k] = getRecruitSetting(db, k);
  return {
    channels: {
      opsChannelId: out['channels.opsChannelId'],
      logsChannelId: out['channels.logsChannelId'],
      decisionsChannelId: out['channels.decisionsChannelId'],
      publicDecisionsChannelId: out['channels.publicDecisionsChannelId'],
      welcomeChannelId: out['channels.welcomeChannelId'],
      relinkChannelId: out['channels.relinkChannelId'],
      applyChannelId: out['channels.applyChannelId'],
      celebrationsThreadId: out['channels.celebrationsThreadId'],
      weeklySummaryThreadId: out['channels.weeklySummaryThreadId'],
      leadersChatChannelId: out['channels.leadersChatChannelId'],
      decisionsLogChannelId: out['channels.decisionsLogChannelId'],
      onBreakChannelId: out['channels.onBreakChannelId'],
      removalQueueChannelId: out['channels.removalQueueChannelId'],
      appealsChannelId: out['channels.appealsChannelId'],
      waitingListChannelId: out['channels.waitingListChannelId'],
      leadersCategoryId: out['channels.leadersCategoryId'],
    },
    roles: {
      leadersRoleId: out['roles.leadersRoleId'],
      memberRoleId: out['roles.memberRoleId'],
      warcoreRoleId: out['roles.warcoreRoleId'],
      underwatchRoleId: out['roles.underwatchRoleId'],
      newArrivalRoleId: out['roles.newArrivalRoleId'],
      applicantRoleId: out['roles.applicantRoleId'],
      approvedRoleId: out['roles.approvedRoleId'],
      probationRoleId: out['roles.probationRoleId'],
      onBreakRoleId: out['roles.onBreakRoleId'],
      removeRoleId: out['roles.removeRoleId'],
      waitlistRoleId: out['roles.waitlistRoleId'],
    }
  };
}

export function addToWaitlist(db, discordId) {
  db.prepare(`
    INSERT INTO waitlist (discord_id, joined_at)
    VALUES (?, ?)
    ON CONFLICT(discord_id) DO NOTHING
  `).run(String(discordId), Date.now());
}

export function removeFromWaitlist(db, discordId) {
  db.prepare('DELETE FROM waitlist WHERE discord_id = ?').run(String(discordId));
}

export function getWaitlist(db) {
  return db.prepare('SELECT discord_id, joined_at FROM waitlist ORDER BY joined_at ASC').all();
}

export function getNextWaiting(db) {
  return db.prepare('SELECT discord_id, joined_at FROM waitlist ORDER BY joined_at ASC LIMIT 1').get() ?? null;
}

export function confirmWaitlist(db, discordId) {
  db.prepare('UPDATE waitlist SET confirmed_at = ? WHERE discord_id = ?')
    .run(Date.now(), String(discordId));
}

export function setPingedAt(db, discordId, ts) {
  db.prepare('UPDATE waitlist SET pinged_at = ? WHERE discord_id = ?')
    .run(ts ?? Date.now(), String(discordId));
}

// Players 7+ days since join/last-confirm who haven't been pinged yet for this cycle.
export function getPlayersToPing(db) {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT discord_id, joined_at, confirmed_at, pinged_at
    FROM waitlist
    WHERE (? - COALESCE(confirmed_at, joined_at)) >= ?
      AND (pinged_at IS NULL OR pinged_at < COALESCE(confirmed_at, joined_at))
  `).all(Date.now(), sevenDaysMs);
}

// Players pinged 48h+ ago who haven't confirmed since the ping.
export function getPlayersToExpire(db) {
  const fortyEightHoursMs = 48 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT discord_id, joined_at, confirmed_at, pinged_at
    FROM waitlist
    WHERE pinged_at IS NOT NULL
      AND (? - pinged_at) >= ?
      AND (confirmed_at IS NULL OR confirmed_at < pinged_at)
  `).all(Date.now(), fortyEightHoursMs);
}

export function getActiveBreak(db, discordId) {
  const row = db.prepare('SELECT break_until, reason, granted_by, granted_at FROM breaks WHERE discord_id = ?')
    .get(String(discordId));
  if (!row) return null;
  const breakUntil = Number(row.break_until ?? 0) || 0;
  if (breakUntil <= Date.now()) return null;
  return {
    breakUntil,
    reason: row.reason ?? null,
    grantedBy: row.granted_by ?? null,
    grantedAt: Number(row.granted_at ?? 0) || 0,
  };
}

export function upsertActiveBreak(db, { discordId, breakUntil, reason, grantedBy }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO breaks (discord_id, break_until, reason, granted_by, granted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      break_until = excluded.break_until,
      reason = excluded.reason,
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at,
      updated_at = excluded.updated_at;
  `).run(String(discordId), Number(breakUntil), reason ? String(reason) : null, grantedBy ? String(grantedBy) : null, now, now);
}

export function getUnderwatchState(db, discordId) {
  const row = db.prepare(`
    SELECT started_at, pause_accum_ms, pause_started_at, last_notified_at
    FROM underwatch_state
    WHERE discord_id = ?
  `).get(String(discordId));

  if (!row) return null;

  return {
    startedAt: Number(row.started_at ?? 0) || 0,
    pauseAccumMs: Number(row.pause_accum_ms ?? 0) || 0,
    pauseStartedAt: row.pause_started_at == null ? null : (Number(row.pause_started_at ?? 0) || null),
    lastNotifiedAt: row.last_notified_at == null ? null : (Number(row.last_notified_at ?? 0) || null),
  };
}

export function upsertUnderwatchState(db, { discordId, startedAt, pauseAccumMs, pauseStartedAt, lastNotifiedAt }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO underwatch_state (discord_id, started_at, pause_accum_ms, pause_started_at, last_notified_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      started_at = excluded.started_at,
      pause_accum_ms = excluded.pause_accum_ms,
      pause_started_at = excluded.pause_started_at,
      last_notified_at = excluded.last_notified_at,
      updated_at = excluded.updated_at;
  `).run(
    String(discordId),
    Number(startedAt),
    Number(pauseAccumMs ?? 0),
    pauseStartedAt == null ? null : Number(pauseStartedAt),
    lastNotifiedAt == null ? null : Number(lastNotifiedAt),
    now
  );
}

export function clearUnderwatchState(db, discordId) {
  db.prepare('DELETE FROM underwatch_state WHERE discord_id = ?').run(String(discordId));
}

export function getProbationState(db, discordId) {
  const row = db.prepare(`
    SELECT clean_streak_days, last_eval_day, paused
    FROM probation_state
    WHERE discord_id = ?
  `).get(String(discordId));

  if (!row) return null;

  return {
    cleanStreakDays: Number(row.clean_streak_days ?? 0) || 0,
    lastEvalDay: row.last_eval_day == null ? null : String(row.last_eval_day),
    paused: Boolean(Number(row.paused ?? 0)),
  };
}

export function upsertProbationState(db, { discordId, cleanStreakDays, lastEvalDay, paused }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO probation_state (discord_id, clean_streak_days, last_eval_day, paused, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      clean_streak_days = excluded.clean_streak_days,
      last_eval_day = excluded.last_eval_day,
      paused = excluded.paused,
      updated_at = excluded.updated_at;
  `).run(
    String(discordId),
    Number(cleanStreakDays ?? 0),
    lastEvalDay == null ? null : String(lastEvalDay),
    paused ? 1 : 0,
    now
  );
}

export function clearProbationState(db, discordId) {
  db.prepare('DELETE FROM probation_state WHERE discord_id = ?').run(String(discordId));
}

export function getPostBreakEnforcement(db, discordId) {
  const row = db.prepare(`
    SELECT break_until, warn_count, last_warn_at
    FROM post_break_enforcement
    WHERE discord_id = ?
  `).get(String(discordId));

  if (!row) return null;

  return {
    breakUntil: Number(row.break_until ?? 0) || 0,
    warnCount: Number(row.warn_count ?? 0) || 0,
    lastWarnAt: row.last_warn_at == null ? null : (Number(row.last_warn_at ?? 0) || null),
  };
}

export function upsertPostBreakEnforcement(db, { discordId, breakUntil, warnCount, lastWarnAt }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO post_break_enforcement (discord_id, break_until, warn_count, last_warn_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      break_until = excluded.break_until,
      warn_count = excluded.warn_count,
      last_warn_at = excluded.last_warn_at,
      updated_at = excluded.updated_at;
  `).run(
    String(discordId),
    Number(breakUntil),
    Number(warnCount ?? 0),
    lastWarnAt == null ? null : Number(lastWarnAt),
    now
  );
}

export function clearPostBreakEnforcement(db, discordId) {
  db.prepare('DELETE FROM post_break_enforcement WHERE discord_id = ?').run(String(discordId));
}

export function purgeRecruitUserData(db, discordId) {
  const id = String(discordId);
  const now = Date.now();

  // Primary tables
  db.prepare('DELETE FROM profiles WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM trial_ledger WHERE discord_id = ?').run(id);

  // Break + eval state
  db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM break_requests WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM underwatch_state WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM probation_state WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM post_break_enforcement WHERE discord_id = ?').run(id);

  // Mark a tombstone setting (audit trail without keeping user row data).
  db.prepare(`
    INSERT INTO recruit_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  `).run(`purged.${id}`, '1', now);
}
