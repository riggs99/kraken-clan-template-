/**
 * season-reset.js
 *
 * Rolls the season boundary when a Clash Royale season ends. Posts the outgoing
 * season's top-5 report (fame, wars played, donations) to the leader channel,
 * then stamps a new season boundary in history.json so the next season's stats
 * start counting from zero.
 *
 * Unlike scripts/full-clan-reset.js, this does NOT wipe history.json, change any
 * member's Discord role, reset profile status, or touch discipline/break state —
 * full history keeps accumulating indefinitely so lifetime records (Hall of Fame
 * donor/war/attendance streaks, /status's cross-week history) keep working across
 * season boundaries. Only season-scoped totals (rankSeason, used here and by
 * /recruit-season-report) reset, by counting from the new seasonStart date instead
 * of the beginning of history.
 *
 * There is no reliable signal from the Clash Royale API for "the season ended" —
 * seasons are calendar-based (roughly monthly, first Monday of each month), not
 * something the clan/war API exposes. This is always a manual, leader-judged
 * trigger, same as full-clan-reset.js.
 *
 * Once run, the season can't be rolled again until next month's rollover window
 * opens (the first Monday of the month, or later) — see
 * src/recruit/season-rollover.js's checkCanRollSeason. FORCE=1 bypasses this.
 *
 * This is the terminal-script version, for whoever's comfortable with a computer
 * and a command line. Any leader can do the exact same thing from Discord instead
 * via /recruit-season-reset (a confirm-button flow, no terminal needed) — both
 * share the same guard/roll logic (src/recruit/season-rollover.js) so they can't
 * drift on behavior, and the shared history.json lock (src/history.js) prevents
 * this script, a concurrent Discord confirm, scripts/full-clan-reset.js, and the
 * bot's own routine snapshot writer from racing each other.
 *
 * Usage (from project root):
 *   node scripts/season-reset.js           — live run
 *   DRY_RUN=1 node scripts/season-reset.js — preview only, no changes made
 *   FORCE=1 node scripts/season-reset.js   — skip the "too early to roll" guard
 */

import 'dotenv/config';
import path from 'node:path';
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { loadHistory, saveHistory, backupHistoryFile, acquireHistoryLock, releaseHistoryLock } from '../src/history.js';
import { getClan } from '../src/cr-api.js';
import { getExpectedDecksPerDay, initDb } from '../src/recruit/db.js';
import { buildSeasonReport } from '../src/recruit/season-report-builder.js';
import { resolveReportsChannel } from '../src/schedule.js';
import { checkCanRollSeason, rollSeasonBoundary } from '../src/recruit/season-rollover.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === '1';

function log(msg) {
  console.log(`[${DRY_RUN ? 'DRY RUN' : 'LIVE'}] ${msg}`);
}

// Module-scoped (not local to main()) so the top-level catch below can clean
// up an in-progress Discord connection / DB handle / lock on an unexpected
// throw — the explicit early-exit branches inside main() already release each
// before their own process.exit() calls.
let client = null;
let db = null;
let lockHeld = false;

async function main() {
  console.log('');
  console.log('=== KRAKEN SEASON ROLLOVER ===');
  console.log(DRY_RUN ? '>>> DRY RUN — no changes will be made <<<' : '>>> LIVE RUN — changes are permanent <<<');
  console.log('');
  log('Posts the outgoing season\'s report and starts a new season boundary.');
  log('Does NOT touch history, member profiles, roles, or discipline state.');
  log('For a full baseline reset instead, use scripts/full-clan-reset.js.');
  console.log('');

  const CLAN_TAG = process.env.CLAN_TAG;
  if (!CLAN_TAG) {
    console.error('CLAN_TAG is not set in .env — cannot fetch clan data. Aborting.');
    process.exit(1);
  }

  db = initDb();
  const history = loadHistory();
  const expectedDecksPerDay = getExpectedDecksPerDay(db);

  const guard = checkCanRollSeason(history, { force: FORCE });
  if (!guard.ok) {
    console.error(`Refusing to roll: ${guard.reason}`);
    console.error('If this is intentional, re-run with FORCE=1 node scripts/season-reset.js');
    db.close();
    process.exit(1);
  }

  if (!DRY_RUN) {
    const lock = acquireHistoryLock();
    if (!lock.acquired) {
      console.error(lock.reason);
      db.close();
      process.exit(1);
    }
    lockHeld = true;
  }

  log('Connecting to Discord...');
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });
  log(`Discord connected as ${client.user.tag}`);
  console.log('');

  const clan = await getClan(CLAN_TAG);
  const result = buildSeasonReport({ clan, history, db, expectedDecksPerDay });

  if (!result.ok) {
    console.error(`Cannot roll the season: ${result.reason}`);
    if (lockHeld) releaseHistoryLock();
    await client.destroy();
    db.close();
    process.exit(1);
  }

  const resolved = await resolveReportsChannel(client, db);
  if (!resolved.channel) {
    console.error(`Could not resolve leader channel to post to: ${resolved.reason}`);
    if (lockHeld) releaseHistoryLock();
    await client.destroy();
    db.close();
    process.exit(1);
  }

  log(`Season report ready — ${result.rows.length} player(s), ${result.season.weeksCounted} war week(s).`);
  console.log('');

  // --- Roll the season boundary FIRST, then post ---
  // The report content above was already fully computed from the pre-roll
  // `history`, so this ordering doesn't change what gets posted, but it does
  // mean a failure writing history.json aborts BEFORE anything is posted to
  // Discord, instead of risking a "final" report posted for a season whose
  // boundary never actually rolled.
  const today = new Date().toISOString().slice(0, 10);

  if (!DRY_RUN) {
    const backupPath = backupHistoryFile();
    if (!backupPath) {
      console.error('history.json not found — aborting before any Discord post.');
      releaseHistoryLock();
      await client.destroy();
      db.close();
      process.exit(1);
    }
    log(`history.json backed up to ${path.basename(backupPath)}`);

    // Reloaded fresh (not reusing the `history` object the report was built
    // from) in case something else — the bot's own upsertTodaySnapshot, if it
    // wasn't actually stopped first as documented — wrote a newer snapshot in
    // the meantime; saveHistory() below is a full overwrite, not a merge, so
    // mutating a stale copy here would silently discard that write. (The
    // shared history-lock now also blocks upsertTodaySnapshot itself while
    // this section runs, but the fresh reload stays cheap insurance.)
    // rollSeasonBoundary derives outgoingStart from THIS fresh reload itself
    // (not a value read earlier, before the lock above), so it can't disagree
    // with what's actually being saved.
    const h = loadHistory();
    const { outgoingStart } = rollSeasonBoundary(h, { today });
    saveHistory(h);
    log(`Season boundary rolled — new season starts ${today}${outgoingStart ? ` (previous season: ${outgoingStart} to ${today})` : ''}.`);

    try {
      await resolved.channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [result.container],
        allowedMentions: { parse: [] },
      });
      log(`Season report posted to #${resolved.channelId}.`);
    } catch (postError) {
      // The boundary is ALREADY rolled and saved above — a plain failure exit
      // here would wrongly suggest nothing happened. checkCanRollSeason now
      // blocks a re-roll this month, so the report has to be posted manually.
      console.error(`Season boundary WAS rolled to ${today}, but posting the report failed: ${postError?.message ?? postError}`);
      console.error('This will not undo itself and won\'t roll again this month — post the outgoing season\'s standings manually (the pre-roll snapshot is in the newest data/history.json.bak-* file).');
      releaseHistoryLock();
      await client.destroy();
      db.close();
      process.exit(1);
    }
    releaseHistoryLock();
  } else {
    log(`[would] Back up history.json, then roll the season boundary to ${today}.`);
    log(`[would] Post the season report to #${resolved.channelId}.`);
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Season boundary rolled: ${DRY_RUN ? 'would roll' : 'yes'} (new start: ${today})`);
  console.log(`Season report posted  : ${DRY_RUN ? 'would post' : 'yes'}`);
  console.log('History.json wiped    : no — full history preserved');
  console.log('Roles/profiles touched: no');
  if (DRY_RUN) {
    console.log('');
    console.log('>>> This was a DRY RUN. Re-run without DRY_RUN=1 to apply. <<<');
  }
  console.log('');

  await client.destroy();
  db.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('Season rollover failed:', e);
  if (lockHeld) releaseHistoryLock();
  try { await client?.destroy(); } catch { /* already gone */ }
  try { db?.close(); } catch { /* already gone */ }
  process.exit(1);
});
