/**
 * One-time: DM the full KRAKEN welcome guide to every kraken-member in Recruit HQ.
 * Skips members already marked welcome.guideDmSent.{id} unless --force.
 *
 * Usage:
 *   node scripts/dm-welcome-guide-blast.js
 *   node scripts/dm-welcome-guide-blast.js --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { getRecruitDb } from '../src/recruit/index.js';
import { getRecruitRuntimeIds } from '../src/recruit/db.js';
import { loadRecruitConfig } from '../src/config/loadConfig.js';
import {
  buildWelcomeGuideEmbeds,
  buildWelcomeGuideAllowedMentions,
  welcomeGuideAlreadySent,
  markWelcomeGuideSent,
} from '../src/recruit/welcome-guide.js';

loadEnv();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const delayMs = 1500;

const db = getRecruitDb();

// This script writes markWelcomeGuideSent state into production kraken.db (per
// CLAUDE.md's production-data-safety rule, any script that mutates it needs a
// backup first — full-clan-reset.js already follows this pattern). WAL checkpoint
// forces everything out of the -wal file into the main .db before the copy, so
// the snapshot is consistent even while the bot is actively writing.
if (!dryRun) {
  const dbPath = String(process.env.KRAKEN_DB_PATH || path.join(process.cwd(), 'data', 'kraken.db'));
  db.pragma('wal_checkpoint(TRUNCATE)');
  const backupPath = dbPath.replace('.db', `.backup-before-welcome-blast-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log(`Backed up kraken.db to ${path.basename(backupPath)} before sending.`);
}

const recruitConfig = loadRecruitConfig();
const runtime = getRecruitRuntimeIds(db);
const guildId = String(recruitConfig.recruitGuildId);
const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');

if (!/^\d{17,20}$/.test(memberRoleId)) {
  console.error('memberRoleId not configured');
  process.exit(1);
}

const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const embeds = buildWelcomeGuideEmbeds(runtime, recruitConfig).map(e => e.toJSON());
const allowedMentions = buildWelcomeGuideAllowedMentions(runtime, recruitConfig);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllMembers() {
  const out = [];
  let after = '0';
  for (;;) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`, { headers });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Member fetch failed (${res.status}): ${err}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    out.push(...batch);
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
  }
  return out;
}

async function sendDm(userId, displayName) {
  const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers,
    body: JSON.stringify({ recipient_id: userId }),
  });
  const dm = await dmRes.json();
  if (!dmRes.ok) throw new Error(dm.message ?? 'create DM failed');

  const content = [
    `Hey **${displayName}** — welcome to **KRAKEN**.`,
    '',
    'You\'re enrolled and being tracked. Roles: **kraken-member** + **probation**.',
    'Keep this message — it\'s your full guide to how the server works.',
  ].join('\n');

  const msgRes = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, embeds, allowed_mentions: allowedMentions }),
  });
  const msg = await msgRes.json();
  if (!msgRes.ok) throw new Error(msg.message ?? 'send failed');
  return msg;
}

const members = await fetchAllMembers();
const eligibleMembers = members.filter(m => {
  const user = m.user ?? {};
  if (user.bot) return false;
  const roles = m.roles ?? [];
  return roles.includes(memberRoleId);
});
const targets = eligibleMembers.filter(m => force || !welcomeGuideAlreadySent(db, m.user.id));
// Computed from the same filter pass that built targets, so it stays correct
// under --force (where nothing is actually skipped, even though those members
// were already marked sent before).
const skippedCount = eligibleMembers.length - targets.length;

console.log(`Found ${targets.length} kraken-member(s) to DM${dryRun ? ' (dry-run)' : ''}.`);

let sent = 0;
let failed = 0;
const failures = [];

for (const m of targets) {
  const user = m.user;
  const name = String(m.nick ?? user.global_name ?? user.username ?? 'there').trim() || 'there';
  if (dryRun) {
    console.log(`[dry-run] would DM ${name} (${user.id})`);
    sent++;
    continue;
  }

  try {
    await sendDm(user.id, name);
    markWelcomeGuideSent(db, user.id);
    sent++;
    console.log(`[OK] ${name} (${user.id})`);
  } catch (e) {
    failed++;
    failures.push({ id: user.id, name, error: String(e?.message ?? e) });
    console.log(`[FAIL] ${name} (${user.id}): ${e?.message ?? e}`);
  }

  await sleep(delayMs);
}

console.log('');
console.log(`Done. Sent: ${sent}, failed: ${failed}, skipped (already sent): ${skippedCount}`);
if (failures.length) {
  console.log('Failures:', failures);
}
