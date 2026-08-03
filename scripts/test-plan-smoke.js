/**
 * Smoke checks for the clean2 test plan (no Discord slash commands required).
 * Usage: node scripts/test-plan-smoke.js
 */
import 'dotenv/config';
import path from 'node:path';
import { loadOpsData } from '../src/ops.js';
import { getWarDayDecision, isWarActivityPresent } from '../src/war-cycle.js';
import { buildWelcomeGuideEmbeds } from '../src/recruit/welcome-guide.js';
import { initDb, getRecruitRuntimeIds } from '../src/recruit/db.js';
import { loadRecruitConfig } from '../src/config/loadConfig.js';
import { cleanTag } from '../src/util.js';
import Database from 'better-sqlite3';

const DB_PATH = String(process.env.KRAKEN_DB_PATH ?? path.join(process.cwd(), 'data', 'kraken.db'));

function pass(label, detail = '') {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail = '') {
  console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
}

function warn(label, detail = '') {
  console.log(`[MANUAL] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('=== KRAKEN test-plan smoke ===\n');

  // 2–4: grace, ops/war data, war-board hold simulation
  let data;
  try {
    data = await loadOpsData(7);
  } catch (e) {
    fail('loadOpsData', String(e?.message ?? e));
    return;
  }
  pass('loadOpsData', `${data.members.length} live clan members`);

  const cycle = getWarDayDecision({
    race: data.race,
    snapshotWarDay: isWarActivityPresent(data.members),
    nowMs: Date.now(),
  });
  pass('war-day signal', `shouldJudgeToday=${cycle.shouldJudgeToday} source=${cycle.source}`);

  const inGrace = data.scored.filter(m => m.inGrace);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const profiles = db.prepare("SELECT discord_id, player_tag, status FROM profiles WHERE player_tag IS NOT NULL AND player_tag != '' AND status != 'removed'").all();
  db.close();

  const linkedTags = new Set(profiles.map(p => cleanTag(p.player_tag)).filter(Boolean));
  const linkedInGrace = inGrace.filter(m => linkedTags.has(cleanTag(m.tag)));

  if (cycle.shouldJudgeToday && linkedInGrace.length > 0) {
    fail('grace on war day', `${linkedInGrace.length} linked member(s) still in grace: ${linkedInGrace.map(m => m.name).join(', ')}`);
  } else if (inGrace.length > 0) {
    pass('grace hold', `${inGrace.length} in grace (expected for mid-war joiners or training)`);
  } else {
    pass('grace hold', '0 members in grace');
  }

  // War-board hold simulation (linked profiles only)
  const profileByTag = new Map(profiles.map(p => [cleanTag(p.player_tag), p]));
  const scoreMap = new Map(data.scored.map(s => [cleanTag(s.tag), s]));

  let holdCount = 0;
  let baseCount = 0;
  for (const m of data.members) {
    const tag = cleanTag(m.tag);
    const score = scoreMap.get(tag);
    const inGraceRow = Boolean(score?.inGrace);
    const profile = profileByTag.get(tag);
    if (!profile) continue;
    if (inGraceRow) holdCount++;
    else baseCount++;
  }

  pass('war-board simulation (linked only)', `basePool=${baseCount} hold(grace)=${holdCount}`);

  // Ops vs /war: same loadOpsData source — compare war-window deck totals
  const opsWarDecks = data.scored.reduce((sum, m) => sum + Number(m.windowAgg?.decksDeltaSum ?? 0), 0);
  const policyDecks = data.policyRows.reduce((sum, r) => sum + Number(r.sum7?.usedDecks ?? 0), 0);
  if (Math.abs(opsWarDecks - policyDecks) > 0.01) {
    fail('ops vs war deck totals', `scored windowAgg sum=${opsWarDecks} policy sum7 used=${policyDecks}`);
  } else {
    pass('ops/war data alignment', `7d war decks tracked consistently (${policyDecks} used)`);
  }

  // Welcome guide embeds
  try {
    const recruitConfig = loadRecruitConfig();
    const runtime = getRecruitRuntimeIds(initDb());
    const embeds = buildWelcomeGuideEmbeds(runtime, recruitConfig);
    if (embeds.length !== 2) fail('welcome guide', `expected 2 embeds, got ${embeds.length}`);
    else pass('welcome guide embeds', '2 embeds build cleanly');
  } catch (e) {
    fail('welcome guide embeds', String(e?.message ?? e));
  }

  const trackingEpoch = data.history?.trackingEpoch ?? '(none)';
  pass('trackingEpoch', String(trackingEpoch));

  console.log('');
  warn('/war-board in Discord', 'Confirm hold section is not the whole linked roster');
  warn('/apply or /recruit-add-member', 'Confirm welcome guide DM arrives (needs live Discord test)');
  warn('/recruit-eval-now mode:manual-safe', 'Run on first training day after war for full tier preview');
  console.log('');
  console.log(process.exitCode ? '=== SMOKE FAILED ===' : '=== SMOKE PASSED (manual Discord checks remain) ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
