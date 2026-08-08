/**
 * full-clan-reset.js
 *
 * Full baseline reset — NOT a routine season rollover (see scripts/season-reset.js
 * for that). Resets all tracked members to probation, wipes war history, clears
 * all eval/break state, and updates Discord roles to match. Rare and heavy: use
 * this for a genuine "start completely over" moment (e.g. a full clan re-baseline),
 * not for a normal end-of-season transition — a routine season rollover should
 * keep history, records, roles, and discipline state intact and only reset
 * season-scoped stats, which is what scripts/season-reset.js now does instead.
 *
 * KEEPS: profile links (discord_id <-> player tag), channel/role config,
 *        panel message IDs, watchlist, blacklist, trial audit ledger,
 *        break request history.
 *
 * Usage (from project root):
 *   node scripts/full-clan-reset.js           — live run
 *   DRY_RUN=1 node scripts/full-clan-reset.js — preview only, no changes made
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client, GatewayIntentBits } from 'discord.js';
import { HISTORY_PATH, acquireHistoryLock, releaseHistoryLock } from '../src/history.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const DB_PATH = String(process.env.KRAKEN_DB_PATH || path.join(process.cwd(), 'data', 'kraken.db'));

// Guild ID comes from the recruit config (same source the bot uses).
const recruitConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'recruit.config.json'), 'utf8'));
const RECRUIT_GUILD_ID = String(recruitConfig.recruitGuildId ?? '');

const ROLE_KEYS = {
  warcore:    'roles.warcoreRoleId',
  underwatch: 'roles.underwatchRoleId',
  onBreak:    'roles.onBreakRoleId',
  probation:  'roles.probationRoleId',
  remove:     'roles.removeRoleId',
};

// Settings keys to clear (eval state, rate-limit stamps, stale message history).
// Anything starting with these prefixes gets deleted.
// 'eval.' matters beyond housekeeping: it holds startRecruitEvaluator's own
// lastSeenPeriodIndex tracker (recruit/evaluator.js), independent of history.js's
// in-file one that this script resets below by wiping history.json. Leaving the
// SQLite copy stale makes the very next evaluator tick see periodIndex jump from
// its old pre-reset value straight to the new race's low value, misread that as a
// genuine day transition, and merge that tick's near-zero fresh-race snapshot into
// a bogus yesterdayKeyISO() bucket in the just-emptied history.json (confirmed live:
// produced a phantom all-zero-war-stat "2026-07-15" day right after the 2026-07-16
// reset). Clearing 'eval.' here keeps both trackers reset together.
const CLEAR_SETTING_PREFIXES = [
  'decisions.publicMessageHistory',
  'decisions.pinnedRulesMessageId',
  'breakRemind.',
  'atRisk.lastWarn.',
  'offboard.notified.',
  'eval.',
];

// Settings keys to always preserve regardless of prefix.
const PRESERVE_SETTING_PREFIXES = [
  'channels.',
  'roles.',
  'messages.',   // panel IDs — always preserved, never cleared
  'purged.',
];

function shouldClearKey(key) {
  // Never clear preserved keys.
  for (const p of PRESERVE_SETTING_PREFIXES) {
    if (key.startsWith(p)) return false;
  }
  for (const p of CLEAR_SETTING_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

function log(msg) {
  console.log(`[${DRY_RUN ? 'DRY RUN' : 'LIVE'}] ${msg}`);
}

function getSetting(db, key) {
  return db.prepare('SELECT value FROM recruit_settings WHERE key = ?').get(key)?.value ?? null;
}

async function main() {
  console.log('');
  console.log('=== KRAKEN FULL CLAN RESET ===');
  console.log(DRY_RUN ? '>>> DRY RUN — no changes will be made <<<' : '>>> LIVE RUN — changes are permanent <<<');
  console.log('');

  if (!RECRUIT_GUILD_ID) {
    console.error('RECRUIT_GUILD_ID is not set in .env — cannot fetch Discord members. Aborting.');
    process.exit(1);
  }

  // --- DB ---
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const runtime = {
    warcoreRoleId:    getSetting(db, ROLE_KEYS.warcore),
    underwatchRoleId: getSetting(db, ROLE_KEYS.underwatch),
    onBreakRoleId:    getSetting(db, ROLE_KEYS.onBreak),
    probationRoleId:  getSetting(db, ROLE_KEYS.probation),
    removeRoleId:     getSetting(db, ROLE_KEYS.remove),
  };

  log(`Warcore role  : ${runtime.warcoreRoleId ?? '(not set)'}`);
  log(`Underwatch    : ${runtime.underwatchRoleId ?? '(not set)'}`);
  log(`On break      : ${runtime.onBreakRoleId ?? '(not set)'}`);
  log(`Probation     : ${runtime.probationRoleId ?? '(not set)'}`);
  log(`Remove        : ${runtime.removeRoleId ?? '(not set)'}`);
  console.log('');

  // --- PROFILES ---
  const profiles = db.prepare("SELECT discord_id, player_tag, status FROM profiles WHERE status != 'removed'").all();
  log(`Profiles to reset: ${profiles.length}`);

  // --- SETTINGS to clear ---
  const allSettings = db.prepare('SELECT key FROM recruit_settings').all().map(r => r.key);
  const settingsToClear = allSettings.filter(shouldClearKey);
  log(`Settings keys to clear: ${settingsToClear.length}`);
  if (settingsToClear.length) {
    settingsToClear.forEach(k => log(`  - ${k}`));
  }
  console.log('');

  // --- DISCORD CLIENT ---
  log('Connecting to Discord...');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });
  log(`Discord connected as ${client.user.tag}`);

  const guild = await client.guilds.fetch(RECRUIT_GUILD_ID);
  await guild.members.fetch(); // populate cache
  log(`Guild: ${guild.name} — ${guild.memberCount} members`);
  console.log('');

  // --- ROLE CHANGES ---
  const rolesToRemove = [
    runtime.warcoreRoleId,
    runtime.underwatchRoleId,
    runtime.onBreakRoleId,
    runtime.removeRoleId,
  ].filter(Boolean);
  const roleToAdd = runtime.probationRoleId;

  let roleChanged = 0;
  let roleSkipped = 0;
  let roleErrored = 0;
  let alreadyProbation = 0;

  for (const profile of profiles) {
    const discordId = String(profile.discord_id ?? '');
    if (!discordId) { roleSkipped++; continue; }

    const member = guild.members.cache.get(discordId);
    if (!member) {
      log(`  SKIP (not in server): ${discordId} tag=${profile.player_tag}`);
      roleSkipped++;
      continue;
    }

    const memberRoles = member.roles.cache;
    const hasAnyTierRole = rolesToRemove.some(r => memberRoles.has(r));
    const hasProbation   = roleToAdd ? memberRoles.has(roleToAdd) : false;

    if (!hasAnyTierRole && hasProbation) {
      alreadyProbation++;
      continue;
    }

    log(`  Reset roles: ${member.displayName} (${discordId}) — was: ${profile.status}`);

    if (!DRY_RUN) {
      try {
        for (const roleId of rolesToRemove) {
          if (memberRoles.has(roleId)) {
            await member.roles.remove(roleId, 'Full clan reset — all members start on probation').catch(() => {});
          }
        }
        if (roleToAdd && !hasProbation) {
          await member.roles.add(roleToAdd, 'Full clan reset — starting on probation').catch(() => {});
        }
        roleChanged++;
      } catch (e) {
        console.error(`  ERROR updating roles for ${discordId}:`, e?.message ?? e);
        roleErrored++;
      }
      // Pace role API calls to avoid Discord's global rate limit on large rosters.
      await new Promise(r => setTimeout(r, 300));
    } else {
      roleChanged++;
    }
  }

  console.log('');
  log(`Role changes : ${roleChanged} updated, ${alreadyProbation} already on probation, ${roleSkipped} skipped (not in server), ${roleErrored} errored`);
  console.log('');

  // --- DB WRITES ---
  if (!DRY_RUN) {
    // WAL mode keeps recent writes in a separate kraken.db-wal file until checkpointed —
    // a raw fs.copyFileSync of just the main .db file could silently miss them, making the
    // one safety net this script provides before an irreversible operation incomplete.
    // TRUNCATE forces everything into the main file and empties the WAL before the copy.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const backupPath = DB_PATH.replace('.db', `.backup-${new Date().toISOString().slice(0, 10)}.db`);
    fs.copyFileSync(DB_PATH, backupPath);
    log(`DB checkpointed and backed up to ${path.basename(backupPath)}`);

    const now = Date.now();

    // Reset all active profile statuses to probation.
    db.prepare(`
      UPDATE profiles
      SET status = 'probation',
          last_score = NULL,
          last_verdict = NULL,
          last_reasons = NULL,
          probation_until = NULL,
          updated_at = ?
      WHERE status != 'removed'
    `).run(now);
    log(`Profiles updated to probation: ${profiles.length}`);

    // Clear all eval/break state tables.
    db.prepare('DELETE FROM breaks').run();
    log('breaks: cleared');

    db.prepare('DELETE FROM underwatch_state').run();
    log('underwatch_state: cleared');

    db.prepare('DELETE FROM probation_state').run();
    log('probation_state: cleared');

    db.prepare('DELETE FROM post_break_enforcement').run();
    log('post_break_enforcement: cleared');

    // Clear stale eval settings (rate-limit stamps, message history, etc.).
    for (const key of settingsToClear) {
      db.prepare('DELETE FROM recruit_settings WHERE key = ?').run(key);
    }
    log(`recruit_settings: cleared ${settingsToClear.length} keys`);
  } else {
    log(`[would] Backup DB to ${path.basename(DB_PATH.replace('.db', `.backup-${new Date().toISOString().slice(0, 10)}.db`))}`);
    log(`[would] Reset ${profiles.length} profiles to probation`);
    log('[would] Clear: breaks, underwatch_state, probation_state, post_break_enforcement');
    log(`[would] Clear ${settingsToClear.length} recruit_settings keys`);
  }

  // --- HISTORY.JSON ---
  console.log('');
  const historyExists = fs.existsSync(HISTORY_PATH);
  if (historyExists) {
    // Timestamped with ms (not just the date), matching src/history.js's
    // backupHistoryFile() — a date-only name would let a same-day re-run of
    // this script silently overwrite the first run's pre-reset archive right
    // when a retry scenario makes it most needed.
    const archivePath = HISTORY_PATH.replace('.json', `.archive-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`);
    // Capture who was actually in the clan right before the wipe. Without this,
    // risk-score.js's join-grace check can only compare firstSeen (restamped to
    // trackingEpoch for every existing member the moment they reappear in a
    // post-reset snapshot) against trackingEpoch by date — which can't tell an
    // old member's restamped firstSeen apart from a brand-new member who
    // genuinely joins on the same calendar day as the reset. rosterAtReset lets
    // it check real tag membership instead of a date coincidence.
    let rosterAtReset = [];
    try {
      const priorHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      const priorDays = Object.keys(priorHistory?.days ?? {}).sort();
      const lastDay = priorDays[priorDays.length - 1];
      rosterAtReset = lastDay ? Object.keys(priorHistory.days[lastDay]?.members ?? {}) : [];
    } catch (e) {
      log(`[warn] Could not read prior history.json to capture rosterAtReset: ${e?.message ?? e}`);
    }
    if (!DRY_RUN) {
      // Shares the same cross-process lock as the season-rollover entry points
      // and the bot's own routine snapshot writer (src/history.js) — without
      // this, a full reset running here could race a concurrent /recruit-season-reset
      // confirm or a live bot snapshot write and silently revive data this
      // reset just wiped (or vice versa).
      const lock = acquireHistoryLock();
      if (!lock.acquired) {
        console.error(lock.reason);
        await client.destroy();
        db.close();
        process.exit(1);
      }
      try {
        fs.copyFileSync(HISTORY_PATH, archivePath);
        const resetDay = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(HISTORY_PATH, JSON.stringify({
          firstSeen: {},
          days: {},
          trackingEpoch: resetDay,
          // A full reset is also, by definition, a season boundary — stamp one
          // here too so scripts/season-reset.js's rankSeason scoping has
          // something to bound against immediately, instead of falling back to
          // "unbounded" until someone separately remembers to run
          // season-reset.js. The prior seasonStart/seasons bookkeeping (if any)
          // isn't carried forward into the fresh file — it's still recoverable
          // from the archive copy above if ever needed.
          seasonStart: resetDay,
          seasons: [],
          rosterAtReset,
        }, null, 2), 'utf8');
        log(`history.json archived to ${path.basename(archivePath)} and reset to empty (rosterAtReset: ${rosterAtReset.length} tags)`);
      } finally {
        releaseHistoryLock();
      }
    } else {
      log(`[would] Archive history.json → ${path.basename(archivePath)} and reset to empty (rosterAtReset would capture ${rosterAtReset.length} tags)`);
    }
  } else {
    log('history.json not found — nothing to archive');
  }

  // --- SUMMARY ---
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Profiles reset   : ${profiles.length}`);
  console.log(`Discord roles    : ${roleChanged} updated${roleErrored > 0 ? `, ${roleErrored} ERRORED` : ''}`);
  console.log(`History archived : ${historyExists ? 'yes' : 'no file found'}`);
  console.log(`DB backed up     : ${DRY_RUN ? 'skipped (dry run)' : 'yes'}`);
  console.log(`DB tables wiped  : breaks, underwatch_state, probation_state, post_break_enforcement`);
  console.log(`Settings cleared : ${settingsToClear.length} keys`);
  if (DRY_RUN) {
    console.log('');
    console.log('>>> This was a DRY RUN. Re-run without DRY_RUN=1 to apply. <<<');
  }
  console.log('');

  await client.destroy();

  if (!DRY_RUN) {
    db.exec('VACUUM');
    log('DB vacuumed — freelist pages reclaimed');
  }
  db.close();
  process.exit(0);
}

main().catch(e => {
  console.error('Full clan reset failed:', e);
  process.exit(1);
});
