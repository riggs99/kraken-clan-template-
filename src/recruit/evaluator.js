import { getClan, getCurrentRiverRace, getRiverRaceLog } from '../cr-api.js';
import { confirmMemberGone, applyRolesVerified } from '../permissions.js';
import { buildMemberIntel, liveClanTagSet } from '../war-intel.js';
import { upsertTodaySnapshot, mergeMembersIntoDay, loadHistory, getLastNDays, seriesForTag } from '../history.js';
import { computeHistoryWeightedRisk } from '../risk-score.js';
import { cleanTag, normalizePlayerTag, todayKeyISO } from '../util.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../dashboard-components.js';
import {
  getWarDayDecision,
  isWarActivityPresent,
  parseWarAnchorMsFromEnv,
  warDayFromPeriodType,
  isHistoricalWarDay,
} from '../war-cycle.js';
import {
  evaluateWarTierPolicy,
  explainPolicyReason,
  isTwoWarInactive,
  latestKnownName,
  summarizeWindow,
  buildWarHistoryRecord,
  rankLastCompletedWarWeek,
} from './policy.js';
import {
  CLAN_RECORD_KEYS,
  applyClanRecordOutcome,
  candidateMeetsMinimum,
  evaluateClanRecordChallenge,
  loadClanRecordState,
  reconcileAllClanRecords,
  saveClanRecordState,
} from './clan-records.js';
import {
  clearUnderwatchState,
  clearPostBreakEnforcement,
  clearProbationState,
  getActiveBreak,
  getExpectedDecksPerDay,
  getPostBreakEnforcement,
  getProbationState,
  getRecruitRuntimeIds,
  getRecruitSetting,
  getUnderwatchState,
  recordNameChanges,
  setRecruitSetting,
  upsertPostBreakEnforcement,
  upsertProbationState,
  upsertUnderwatchState,
} from './db.js';
import { suppressManualTierSync } from './manual-role-sync.js';
import { notifyNextWaiting, LEFT_SERVER_BREAK_REASON, handleMemberReturn } from './waitlist.js';


function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function safeTruncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function displayMember(changeOrUser) {
  const name = safeTruncate(String(changeOrUser?.name ?? '').trim(), 48);
  if (name) return name;
  const clean = cleanTag(changeOrUser?.tag);
  return clean ? `#${clean}` : '#UNKNOWN';
}

// summarizeWindow (policy.js) already computes boatTotal/repairTotal on the same object
// hasForbidden is derived from — this surfaces the real breakdown instead of the flat
// "forbidden actions detected" flag, which told a leader/member nothing about what
// actually happened.
function describeForbiddenActions(statSum) {
  const boat = num(statSum?.boatTotal);
  const repair = num(statSum?.repairTotal);
  if (boat <= 0 && repair <= 0) return '';
  const parts = [];
  if (boat > 0) parts.push(`${boat} boat attack${boat !== 1 ? 's' : ''}`);
  if (repair > 0) parts.push(`${repair} repair point${repair !== 1 ? 's' : ''}`);
  return parts.join(', ');
}

function chunk(arr, size) {
  const out = [];
  const a = Array.isArray(arr) ? arr : [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function safeSend(client, channelId, content) {
  if (!isValidDiscordId(channelId)) return false;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || typeof ch.send !== 'function') return false;
    const body = typeof content === 'string' ? { content } : (content ?? {});
    await ch.send({ ...body, allowedMentions: { parse: [] } });
    return true;
  } catch (e) {
    console.error(`[RECRUIT] safeSend failed (channel=${channelId}): ${String(e?.message ?? e)}`);
    return false;
  }
}

async function safeSendTracked(client, channelId, content) {
  if (!isValidDiscordId(channelId)) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || typeof ch.send !== 'function') return null;
    const body = typeof content === 'string' ? { content } : (content ?? {});
    return await ch.send({ ...body, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error(`[RECRUIT] safeSendTracked failed (channel=${channelId}): ${String(e?.message ?? e)}`);
    return null;
  }
}

async function sendDmSafe(client, discordId, content) {
  if (!isValidDiscordId(String(discordId ?? ''))) return false;
  try {
    const user = await client.users.fetch(String(discordId));
    if (!user) return false;
    await user.send({ content: String(content ?? ''), allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

// Shared sender for every public "kraken-toned" celebration post (Perfect War
// Honors, WARCORE promotions, streak achievements, the donor record) — extracts
// the channel-fetch + send + explicit-mention-allowlist plumbing so each
// achievement only supplies its own copy. safeSend strips all mentions by design;
// these posts are the one place a ping is the point, so this bypasses it and sends
// directly with an explicit allowlist instead. Returns the sent Message on
// success, null on any failure — callers must check the return value before
// treating an achievement as "announced" (e.g. before persisting one-time state).
async function postCelebration(client, channelId, { content, title, description, color = 0xf1c40f, fields = [], footer, discordId, roleId, logLabel = 'celebration' }) {
  if (!isValidDiscordId(channelId)) return null;
  const ch = await client.channels.fetch(channelId).catch((e) => {
    console.error(`[RECRUIT] ${logLabel} channel fetch failed:`, String(e?.message ?? e));
    return null;
  });
  if (!ch?.send) {
    console.error(`[RECRUIT] ${logLabel} channel unavailable (id=${channelId}).`);
    return null;
  }

  // Components V2 (see src/dashboard-components.js, the house style used everywhere else in
  // this codebase) can't carry a top-level `content` field, so the ping — the whole point of
  // this sender's explicit mention allowlist — moves into the first content block instead.
  // Mentions still notify from inside a TextDisplay exactly as they do from `content`, as long
  // as allowedMentions explicitly allows them (kept below, unchanged).
  const blocks = [];
  if (content) blocks.push(content);
  blocks.push(description);
  for (const field of fields) blocks.push(`**${field.name}**\n${field.value}`);
  const footerLine = [footer, `<t:${Math.floor(Date.now() / 1000)}:f>`].filter(Boolean).join(' · ');
  blocks.push(`-# ${footerLine}`);

  const container = buildDashboardContainer({
    accentColor: color,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `## ${title}`,
    blocks,
  });

  return ch.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: {
      roles: isValidDiscordId(roleId) ? [roleId] : [],
      users: isValidDiscordId(discordId) ? [discordId] : [],
    },
  }).catch((e) => {
    console.error(`[RECRUIT] ${logLabel} post failed:`, String(e?.message ?? e));
    return null;
  });
}

async function logClanRecordReconcileChanges(client, logsChannelId, changes) {
  if (!changes?.length) return;
  await safeSendLogEmbed(client, logsChannelId, {
    title: 'KRAKEN — Clan Hall of Fame Reconciliation',
    lines: changes.map((c) => {
      const label = c.label;
      if (c.reason === 'reverted-to-prior') {
        return `**${label}**: holder #${c.departedTag} left — reverted to #${c.newHolderTag}.`;
      }
      return `**${label}**: holder #${c.departedTag} left — no prior holder in clan (record cleared).`;
    }),
  });
}

function buildDonorCandidate({ history, weekRank, weekRankCache, expectedDecksPerDay, discordByTag, recordCache }) {
  const topDonorEntry = Object.entries(weekRank.byTag).find(([, e]) => e.donationRank === 1);
  if (!topDonorEntry) return null;
  const [topTag, topEntry] = topDonorEntry;
  const donorHistory = buildWarHistoryRecord(history, topTag, expectedDecksPerDay, 52, weekRankCache, recordCache);
  return {
    tag: topTag,
    name: displayMember({ name: latestKnownName(history, topTag), tag: topTag }),
    discordId: String(discordByTag.get(topTag) ?? '') || null,
    streak: donorHistory.streaks.top1Donor,
    weekDonations: topEntry.donationsTotal,
  };
}

function buildWarCandidate({ history, weekRank, weekRankCache, expectedDecksPerDay, discordByTag, recordCache }) {
  const topWarEntry = Object.entries(weekRank.byTag).find(([, e]) => e.warRank === 1);
  if (!topWarEntry) return null;
  const [topTag, topEntry] = topWarEntry;
  const warHistory = buildWarHistoryRecord(history, topTag, expectedDecksPerDay, 52, weekRankCache, recordCache);
  return {
    tag: topTag,
    name: displayMember({ name: latestKnownName(history, topTag), tag: topTag }),
    discordId: String(discordByTag.get(topTag) ?? '') || null,
    streak: warHistory.streaks.top1War,
    weekDonations: topEntry.fameTotal ?? 0,
  };
}

function buildAttendanceCandidate({ history, results, weekRankCache, expectedDecksPerDay, discordByTag, recordCache }) {
  let best = null;
  for (const r of results) {
    const record = buildWarHistoryRecord(history, r.tag, expectedDecksPerDay, 52, weekRankCache, recordCache);
    const latest = record.latestWeek;
    if (!latest?.zeroMissed) continue;
    const candidate = {
      tag: r.tag,
      name: displayMember({ name: latestKnownName(history, r.tag), tag: r.tag }),
      discordId: String(discordByTag.get(r.tag) ?? r.discordId ?? '') || null,
      streak: record.streaks.attendance,
      weekDonations: latest.decksTotal ?? 0,
    };
    if (
      !best
      || candidate.streak > best.streak
      || (candidate.streak === best.streak && candidate.weekDonations > best.weekDonations)
    ) {
      best = candidate;
    }
  }
  return best;
}

function shouldAnnounceClanRecord(outcome, record) {
  if (outcome === 'none' || outcome === 'tiebreak-retained') return false;
  return candidateMeetsMinimum(record);
}

function clanRecordPingContent({ record, memberRoleId }) {
  const recordDisplayName = record.name;
  const pingId = record.discordId;
  if (isValidDiscordId(memberRoleId)) {
    return `<@&${memberRoleId}> ${isValidDiscordId(pingId) ? `<@${pingId}>` : `**${recordDisplayName}**`}`;
  }
  return isValidDiscordId(pingId) ? `<@${pingId}>` : `**${recordDisplayName}**`;
}

const CLAN_RECORD_COPY = {
  donor: {
    first: ['💝 THE CLAN\'S GREATEST GIVER', (n, s) => `**${n}** just set a new clan record: **#1 donor for ${s} consecutive weeks.**`, '', "KRAKEN's ledger has a new name at the top."],
    extended: ['💝 THE RECORD KEEPS CLIMBING', (n, s) => `**${n}** extends the clan donation record to **${s} consecutive weeks** as #1 donor.`, '', (n) => `The record keeps climbing. So does ${n}.`],
    beaten: ['💝 A NEW NAME AT THE TOP', (n, s) => `**${n}** just broke the clan donation record: **${s} consecutive weeks** as #1 donor.`, '', 'KRAKEN keeps the record. The record just changed hands.'],
    'tiebreak-claimed': ['💝 THE RECORD HAS A NEW NAME', (n, s, w) => `**${n}** matches the clan record at **${s} consecutive weeks** as #1 donor — and wins it on donations: **${w}** this week, more than the previous holder.`, '', 'The record has a new name.'],
    footer: 'KRAKEN • clan donation record • earned, never given',
    logLabel: 'donor record',
  },
  war: {
    first: ['🏆 THE CLAN\'S WAR CHAMPION', (n, s) => `**${n}** just set a new clan record: **#1 war performer for ${s} consecutive weeks.**`, '', 'Not luck. Not one good week. A pattern.'],
    extended: ['🏆 THE CHAMPION KEEPS CLIMBING', (n, s) => `**${n}** extends the war champion record to **${s} consecutive weeks** as #1 war performer.`, '', 'The bar moves — and they keep clearing it.'],
    beaten: ['🏆 A NEW WAR CHAMPION', (n, s) => `**${n}** just broke the war champion record: **${s} consecutive weeks** as #1 war performer.`, '', 'KRAKEN keeps the record. The record just changed hands.'],
    'tiebreak-claimed': ['🏆 THE TITLE HAS A NEW NAME', (n, s, w) => `**${n}** matches the war champion record at **${s} consecutive weeks** — and wins it on fame: **${w}** this week, more than the previous holder.`, '', 'The title has a new name.'],
    footer: 'KRAKEN • war champion record • earned, never given',
    logLabel: 'war champion record',
  },
  attendance: {
    first: ['🛡️ IRON ATTENDANCE', (n, s) => `**${n}** just set a new clan record: **zero war days missed for ${s} consecutive weeks.**`, '', 'Every war. Every day. Present.'],
    extended: ['🛡️ NEVER ABSENT', (n, s) => `**${n}** extends the iron attendance record to **${s} consecutive weeks** with zero war days missed.`, '', (n, s) => `That's the bar. ${n} cleared it ${s} times in a row.`],
    beaten: ['🛡️ A NEW IRON STANDARD', (n, s) => `**${n}** just broke the iron attendance record: **${s} consecutive weeks** with zero war days missed.`, '', 'KRAKEN keeps the record. The record just changed hands.'],
    'tiebreak-claimed': ['🛡️ THE RECORD HAS A NEW NAME', (n, s, w) => `**${n}** matches the iron attendance record at **${s} consecutive weeks** — and wins it on decks used: **${w}** this week, more than the previous holder.`, '', 'The record has a new name.'],
    footer: 'KRAKEN • iron attendance record • earned, never given',
    logLabel: 'attendance record',
  },
};

async function tryAnnounceClanRecord({
  client,
  db,
  history,
  celebrationsThreadId,
  memberRoleId,
  recordType,
  settingKey,
  candidate,
}) {
  if (!candidate) return;

  const state = loadClanRecordState(db, getRecruitSetting, settingKey);
  const { outcome, record } = evaluateClanRecordChallenge(candidate, state.holder);
  if (!shouldAnnounceClanRecord(outcome, record)) return;

  const recordDisplayName = displayMember({ name: latestKnownName(history, record.tag), tag: record.tag });
  const copy = CLAN_RECORD_COPY[recordType];
  const template = copy[outcome];
  if (!template) return;

  const lines = template.map((line) => {
    if (typeof line === 'function') return line(recordDisplayName, record.streak, record.weekDonations);
    return line;
  });

  const sent = await postCelebration(client, celebrationsThreadId, {
    content: clanRecordPingContent({ record: { ...record, name: recordDisplayName }, memberRoleId }),
    title: lines[0],
    description: lines.slice(1).join('\n'),
    footer: copy.footer,
    discordId: isValidDiscordId(record.discordId) ? record.discordId : null,
    roleId: memberRoleId,
    logLabel: copy.logLabel,
  });
  if (sent) {
    const { state: newState } = applyClanRecordOutcome(state, outcome, record);
    saveClanRecordState(db, setRecruitSetting, settingKey, newState);
  }
}

// CLAN HALL OF FAME — one holder per record (donor, war champion, iron attendance).
// Reconcile first when a holder leaves: revert to the most recent prior holder
// still in clan, or clear until someone sets it again. Celebrate in the
// celebrations thread only when the record actually moves — no weekly leaderboard fallback.
async function announceClanHallOfFameRecords({
  client,
  db,
  history,
  results,
  celebrationsThreadId,
  memberRoleId,
  logsChannelId,
  expectedDecksPerDay,
  clanTagsSet,
  weekRankCache,
}) {
  const discordByTag = new Map(results.map(r => [r.tag, r.discordId]));
  const weekRank = rankLastCompletedWarWeek(history, expectedDecksPerDay);

  const reconcileChanges = reconcileAllClanRecords(db, getRecruitSetting, setRecruitSetting, clanTagsSet);
  await logClanRecordReconcileChanges(client, logsChannelId, reconcileChanges);

  // recordCache memoizes buildWarHistoryRecord's full per-tag result (not just the
  // per-week ranking weekRankCache already shares) — without it, a member who's both
  // the top donor and the attendance leader gets their whole history walked twice.
  const recordCache = new Map();
  const ctx = { history, weekRank, weekRankCache, expectedDecksPerDay, discordByTag, results, recordCache };

  await tryAnnounceClanRecord({
    client,
    db,
    history,
    celebrationsThreadId,
    memberRoleId,
    recordType: 'donor',
    settingKey: CLAN_RECORD_KEYS.donor,
    candidate: buildDonorCandidate(ctx),
  });
  await tryAnnounceClanRecord({
    client,
    db,
    history,
    celebrationsThreadId,
    memberRoleId,
    recordType: 'war',
    settingKey: CLAN_RECORD_KEYS.war,
    candidate: buildWarCandidate(ctx),
  });
  await tryAnnounceClanRecord({
    client,
    db,
    history,
    celebrationsThreadId,
    memberRoleId,
    recordType: 'attendance',
    settingKey: CLAN_RECORD_KEYS.attendance,
    candidate: buildAttendanceCandidate(ctx),
  });
}

function buildTierChangeDm({ before, after, reasons = [], sum7, sum14, name }) {
  const who = name ? `Hi **${safeTruncate(String(name), 40)}**,` : 'Hi,';
  const lines = [who, ''];
  const statSum = (after === 'warcore' || before === 'warcore') ? (sum14 ?? sum7) : sum7;
  const forbiddenDesc = describeForbiddenActions(statSum);
  const statsLine = statSum && num(statSum.expectedDecks) > 0
    ? `Your stats: **${num(statSum.usedDecks)}/${num(statSum.expectedDecks)} decks** · **${num(statSum.missedWarDays)}** missed war day${num(statSum.missedWarDays) !== 1 ? 's' : ''}${forbiddenDesc ? ` · ⛔ ${forbiddenDesc}` : ''}`
    : null;

  if (before === 'probation' && after === 'warcore') {
    lines.push('🟢 **You have been promoted to WARCORE.**');
    lines.push('');
    lines.push('You completed a perfect war window — 32/32 decks across 2 complete wars with no missed days or forbidden actions.');
    if (statsLine) { lines.push(''); lines.push(statsLine); }
    lines.push('');
    lines.push('**To stay in WARCORE:**');
    lines.push('• Keep deck usage above 17/32 per 2 wars');
    lines.push('• No more than 3 missed war days per 2-war window');
    lines.push('• No boat attacks or repair points — normal war battles only');
  } else if (before === 'underwatch' && after === 'probation') {
    lines.push('🟡 **You have recovered to PROBATION.**');
    lines.push('');
    lines.push('You completed a perfect 2-war window while on underwatch. KRAKEN has moved you back to probation.');
    if (statsLine) { lines.push(''); lines.push(statsLine); }
    lines.push('');
    lines.push('**To reach WARCORE from here:**');
    lines.push('• Complete another perfect 2-war window (32/32 decks, zero missed days, no forbidden actions)');
    lines.push('• Recovery goes Probation → Warcore — not Underwatch → Warcore directly');
  } else if (after === 'underwatch') {
    lines.push('🔴 **You have been moved to UNDERWATCH.**');
    lines.push('');
    const reasonText = (Array.isArray(reasons) ? reasons : []).map(explainReason).filter(Boolean).slice(0, 2).join(' ');
    if (reasonText) lines.push(`Reason: ${reasonText}`);
    if (statsLine) { lines.push(''); lines.push(statsLine); }
    lines.push('');
    lines.push('**To recover:**');
    lines.push('• Complete a perfect 2-war window — 32/32 decks across 2 full wars');
    lines.push('• Zero missed war days, no boat attacks or repair points');
    lines.push('• Recovery promotes you back to Probation, not directly to Warcore');
  } else if (after === 'probation' && before === 'warcore') {
    lines.push('🟡 **You have been moved back to PROBATION.**');
    lines.push('');
    const reasonText = (Array.isArray(reasons) ? reasons : []).map(explainReason).filter(Boolean).slice(0, 2).join(' ');
    if (reasonText) lines.push(`Reason: ${reasonText}`);
    if (statsLine) { lines.push(''); lines.push(statsLine); }
    lines.push('');
    lines.push('**To return to WARCORE:**');
    lines.push('• Complete a perfect 2-war window — 32/32 decks across 2 full wars');
    lines.push('• Zero missed war days, no boat attacks or repair points');
  } else if (after === 'remove') {
    lines.push('⛔ **You have been flagged for boot review.**');
    lines.push('');
    lines.push('No war activity (zero decks, zero fame) was detected across a full war week. KRAKEN has applied the remove flag and a leader will review your status.');
    lines.push('');
    lines.push('If this is a mistake or you need a break, contact a leader immediately.');
  } else {
    lines.push(`Your tier has changed: **${before} → ${after}**.`);
    const reasonText = (Array.isArray(reasons) ? reasons : []).map(explainReason).filter(Boolean).slice(0, 2).join(' ');
    if (reasonText) lines.push(`Reason: ${reasonText}`);
    if (statsLine) { lines.push(''); lines.push(statsLine); }
  }

  lines.push('');
  lines.push('Role reviews happen on the first training day after each war week closes. See #kraken-decisions for the full weekly report.');
  return lines.join('\n');
}

function buildRichMemberContainer(change) {
  const who = displayMember(change);
  const before = String(change.before ?? '');
  const after = String(change.after ?? '');
  const reasons = Array.isArray(change.reasons) ? change.reasons : [];
  const statSum = change.summary14 ?? change.summary7 ?? null;

  let color, prefix, description, recoveryText;

  if (before === 'probation' && after === 'warcore') {
    color = 0x57f287; prefix = '⬆️';
    description = 'Completed a perfect war window — 32/32 decks across 2 complete wars with no missed days or forbidden actions.';
    recoveryText = 'Maintain: ≥17/32 decks, ≤3 missed war days, no forbidden actions across every 2-war window.';
  } else if (before === 'underwatch' && after === 'probation') {
    color = 0x57f287; prefix = '📈';
    description = 'Recovered from underwatch with a perfect 2-war window.';
    recoveryText = 'Next step: complete another perfect 2-war window (32/32 decks, zero missed days, no forbidden actions) to reach WARCORE.';
  } else if (before === 'warcore' && after === 'probation') {
    color = 0xfee75c; prefix = '⬇️';
    description = 'Performance fell below the WARCORE threshold across the 2-war review window.';
    recoveryText = 'To return: complete 32/32 decks across 2 full wars with zero missed days and no forbidden actions.';
  } else if (after === 'underwatch') {
    color = 0xed4245; prefix = '⚠️';
    description = 'Performance fell below the minimum threshold across the review window.';
    recoveryText = 'To recover: complete a perfect 2-war window (32/32 decks, zero missed days, no forbidden actions). Recovery promotes back to Probation.';
  } else if (after === 'remove') {
    color = 0xed4245; prefix = '🚫';
    description = 'Zero war activity detected across a full war week. Remove role applied — leader review required.';
    recoveryText = 'Contact a leader if this is a mistake or if a break was needed.';
  } else {
    color = 0x5865f2; prefix = '↔️';
    description = reasons.map(explainReason).filter(Boolean).slice(0, 2).join(' ') || 'Tier updated.';
    recoveryText = null;
  }

  const blocks = [description];

  if (statSum && num(statSum.expectedDecks) > 0) {
    const forbiddenDetail = describeForbiddenActions(statSum);
    const forbidden = forbiddenDetail ? ` · ⛔ ${forbiddenDetail}` : '';
    blocks.push(`**Performance**\n${num(statSum.usedDecks)}/${num(statSum.expectedDecks)} decks · ${num(statSum.missedWarDays)} missed war day${num(statSum.missedWarDays) !== 1 ? 's' : ''}${forbidden}`);
  }

  const reasonText = reasons.map(explainReason).filter(Boolean).slice(0, 3).join('\n');
  if (reasonText) blocks.push(`**Reason**\n${safeTruncate(reasonText, 512)}`);
  if (recoveryText) blocks.push(`**What to do**\n${recoveryText}`);

  return buildDashboardContainer({
    accentColor: color,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `## ${prefix} ${safeTruncate(`${who} — ${before} → ${after}`, 250)}`,
    blocks,
  });
}

async function managePublicDecisionsHistory(client, channelId, db, newIds) {
  let history;
  try {
    history = JSON.parse(String(getRecruitSetting(db, 'decisions.publicMessageHistory') ?? '[]'));
  } catch { history = []; }
  if (!Array.isArray(history)) history = [];

  // Keep last 3 weeks — delete the oldest batch when a 4th arrives
  while (history.length >= 3) {
    const oldest = history.shift();
    if (Array.isArray(oldest) && oldest.length > 0) {
      try {
        const ch = await client.channels.fetch(channelId);
        if (ch) {
          for (const id of oldest) {
            if (!isValidDiscordId(String(id ?? ''))) continue;
            try { const msg = await ch.messages.fetch(String(id)); if (msg) await msg.delete(); } catch (_e) { /* already deleted */ }
          }
        }
      } catch (_e) { /* channel unavailable */ }
    }
  }

  const validIds = (Array.isArray(newIds) ? newIds : []).map(String).filter(id => isValidDiscordId(id));
  if (validIds.length > 0) history.push(validIds);
  setRecruitSetting(db, 'decisions.publicMessageHistory', JSON.stringify(history));
}

async function runAtRiskWarnings({ client, db, profiles, history, last7, isWarDayForKey, guild, roleIds, clanTagsSet, day }) {
  if (!Array.isArray(profiles) || profiles.length === 0) return;
  const EXPECTED_DECKS_PER_DAY = getExpectedDecksPerDay(db);
  const cooldownDays = 4;

  for (const p of profiles) {
    const discordId = String(p.discord_id ?? '');
    const tag = normalizePlayerTag(p.player_tag);
    if (!discordId || !tag || !clanTagsSet.has(tag)) continue;

    const activeBreak = getActiveBreak(db, discordId);
    if (activeBreak) continue;

    const sum7 = summarizeWindow(history, tag, last7, EXPECTED_DECKS_PER_DAY, isWarDayForKey);
    // Need at least 2 war days tracked and meaningful expected decks before warning
    if (!sum7 || sum7.warDays < 2 || num(sum7.expectedDecks) < 2 * EXPECTED_DECKS_PER_DAY) continue;
    if (sum7.deckCompletion >= 0.5) continue;

    const warnKey = `atRisk.lastWarn.${discordId}`;
    const lastWarn = getRecruitSetting(db, warnKey);
    if (lastWarn) {
      const lastMs = Date.parse(`${lastWarn}T00:00:00.000Z`);
      if (Number.isFinite(lastMs) && (Date.now() - lastMs) < cooldownDays * 24 * 60 * 60 * 1000) continue;
    }

    let currentTier = 'unknown';
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) continue;
      currentTier = tierFromRoles(member, roleIds);
    } catch { continue; }
    if (currentTier === 'none' || currentTier === 'unknown') continue;

    const used = num(sum7.usedDecks);
    const expected = num(sum7.expectedDecks);
    const warDays = num(sum7.warDays);
    const missedDays = num(sum7.missedWarDays);

    const dmLines = [
      '⚠️ **KRAKEN — Performance Warning**',
      '',
      'You are tracking below the minimum for this war week.',
      '',
      `War days tracked: **${warDays}** · Decks used: **${used}/${expected}** · Missed war days: **${missedDays}**`,
      '',
    ];

    if (currentTier === 'warcore') {
      dmLines.push('At this rate you risk being moved to **Probation** at the next review.');
      dmLines.push('');
      dmLines.push('**To stay in WARCORE:** use your remaining decks on every war day. No boat attacks or repair points.');
    } else if (currentTier === 'probation') {
      dmLines.push('At this rate you risk being moved to **Underwatch** at the next review.');
      dmLines.push('');
      dmLines.push('**To stay on track:** use your decks on every remaining war day. No boat attacks or repair points.');
    } else if (currentTier === 'underwatch') {
      dmLines.push('You are on underwatch. Missing decks now delays your recovery.');
      dmLines.push('');
      dmLines.push('**To recover:** use all your decks on every remaining war day. A perfect 2-war window is required.');
    }

    dmLines.push('');
    dmLines.push('Role reviews happen on the first training day after war closes. There is still time to improve.');

    const sent = await sendDmSafe(client, discordId, dmLines.join('\n'));
    if (sent) setRecruitSetting(db, warnKey, day);
  }
}

function buildDecisionEmbeds({ title, lines, color = 0x5865f2 }) {
  const items = Array.isArray(lines) ? lines.map(x => String(x ?? '').trim()).filter(Boolean) : [];
  if (items.length === 0) {
    return [new EmbedBuilder().setTitle(title).setColor(color).setDescription('No details provided.')];
  }

  const embeds = [];
  let current = [];
  let currentLen = 0;
  for (const line of items) {
    const nextLen = currentLen + (current.length ? 1 : 0) + line.length;
    if (current.length > 0 && nextLen > 3500) {
      embeds.push(
        new EmbedBuilder()
          .setTitle(title)
          .setColor(color)
          .setDescription(current.join('\n'))
      );
      current = [line];
      currentLen = line.length;
      continue;
    }
    current.push(line);
    currentLen = nextLen;
  }

  if (current.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setDescription(current.join('\n'))
    );
  }

  return embeds;
}

async function safeSendDecisionEmbeds(client, channelId, { title, lines, color = 0x5865f2 }) {
  const embeds = buildDecisionEmbeds({ title, lines, color });
  let sentAny = false;
  for (const group of chunk(embeds, 10)) {
    sentAny = (await safeSend(client, channelId, { embeds: group })) || sentAny;
  }
  return sentAny;
}

async function safeSendLogEmbed(client, channelId, { title, lines, color = 0x2b2d31 }) {
  return safeSendDecisionEmbeds(client, channelId, { title, lines, color });
}

function profileStatusFromTier(tier) {
  const t = String(tier ?? '');
  if (t === 'warcore') return 'approved';
  if (t === 'probation') return 'probation';
  if (t === 'underwatch') return 'underwatch';
  return 'approved';
}

function tierFromRoles(member, ids) {
  const roles = member?.roles?.cache;
  if (!roles) return 'unknown';
  if (ids.probation && roles.has(ids.probation)) return 'probation';
  if (ids.underwatch && roles.has(ids.underwatch)) return 'underwatch';
  if (ids.warcore && roles.has(ids.warcore)) return 'warcore';
  return 'none';
}

function hasAnyRole(member, roleIds) {
  const roles = member?.roles?.cache;
  if (!roles) return false;
  for (const id of (Array.isArray(roleIds) ? roleIds : [])) {
    if (isValidDiscordId(id) && roles.has(id)) return true;
  }
  return false;
}

async function applyWarHubRoles({ member, ids, desiredTier, db }) {
  const required = [ids.member, ids.warcore, ids.underwatch, ids.probation].filter(isValidDiscordId);
  if (required.length < 4) return { changed: false, before: tierFromRoles(member, ids), after: tierFromRoles(member, ids) };

  const before = tierFromRoles(member, ids);
  const toAdd = [ids.member];
  const toRemove = [];

  if (desiredTier === 'warcore') toAdd.push(ids.warcore);
  if (desiredTier === 'underwatch') toAdd.push(ids.underwatch);
  if (desiredTier === 'probation') toAdd.push(ids.probation);

  const allTiers = [ids.warcore, ids.underwatch, ids.probation];
  for (const t of allTiers) {
    if (t && !toAdd.includes(t)) toRemove.push(t);
  }

  const current = member.roles.cache;
  const changed = toAdd.some(id => !current.has(id)) || toRemove.some(id => current.has(id));

  if (db && changed) {
    suppressManualTierSync(db, member.id);
  }

  // applyRolesVerified checks the mutation against the actual resulting role
  // cache instead of assuming desiredTier stuck — an add/remove call resolving
  // without throwing is not proof the tier role is actually present afterward.
  // Confirmed live: two members ended up with a DB status their Discord roles
  // never actually reflected, from this function asserting success unconditionally.
  const { member: updatedMember } = await applyRolesVerified(member, { add: toAdd, remove: toRemove, reason: 'KRAKEN daily evaluation' });
  const after = tierFromRoles(updatedMember, ids);
  return { changed, before, after };
}

export async function applyRemovedRoleState({ member, runtime, reason = 'KRAKEN clan membership sync', db }) {
  const roles = runtime?.roles ?? {};
  const removeRoleId = String(roles.removeRoleId ?? '');
  const managedRecruitRoles = [
    roles.memberRoleId,
    roles.warcoreRoleId,
    roles.underwatchRoleId,
    roles.probationRoleId,
    roles.onBreakRoleId,
    roles.newArrivalRoleId,
    roles.applicantRoleId,
    roles.approvedRoleId,
  ].map(v => String(v ?? '')).filter(isValidDiscordId);

  const cache = member?.roles?.cache;
  if (!cache) return { changed: false, removeApplied: false };

  if (!isValidDiscordId(removeRoleId)) {
    return { changed: false, removeApplied: false, skipped: 'remove-role-missing' };
  }

  const toRemove = managedRecruitRoles.filter(id => cache.has(id));
  const hadRemove = cache.has(removeRoleId);
  const attemptedChange = toRemove.length > 0 || !hadRemove;

  if (db && attemptedChange) {
    suppressManualTierSync(db, member.id);
  }

  // applyRolesVerified checks the mutation against the actual resulting role
  // cache, same reasoning as applyWarHubRoles — an add/remove resolving
  // without throwing isn't proof the remove role actually stuck or the
  // managed roles actually came off.
  const { member: updatedMember } = await applyRolesVerified(member, { add: removeRoleId, remove: toRemove, reason });
  const verifiedCache = updatedMember.roles.cache;
  const removeApplied = verifiedCache.has(removeRoleId);
  const leftoverManagedRoles = managedRecruitRoles.filter(id => verifiedCache.has(id));

  return {
    changed: attemptedChange,
    removeApplied,
    incomplete: !removeApplied || leftoverManagedRoles.length > 0,
  };
}

function isoDayToMs(dayKeyIso) {
  const s = String(dayKeyIso ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

function yesterdayKeyISO(today) {
  const t = isoDayToMs(today);
  if (t == null) return null;
  const y = new Date(t - 24 * 60 * 60 * 1000);
  return y.toISOString().slice(0, 10);
}

// Most recent stored day (on or before `today`) that was a war day. Used to detect
// a completed war week even if KRAKEN was offline on the exact training-review day.
function findLatestWarDayKey(history, today, anchorMs) {
  const days = Object.keys(history?.days ?? {})
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= String(today))
    .sort();
  for (let i = days.length - 1; i >= 0; i--) {
    if (isHistoricalWarDay(history, days[i], anchorMs)) return days[i];
  }
  return null;
}

function dayKeyFromMs(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function parseDayKey(dayKey) {
  const s = String(dayKey ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

function addDays(dayKey, deltaDays) {
  const base = parseDayKey(dayKey);
  if (base == null) return null;
  return new Date(base + (Number(deltaDays ?? 0) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function buildBackfillAuditLines(history, startDay, endDay) {
  const out = [];
  let cursor = String(startDay ?? '');
  const end = String(endDay ?? '');
  if (!cursor || !end) return out;

  while (cursor <= end) {
    const members = Object.values(history?.days?.[cursor]?.members ?? {});
    const totals = members.reduce((acc, m) => {
      acc.fame += num(m?.fame);
      acc.decks += num(m?.decksUsedToday);
      acc.boat += num(m?.boatAttacks);
      acc.repairs += num(m?.repairPoints);
      return acc;
    }, { fame: 0, decks: 0, boat: 0, repairs: 0 });
    const active = members.filter(m => (num(m?.fame) + num(m?.decksUsedToday) + num(m?.boatAttacks) + num(m?.repairPoints)) > 0).length;
    const warSignal = isWarActivityPresent(history?.days?.[cursor]?.members ?? {});
    out.push(`${cursor}: members=${members.length} active=${active} fame=${Math.round(totals.fame)} decks=${Math.round(totals.decks)} boat=${Math.round(totals.boat)} repairs=${Math.round(totals.repairs)} warSignal=${warSignal ? 'yes' : 'no'}`);
    const next = addDays(cursor, 1);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

async function runStartupBackfillAudit({ client, db }) {
  const days = Math.max(0, Number(process.env.RECRUIT_STARTUP_BACKFILL_DAYS ?? 1) || 1);
  if (days <= 0) return;

  const runtime = getRecruitRuntimeIds(db);
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');

  const today = todayKeyISO();
  const ranKey = 'eval.startupBackfillAuditDay';
  if (String(getRecruitSetting(db, ranKey) ?? '') === today) return;

  try {
    const history = loadHistory();
    const allDays = Object.keys(history?.days ?? {}).sort();
    if (allDays.length === 0) {
      setRecruitSetting(db, ranKey, today);
      return;
    }

    const latestHistoryDay = allDays[allDays.length - 1];
    const startDay = addDays(latestHistoryDay, -(days - 1));
    const lines = buildBackfillAuditLines(history, startDay, latestHistoryDay);
    if (lines.length > 0) {
      const body = lines.slice(0, 12).join('\n');
      const msg = `[RECRUIT] Startup backfill audit (last ${days} day${days === 1 ? '' : 's'}, no role changes):\n${body}${lines.length > 12 ? `\n(+${lines.length - 12} more)` : ''}`;
      console.log(msg);
      await safeSendLogEmbed(client, logsChannelId, {
        title: 'KRAKEN Startup Backfill Audit',
        lines: [
          `Window: last ${days} day${days === 1 ? '' : 's'}.`,
          'Role changes: none. Snapshot refresh only.',
          '',
          ...lines.slice(0, 12),
          ...(lines.length > 12 ? [`(+${lines.length - 12} more)`] : []),
        ],
      });
    }
    setRecruitSetting(db, ranKey, today);
  } catch (e) {
    console.error('[RECRUIT] Startup backfill audit failed:', String(e?.message ?? e));
  }
}

// Detects Discord role state that drifted away from what the DB says a
// tracked member's tier should be while KRAKEN was offline. A manual role
// edit made during downtime never reaches manual-role-sync.js, since that
// only reacts to live GuildMemberUpdate gateway events — Discord doesn't
// replay missed events on reconnect — so nothing else in this codebase ever
// catches this. Detection only, never auto-corrects: a leader may have
// changed the role on purpose, and KRAKEN can't tell intent apart from
// accident, so silently overwriting it back could itself be the wrong move.
async function runStartupRoleDriftAudit({ client, recruitConfig, db }) {
  const runtime = getRecruitRuntimeIds(db);
  const roleIds = {
    warcore: String(runtime?.roles?.warcoreRoleId ?? ''),
    underwatch: String(runtime?.roles?.underwatchRoleId ?? ''),
    probation: String(runtime?.roles?.probationRoleId ?? ''),
  };
  // A clan that hasn't run /recruit-setup yet has no role IDs configured —
  // nothing meaningful to compare against, so skip rather than warn.
  if (!isValidDiscordId(roleIds.warcore) || !isValidDiscordId(roleIds.underwatch) || !isValidDiscordId(roleIds.probation)) return;

  const today = todayKeyISO();
  const ranKey = 'eval.startupRoleDriftAuditDay';
  if (String(getRecruitSetting(db, ranKey) ?? '') === today) return;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');

  try {
    const guild = await client.guilds.fetch(recruitGuildId).catch(() => null);
    if (!guild) return;

    const profiles = db.prepare("SELECT discord_id, player_tag, status FROM profiles WHERE status != 'removed'").all();
    const drifted = [];

    for (const p of profiles) {
      const discordId = String(p.discord_id ?? '');
      if (!discordId) continue;

      // 'unknown' (a transient fetch failure, not a confirmed departure) is
      // skipped rather than treated as drift — the same three-state
      // discipline this project already learned the hard way applies here.
      const { state, member } = await confirmMemberGone(guild, discordId);
      if (state !== 'present' || !member) continue;

      const actualTier = tierFromRoles(member, roleIds);
      // No tier role at all is a separate, already-visible problem (the
      // member shows up with no rank anywhere in Discord) — not silent
      // drift, so it's left out of this report rather than double-counted.
      if (actualTier === 'none' || actualTier === 'unknown') continue;

      const expectedStatus = String(p.status ?? '');
      const actualStatus = profileStatusFromTier(actualTier);
      if (actualStatus === expectedStatus) continue;

      drifted.push({ discordId, tag: p.player_tag, expectedStatus, actualStatus });
    }

    if (drifted.length > 0) {
      const lines = drifted.slice(0, 20).map(d =>
        `<@${d.discordId}> (#${d.tag}) — DB says **${d.expectedStatus}**, Discord role shows **${d.actualStatus}**`
      );
      console.log(`[RECRUIT] Startup role-drift audit: ${drifted.length} member(s) drifted (likely a manual role change while KRAKEN was offline).`);
      await safeSendLogEmbed(client, logsChannelId, {
        title: '⚠️ KRAKEN — Role Drift Detected on Startup',
        lines: [
          `${drifted.length} member(s) have a Discord role that disagrees with their tracked status — likely changed manually while KRAKEN was offline.`,
          'KRAKEN does not auto-correct this — review and reconcile manually.',
          '',
          ...lines,
          ...(drifted.length > 20 ? [`(+${drifted.length - 20} more)`] : []),
        ],
        color: 0xed4245,
      });
    }
    setRecruitSetting(db, ranKey, today);
  } catch (e) {
    console.error('[RECRUIT] Startup role-drift audit failed:', String(e?.message ?? e));
  }
}

function hasWarActivitySince(history, tag, sinceMs) {
  const sinceDay = dayKeyFromMs(sinceMs);
  if (!sinceDay) return false;
  const dayKeys = Object.keys(history?.days ?? {}).filter(d => d > sinceDay).sort();
  if (dayKeys.length === 0) return false;
  const series = seriesForTag(history, tag, dayKeys);
  return series.some(r => num(r?.decksUsedToday) > 0 || num(r?.fame) > 0);
}

// Flags clan-roster members with no KRAKEN profile at all (never ran /apply or been
// added via /recruit-add-member). KRAKEN cannot distinguish "in Recruit HQ but hasn't
// applied" from "not on Discord at all" — there is no API link between a Clash Royale
// tag and a Discord account until one gets created via a profile row — so this reports
// the union of both cases. Dedup is a persisted set of already-reported tags (not a
// date cutoff) so a same-day joiner discovered after this tick already ran is never
// silently skipped by an off-by-one on the date comparison.
async function runNewClanJoinersReport({ client, db, runtime, history, day }) {
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const clanToday = history?.days?.[day]?.members ?? {};
  const clanTagsToday = Object.keys(clanToday).map(cleanTag).filter(Boolean);

  const linkedTags = new Set(
    db.prepare("SELECT player_tag FROM profiles WHERE player_tag IS NOT NULL AND player_tag != ''").all()
      .map(r => normalizePlayerTag(r.player_tag))
      .filter(Boolean)
  );

  let reportedTags = [];
  try {
    const parsed = JSON.parse(String(getRecruitSetting(db, 'eval.newJoinersReported') ?? '[]'));
    if (Array.isArray(parsed)) reportedTags = parsed.map(String);
  } catch { /* malformed — treat as empty */ }
  const reportedSet = new Set(reportedTags);

  const candidates = clanTagsToday
    .filter(tag => !linkedTags.has(tag))
    .filter(tag => !reportedSet.has(tag))
    .sort((a, b) => String(history?.firstSeen?.[a] ?? '').localeCompare(String(history?.firstSeen?.[b] ?? '')));

  if (candidates.length > 0) {
    const sample = candidates.slice(0, 20).map(tag => {
      const name = clanToday[tag]?.name ?? tag;
      const joined = history?.firstSeen?.[tag] ?? 'unknown';
      return `**${name}** — #${tag} (first seen ${joined})`;
    }).join('\n');

    await safeSendLogEmbed(client, logsChannelId, {
      title: '🆕 New Clan Members — Not Yet in Recruit HQ',
      lines: [
        `${candidates.length} clan member${candidates.length !== 1 ? 's' : ''} ${candidates.length !== 1 ? "haven't" : "hasn't"} linked a KRAKEN profile yet.`,
        "Could be sitting in Recruit HQ unlinked, or not on Discord at all — either way they need to click Agree & Join in #welcome (or a leader can run /recruit-add-member).",
        '',
        sample,
        ...(candidates.length > 20 ? [`(+${candidates.length - 20} more)`] : []),
      ],
      color: 0xf1c40f,
    });

    const nextReported = [...reportedTags, ...candidates].slice(-500);
    setRecruitSetting(db, 'eval.newJoinersReported', JSON.stringify(nextReported));
  }
}

// True once at least one COMPLETED war day (i.e. before today) has passed since
// `sinceMs`. Used to gate post-break escalation on real war evidence: a member
// whose break ended during training days hasn't had a chance to war yet, and a
// war day still in progress may still be played.
function hasCompletedWarDaySince(history, sinceMs, anchorMs, todayKey) {
  const sinceDay = dayKeyFromMs(sinceMs);
  if (!sinceDay) return false;
  return Object.keys(history?.days ?? {})
    .some(d => d > sinceDay && d < String(todayKey) && isHistoricalWarDay(history, d, anchorMs));
}

async function runBreakExpiryReminders({ client, db, inviteUrl }) {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const invite = String(inviteUrl ?? '').trim();
  const rejoinLine = invite ? `Rejoin here: ${invite}` : 'Ask a clanmate for the server invite link.';

  const fmt = (ms) => new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(ms));

  // Day-before reminder: break expiring within the next 24 hours, still active
  const expiringSoon = db.prepare(
    'SELECT discord_id, break_until, reason FROM breaks WHERE break_until > ? AND break_until <= ?'
  ).all(now, now + oneDayMs);

  for (const row of expiringSoon) {
    const discordId = String(row.discord_id ?? '');
    const breakUntil = Number(row.break_until ?? 0);
    if (!discordId || !breakUntil) continue;
    const key = `breakRemind.pre.${discordId}`;
    if (String(getRecruitSetting(db, key) ?? '') === String(breakUntil)) continue;

    const isAutoBreak = String(row.reason ?? '') === LEFT_SERVER_BREAK_REASON;
    const lines = isAutoBreak
      ? [
        '⏰ **Heads up — your KRAKEN grace period ends tomorrow!**',
        '',
        'You left the KRAKEN Discord server while still in the clan, so KRAKEN gave you a 7-day grace period.',
        '',
        `It expires: **${fmt(breakUntil)}** (Sydney time)`,
        '',
        '**Rejoin the server before then and your roles are restored automatically.**',
        rejoinLine,
        '',
        'If you don\'t return, you will be placed in **Underwatch** for leader review, and you may be removed from the clan to make room for active members.',
      ]
      : [
        '⏰ **Heads up — your KRAKEN break ends tomorrow!**',
        '',
        `Your break expires: **${fmt(breakUntil)}** (Sydney time)`,
        '',
        'When you\'re ready to return, go to **#on-a-break** and click **I\'m Back**.',
        '',
        'If you need more time, you can request another break (7, 14, or 30 days). **30 days is the maximum.**',
        '',
        'If we don\'t hear from you after your break ends, you will be placed in **Underwatch** for review. If the clan is full at that point, leaders may need to remove you to make room for active members.',
      ];

    const sent = await sendDmSafe(client, discordId, lines.join('\n'));
    if (sent) setRecruitSetting(db, key, String(breakUntil));
  }

  // Day-0 warning: break expired within the last 24 hours, hasn't clicked I'm Back
  const justExpired = db.prepare(
    'SELECT discord_id, break_until, reason FROM breaks WHERE break_until <= ? AND break_until > ?'
  ).all(now, now - oneDayMs);

  for (const row of justExpired) {
    const discordId = String(row.discord_id ?? '');
    const breakUntil = Number(row.break_until ?? 0);
    if (!discordId || !breakUntil) continue;
    const key = `breakRemind.exp.${discordId}`;
    if (String(getRecruitSetting(db, key) ?? '') === String(breakUntil)) continue;

    const isAutoBreak = String(row.reason ?? '') === LEFT_SERVER_BREAK_REASON;
    const lines = isAutoBreak
      ? [
        '⚠️ **Your KRAKEN grace period has ended.**',
        '',
        `It expired: **${fmt(breakUntil)}** (Sydney time)`,
        '',
        '**Rejoin the server now to restore your roles and keep your clan spot.**',
        rejoinLine,
        '',
        '**What happens if you stay away:**',
        '• You will be placed in **Underwatch** for leader review',
        '• You may be removed from the clan to make room for active members',
      ]
      : [
        '⚠️ **Your KRAKEN break has ended.**',
        '',
        `Your break expired: **${fmt(breakUntil)}** (Sydney time)`,
        '',
        'To return normally, go to **#on-a-break** and click **I\'m Back** — this closes your break and KRAKEN resumes tracking you.',
        '',
        '**What happens if you don\'t return:**',
        '• You will be placed in **Underwatch** for leader review',
        '• If the clan is full while you are in Underwatch, leaders may remove you to make room for active members',
        '',
        'If you need more time, request another break in **#on-a-break** (7, 14, or 30 days). **30 days is the maximum.**',
      ];

    const sent = await sendDmSafe(client, discordId, lines.join('\n'));
    if (sent) setRecruitSetting(db, key, String(breakUntil));
  }
}

async function runPostBreakEnforcement({ client, guild, db, runtime, history, logsChannelId, decisionsChannelId, publicDecisionsChannelId }) {
  // Breaks are self-service. After the timer expires, check for war activity.
  // If none, place them into underwatch (no kick/purge).
  const now = Date.now();
  const onBreakRoleId = String(runtime?.roles?.onBreakRoleId ?? '');
  const underwatchRoleId = String(runtime?.roles?.underwatchRoleId ?? '');
  const anchorMs = parseWarAnchorMsFromEnv();
  const todayKey = todayKeyISO();

  const expired = db.prepare(`
    SELECT discord_id, break_until, reason
    FROM breaks
    WHERE break_until <= ?
  `).all(now);

  if (!Array.isArray(expired) || expired.length === 0) return;

  for (const row of expired) {
    const discordId = String(row.discord_id ?? '');
    const breakUntil = Number(row.break_until ?? 0) || 0;
    if (!discordId || breakUntil <= 0) continue;

    const active = getActiveBreak(db, discordId);
    if (active) continue;

    // Remove on-break role once expired.
    if (isValidDiscordId(onBreakRoleId)) {
      try {
        const m = await guild.members.fetch(discordId);
        if (m?.roles?.cache?.has(onBreakRoleId)) {
          await m.roles.remove(onBreakRoleId, 'Break expired');
        }
      } catch {
        // ignore
      }
    }

    const profile = db.prepare('SELECT player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);
    const tag = normalizePlayerTag(profile?.player_tag);
    if (!tag) continue;

    // Any war activity after break end clears enforcement and clears the break row.
    // EXCEPTION: left-server-auto breaks are cleared by REJOINING the server, not by
    // war activity — a player who wars but never returns must still escalate.
    // (handleMemberReturn deletes the row on rejoin, so its presence here means
    // they have not come back — UNLESS that GuildMemberAdd event was missed
    // entirely, e.g. the bot was offline/restarting at the exact moment they
    // rejoined. Confirmed live: this happened to 5 members simultaneously, all
    // still genuinely present in the server the whole time — re-verify current
    // membership here rather than trusting the row's mere existence, since that's
    // the one thing handleMemberReturn would have already fixed had it fired.)
    const isLeftServerBreak = String(row.reason ?? '') === LEFT_SERVER_BREAK_REASON;
    if (isLeftServerBreak) {
      const { state, member: liveMember } = await confirmMemberGone(guild, discordId);
      if (state === 'unknown') {
        console.error(`[RECRUIT] Membership check inconclusive for <@${discordId}>, skipping this cycle.`);
        continue;
      }
      if (state === 'present') {
        console.log(`[RECRUIT] Post-break check found <@${discordId}> still in the server despite an unresolved left-server break — treating as a missed return instead of escalating.`);
        await handleMemberReturn(client, liveMember, db, profile).catch(e => {
          console.error(`[RECRUIT] Missed-return recovery failed for <@${discordId}>:`, String(e?.message ?? e));
        });
        continue;
      }
    }
    if (!isLeftServerBreak && hasWarActivitySince(history, tag, breakUntil)) {
      clearPostBreakEnforcement(db, discordId);
      try {
        db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
      } catch {
        // ignore
      }
      continue;
    }

    const enforcement = getPostBreakEnforcement(db, discordId);
    if (Number(enforcement?.breakUntil ?? 0) !== breakUntil) {
      upsertPostBreakEnforcement(db, { discordId, breakUntil, warnCount: 0, lastWarnAt: null });
    }
    const warnCount = Number(getPostBreakEnforcement(db, discordId)?.warnCount ?? 0);
    if (warnCount >= 1) continue; // Already moved to Underwatch for this break period

    // Escalation gate, matched to what each break type is for:
    // - left-server-auto: the offense is not returning to the server. The grace
    //   period has already elapsed — escalate immediately, war days irrelevant.
    // - regular break: the offense is war inactivity. Escalate only after at
    //   least one COMPLETED war day has passed since the break ended with zero
    //   activity — a break that ends during training days gets no unfair strike,
    //   and a war day still in progress can still be played.
    if (!isLeftServerBreak && !hasCompletedWarDaySince(history, breakUntil, anchorMs, todayKey)) continue;

    // Escalate: move to underwatch (no kick/purge).
    const endDay = dayKeyFromMs(breakUntil) ?? 'unknown-day';
    // applyRolesVerified checks the mutation against the actual resulting role
    // cache instead of assuming success. This exact "assume success, write DB
    // anyway" shape (silently swallowed catch, unconditional DB write right
    // after) is what produced two live members with DB status='underwatch'
    // and no underwatch role.
    let roleApplied = false;
    if (isValidDiscordId(underwatchRoleId)) {
      const m = await guild.members.fetch(discordId).catch(() => null);
      if (m) {
        // Suppressed like every other bot-initiated tier role change in this file (see the
        // daily evaluation loop above) — without this, the GuildMemberUpdate this triggers gets
        // picked up by manual-role-sync.js as if a LEADER had manually changed the role,
        // mislabeling this fully-automated escalation as last_verdict='manual_override' in the
        // profile and posting a second, confusing "Manual role sync" message right next to the
        // correct decision message below. It also used to be the ONLY thing that ever created
        // this member's underwatch state row for this path — suppressing it without adding the
        // explicit upsertUnderwatchState below would silently stop that from happening at all.
        suppressManualTierSync(db, discordId);
        const { ok } = await applyRolesVerified(m, { add: underwatchRoleId, reason: 'Post-break inactivity (no war activity detected)' });
        roleApplied = ok;
      }
    } else {
      console.error('[RECRUIT] Post-break enforcement: underwatchRoleId is not configured, cannot escalate.');
    }

    if (!roleApplied) {
      // Don't mark this escalation as handled — leave the break row and
      // enforcement state untouched so the next scheduled cycle retries the
      // role add, instead of silently losing the escalation forever the way
      // the unconditional writes below used to.
      continue;
    }

    // Mirrors the daily evaluation loop's own "entering underwatch" state handling further
    // below — preserves an existing paused clock (e.g. from a prior underwatch stint) instead
    // of always starting fresh, now that this is no longer implicitly created as a side effect
    // of the (suppressed) manual-role-sync listener above.
    {
      const existingUw = getUnderwatchState(db, discordId);
      const pauseResolved = existingUw && existingUw.pauseStartedAt != null
        ? { pauseAccumMs: (existingUw.pauseAccumMs ?? 0) + Math.max(0, now - existingUw.pauseStartedAt), pauseStartedAt: null }
        : { pauseAccumMs: existingUw?.pauseAccumMs ?? 0, pauseStartedAt: existingUw?.pauseStartedAt ?? null };
      upsertUnderwatchState(db, {
        discordId,
        startedAt: existingUw?.startedAt && existingUw.startedAt > 0 ? existingUw.startedAt : now,
        pauseAccumMs: pauseResolved.pauseAccumMs,
        pauseStartedAt: pauseResolved.pauseStartedAt,
        lastNotifiedAt: existingUw?.lastNotifiedAt ?? null,
      });
    }

    db.prepare(`
      UPDATE profiles
      SET status = ?, updated_at = ?
      WHERE discord_id = ?
    `).run('underwatch', now, discordId);

    try {
      const u = await client.users.fetch(discordId);
      await u.send({
        content: [
          `KRAKEN UPDATE: Your break ended on **${endDay}** and no war activity was detected.`,
          'You have been placed into **kraken-underwatch** for leader review.',
          'If the clan is full while you are in Underwatch, leaders may need to remove you to make room.',
          'To get back on track, start another break in **#on-a-break** or return to war participation.',
        ].join('\n'),
        allowedMentions: { parse: [] }
      });
    } catch {
      // ignore
    }

    await safeSendDecisionEmbeds(client, decisionsChannelId || logsChannelId, {
      title: '🐙 KRAKEN Recruit Decision',
      lines: [
        `**${displayMember({ tag })}** moved to **underwatch**.`,
        'Reason: post-break inactivity was detected after the break ended.',
      ],
    });
    if (isValidDiscordId(publicDecisionsChannelId)) {
      await safeSend(client, publicDecisionsChannelId, `KRAKEN Decision: **${displayMember({ tag })}** moved to underwatch - post-break inactivity.`);
    }

    // Escalation complete: clear the expired break row + enforcement state so it
    // is not reprocessed on every future eval. The member is now in underwatch and
    // is evaluated normally from here.
    try {
      db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
    } catch {
      // ignore
    }
    clearPostBreakEnforcement(db, discordId);
  }
}

function explainReason(reason) {
  const r = String(reason ?? '');
  if (r === 'DECKS_NOT_100') return 'Missed decks (not 100% deck usage on war days).';
  if (r === 'MISSED_WAR_DAYS') return 'Missed at least one war day.';
  if (r === 'ZERO_FAME') return 'No fame contribution detected.';
  if (r === 'FORBIDDEN_REPAIRS_OR_BOAT') return 'Forbidden boat actions/repairs detected.';
  if (r === 'SUSTAINED_14D') return 'Sustained underperformance across 14 days.';
  if (r.startsWith('OPS_RANGE')) return `OPS weak-link range triggered (${r.replace(/^OPS_RANGE\\s*/,'')}).`;
  if (r === 'NO_WAR_DATA') return 'No war data available yet (likely not in clan / no tracked days).';
  return explainPolicyReason(r);
}

export async function runRecruitDailyEvaluation(client, recruitConfig, db, options = {}) {
  const EXPECTED_DECKS_PER_DAY = getExpectedDecksPerDay(db);
  const mode = String(options?.mode ?? 'scheduled');
  const manualSafe = mode === 'manual';
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const runtime = getRecruitRuntimeIds(db);

  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const decisionsChannelId = String(runtime?.channels?.decisionsChannelId ?? '');
  const publicDecisionsChannelId = String(runtime?.channels?.publicDecisionsChannelId ?? '');
  const removalQueueChannelId = String(runtime?.channels?.removalQueueChannelId ?? recruitConfig?.channels?.removalQueueChannelId ?? '');
  const removeRoleId = String(runtime?.roles?.removeRoleId ?? recruitConfig?.roles?.removeRoleId ?? '');

  const roleIds = {
    member: String(runtime?.roles?.memberRoleId ?? ''),
    warcore: String(runtime?.roles?.warcoreRoleId ?? ''),
    underwatch: String(runtime?.roles?.underwatchRoleId ?? ''),
    probation: String(runtime?.roles?.probationRoleId ?? ''),
  };
  const missingRoles = Object.entries(roleIds).filter(([, v]) => !isValidDiscordId(v)).map(([k]) => k);
  if (missingRoles.length > 0) {
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Eval Skipped',
      lines: [
        'Reason: missing recruit role IDs in SQLite.',
        `Missing: ${missingRoles.join(', ')}.`,
        'Action: run /recruit-setup.',
      ],
      color: 0xed4245,
    });
    return { skipped: 'config' };
  }

  const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
  if (!clanTag) {
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Eval Skipped',
      lines: [
        'Reason: CLAN_TAG is missing.',
        'Action: set CLAN_TAG and restart KRAKEN.',
      ],
      color: 0xed4245,
    });
    return { skipped: 'config' };
  }

  let latestRace = null;
  let snapshotRefreshOk = false;
  // Live CR API roster (clan.memberList), NOT derived from history — a stored day
  // bucket deliberately retains a mid-war leaver's stats (war-intel.js's
  // buildMemberIntel keeps them so that day's clan-wide totals aren't undercounted),
  // so a departed member can keep testing "in clan" for the rest of the race if this
  // were built from history instead. Null when the live fetch below fails; callers
  // fall back to the history-derived approximation in that degraded case only.
  let liveClanTags = null;

  // Refresh today snapshot so history is up to date even if /ops isn't being run.
  // Up to 3 attempts with 5-minute intervals to survive brief CR API maintenance windows.
  try {
    let clan, race, raceLog;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      try {
        [clan, race, raceLog] = await Promise.all([getClan(clanTag), getCurrentRiverRace(clanTag), getRiverRaceLog(clanTag)]);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    latestRace = race ?? null;
    liveClanTags = liveClanTagSet(clan);
    const members = buildMemberIntel({ clan, race, clanTag });
    // raceLog/clanTag let upsertTodaySnapshot run its own self-healing reconciliation
    // internally — this evaluator run makes real automated tier decisions, so it needs
    // the same protection against judging a member on an under-recorded final war day
    // as /ops, /war, and the scheduled reports.
    const { nameChanges } = upsertTodaySnapshot(members, {
      periodType: race?.periodType,
      warDay: warDayFromPeriodType(race),
      periodIndex: race?.periodIndex,
      raceLog,
      clanTag,
    });

    // On a transition-triggered run the cumulative totals we just fetched are the
    // just-ended period's finals (the new period started seconds-to-minutes ago) —
    // merge them into yesterday's bucket too, so the final stretch of war play
    // (last poll of yesterday → the flip) counts inside a war-flagged bucket
    // instead of leaking into today's, which now carries the new period's flag.
    // Only safe right at the flip: hours later (startup/safety-net triggers) the
    // totals would include new-period play that must not be attributed backward.
    if (options?.finalizePreviousDay) {
      const prevDay = yesterdayKeyISO(todayKeyISO());
      if (prevDay) mergeMembersIntoDay(prevDay, members);
    }
    snapshotRefreshOk = true;

    const newNameChanges = recordNameChanges(db, nameChanges ?? []);
    if (newNameChanges.length > 0) {
      await safeSendLogEmbed(client, logsChannelId, {
        title: 'KRAKEN — Player Name Changes',
        lines: newNameChanges.map(({ tag, oldName, newName }) =>
          `**#${String(tag).replace(/^#/, '')}** — \`${oldName}\` → \`${newName}\``
        ),
        color: 0x5865f2,
      });
    }
  } catch (e) {
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Eval Warning',
      lines: [
        'Clan snapshot refresh failed (3 attempts, 5-minute intervals).',
        `Error: ${String(e?.message ?? e)}.`,
        'Evaluation will continue using stored history.',
        'Member tier decisions may be based on yesterday\'s snapshot.',
      ],
      color: 0xfee75c,
    });
  }

  const history = loadHistory();
  const day = todayKeyISO();
  const snapshotWarDay = isWarActivityPresent(history?.days?.[day]?.members ?? {});
  const warDecision = getWarDayDecision({ race: latestRace, snapshotWarDay, nowMs: Date.now() });
  const { shouldJudgeToday, source: judgeSource, periodWarDay, liveWarDay, anchorDecision } = warDecision;
  const anchorMs = parseWarAnchorMsFromEnv();
  const isWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, anchorMs);

  // Role review runs once per completed war week, on the first training day after
  // the war closes. Rather than strictly requiring "yesterday was a war day" (which
  // is missed entirely if KRAKEN was offline on that exact day), find the most
  // recent war day in stored history and run the review if that war week has not
  // been reviewed yet. The live API `shouldJudgeToday` still guards against running
  // while a war is in progress, so a review never fires early. Net effect: if the
  // PC/bot was off on the real review day, the review self-heals on the next eval.
  const latestWarDayKey = findLatestWarDayKey(history, day, anchorMs);
  const lastReviewedWarDay = String(getRecruitSetting(db, 'eval.lastReviewedWarDay') ?? '');
  const warHasClosed = Boolean(latestWarDayKey) && latestWarDayKey < day && !shouldJudgeToday;
  const isTrainingReviewDay = warHasClosed && latestWarDayKey > lastReviewedWarDay;

  const last7 = getLastNDays(history, 7);
  const last14 = getLastNDays(history, 14);

  const guild = await client.guilds.fetch(recruitGuildId).catch(() => null);
  if (!guild) {
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Eval Skipped',
      lines: [
        `Reason: cannot access recruit guild ${recruitGuildId}.`,
        'Action: verify Recruit HQ guild ID and bot access.',
      ],
      color: 0xed4245,
    });
    return;
  }

  if (!isTrainingReviewDay) {
    const raceState = String(latestRace?.state ?? 'unknown');
    const sectionIndex = latestRace?.sectionIndex ?? 'unknown';
    const periodIndex = latestRace?.periodIndex ?? 'unknown';
    const anchorTxt = anchorDecision
      ? `, anchor=${anchorDecision.cycleLabel}`
      : '';
    const skipLine = `[RECRUIT] Daily eval ${day}: role review waits for first training day after war (source=${judgeSource}, raceState=${raceState}, section=${sectionIndex}, period=${periodIndex}, periodWarDay=${String(periodWarDay)}, liveWarDay=${String(liveWarDay)}, snapshotWarDay=${snapshotWarDay}${anchorTxt}).`;
    console.log(skipLine);
    await safeSendLogEmbed(client, logsChannelId, {
      title: `KRAKEN Eval ${day}`,
      lines: [
        'Review mode: tracking only.',
        'Role review waits for the first training day after war.',
        `Source: ${judgeSource}.`,
        `Race state: ${raceState}.`,
        `Section: ${sectionIndex}. Period: ${periodIndex}.`,
        `War-day signals: period=${String(periodWarDay)}, live=${String(liveWarDay)}, snapshot=${snapshotWarDay}.${anchorDecision ? ` anchor=${anchorDecision.cycleLabel}.` : ''}`,
      ],
    });
    if (!manualSafe && shouldJudgeToday) {
      // War day: warn members who are tracking badly before the review fires
      const warProfiles = db.prepare(
        "SELECT discord_id, player_tag FROM profiles WHERE player_tag IS NOT NULL AND player_tag != ''"
      ).all();
      const warClanTagsSet = liveClanTags
        ?? new Set(Object.keys(history?.days?.[day]?.members ?? {}).map(cleanTag));
      await runAtRiskWarnings({ client, db, profiles: warProfiles, history, last7, isWarDayForKey, guild, roleIds, clanTagsSet: warClanTagsSet, day });
    }
    if (!manualSafe) {
      await runPostBreakEnforcement({ client, guild, db, runtime, history, logsChannelId, decisionsChannelId, publicDecisionsChannelId });
      await runBreakExpiryReminders({ client, db, inviteUrl: recruitConfig?.warServer?.inviteUrl });
      await runNewClanJoinersReport({ client, db, runtime, history, day }).catch(e => console.error('[RECRUIT] New clan joiners report failed:', String(e?.message ?? e)));
    }
    return {
      day,
      shouldJudgeToday: false,
      line: skipLine,
      source: judgeSource,
      anchorCycle: anchorDecision?.cycleLabel ?? null,
      mode,
    };
  }

  const profiles = db.prepare(
    "SELECT discord_id, player_tag, status, updated_at FROM profiles WHERE player_tag IS NOT NULL AND player_tag != ''"
  ).all();

  const clanToday = history?.days?.[day]?.members ?? {};
  // Prefer the live roster fetched above for "still in the clan" — see
  // liveClanTags's declaration for why history's own day bucket can't answer
  // that question. Only degrade to the snapshot-derived approximation when this
  // cycle's live fetch failed (liveClanTags stays null in that case).
  const clanTagsSet = liveClanTags ?? new Set(Object.keys(clanToday).map(cleanTag));

  const membersToday = Object.values(clanToday).map(r => ({
    tag: cleanTag(r?.tag),
    name: r?.name ?? 'Unknown',
    donations: num(r?.donations),
    lastSeen: r?.lastSeen ?? null,
    role: r?.role ?? 'member',
  })).filter(m => m.tag);

  // GRACE_DAYS was missing here — computeHistoryWeightedRisk fell back to its
  // internal 7-day default instead of the configured value, which feeds directly
  // into inOpsWeakRange below (score.inGrace gates the warcore demotion override).
  // A genuinely underperforming warcore member would have been shielded from that
  // override for up to 6 extra days past the intended grace window.
  const graceDays = Number(process.env.GRACE_DAYS ?? 1);
  const scored7 = computeHistoryWeightedRisk(history, membersToday, { daysWindow: 7, minHistoryDays: 3, graceDays, expectedDecksPerDay: EXPECTED_DECKS_PER_DAY, isWarDayForKey, warActiveToday: shouldJudgeToday });
  const scoreByTag = new Map(scored7.map(m => [cleanTag(m.tag), m]));

  const results = [];
  const untracked = [];
  const bootReview = [];
  const onBreak = [];
  const roleChanges = [];
  const leftClan = [];
  const invalidStoredTags = [];
  let heldNoWarData = 0;

  for (const p of profiles) {
    const discordId = String(p.discord_id);
    const tag = normalizePlayerTag(p.player_tag);
    if (!discordId || !tag) {
      if (discordId) {
        invalidStoredTags.push({
          discordId,
          rawTag: String(p.player_tag ?? ''),
          status: String(p.status ?? 'unknown'),
        });
      }
      continue;
    }

    const inClan = clanTagsSet.has(tag);

    const activeBreak = getActiveBreak(db, discordId);
    if (activeBreak) {
      // A break shields the member from EVALUATION, not from clan-membership sync.
      // If they verifiably left the clan while on break, they quit — clear the
      // break and fall through to the normal offboard path below.
      const leftClanVerified = !inClan && !manualSafe && snapshotRefreshOk;
      if (!leftClanVerified) {
        onBreak.push({ discordId, tag, breakUntil: activeBreak.breakUntil });
        const state = getUnderwatchState(db, discordId);
        if (state && state.pauseStartedAt == null) {
          upsertUnderwatchState(db, {
            discordId,
            startedAt: state.startedAt,
            pauseAccumMs: state.pauseAccumMs,
            pauseStartedAt: Date.now(),
            lastNotifiedAt: state.lastNotifiedAt,
          });
        }

        const prob = getProbationState(db, discordId);
        if (prob) {
          // Pause probation streak without counting break days as "clean" days.
          upsertProbationState(db, {
            discordId,
            cleanStreakDays: prob.cleanStreakDays,
            lastEvalDay: day,
            paused: true,
          });
        }
        continue;
      }

      db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
      clearPostBreakEnforcement(db, discordId);
    }

    if (!inClan) {
      untracked.push({ discordId, tag, name: latestKnownName(history, tag) });
      if (manualSafe) {
        continue;
      }
      if (!snapshotRefreshOk) {
        continue;
      }

      try {
        const { state, member } = await confirmMemberGone(guild, discordId);
        if (state === 'unknown') {
          console.error(`[RECRUIT] Membership check inconclusive for <@${discordId}>, skipping this cycle.`);
          continue;
        }
        const profileStatus = String(p.status ?? '');

        if (!member) {
          // Left the server too — their roles are gone with them, so do a DB-side
          // offboard only. Status 'removed' means this was already fully processed
          // (by handleMemberLeave or a previous run) — skip to avoid double-notifying.
          if (profileStatus === 'removed') continue;

          db.prepare(`
            UPDATE profiles
            SET status = ?, probation_until = NULL, updated_at = ?
            WHERE discord_id = ?
          `).run('removed', Date.now(), discordId);

          db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
          clearUnderwatchState(db, discordId);
          clearProbationState(db, discordId);
          clearPostBreakEnforcement(db, discordId);

          leftClan.push({ discordId, tag, name: latestKnownName(history, tag), changed: [], removeApplied: false });

          // Their clan spot is free — offer it to the next person on the waitlist.
          await notifyNextWaiting(client, db, recruitGuildId).catch(() => {});

          const notifyKey = `offboard.notified.${discordId}`;
          if (String(getRecruitSetting(db, notifyKey) ?? '') !== day) {
            const playerName = latestKnownName(history, tag) ?? tag;
            await safeSend(client, removalQueueChannelId || decisionsChannelId || logsChannelId, {
              embeds: [new EmbedBuilder()
                .setTitle('Left Clan and Server')
                .setColor(0xed4245)
                .addFields(
                  { name: 'Player', value: `${playerName} — #${tag}`, inline: true },
                  { name: 'Discord', value: `<@${discordId}>`, inline: true },
                  { name: 'Trigger', value: 'Missing from clan roster and no longer in the Discord server', inline: true },
                  { name: 'Actions taken', value: 'Profile marked removed · tracking cleared · waitlist notified', inline: false },
                )
                .setTimestamp()
              ],
            });
            setRecruitSetting(db, notifyKey, day);
          }
          continue;
        }

        const hasClanManagedRole = hasAnyRole(member, [
          roleIds.member,
          roleIds.warcore,
          roleIds.underwatch,
          roleIds.probation,
          String(runtime?.roles?.onBreakRoleId ?? ''),
        ]);
        const alreadyRemoved = isValidDiscordId(removeRoleId) && member.roles.cache.has(removeRoleId);

        if (profileStatus === 'removed') {
          // Already fully processed — by this exact loop on a prior day, or by
          // handleMemberLeave. The notifyNextWaiting call further below must only ever
          // fire once per actual vacancy: it hands the freed spot to the next waitlisted
          // person, so re-running it here every day a leader hasn't yet gotten around to
          // manually kicking this member (KRAKEN can't kick — see the removal-queue
          // message) would offer the same single spot to a different person each day.
          // Only exception: keep the remove role self-healed if it's somehow drifted
          // (e.g. a leader manually restored a clan-managed role by mistake).
          if (hasClanManagedRole || !alreadyRemoved) {
            await applyRemovedRoleState({
              member,
              runtime,
              reason: 'KRAKEN clan membership sync (re-affirm remove role)',
              db,
            }).catch(() => {});
          }
          continue;
        }

        const shouldOffboard = hasClanManagedRole || alreadyRemoved || profileStatus === 'approved' || profileStatus === 'probation';
        if (!shouldOffboard) continue;

        const offboard = await applyRemovedRoleState({
          member,
          runtime,
          reason: 'KRAKEN clan membership sync (not in current clan roster)',
          db,
        });
        if (offboard?.skipped === 'remove-role-missing') {
          await safeSendDecisionEmbeds(client, decisionsChannelId || logsChannelId, {
            title: '🐙 KRAKEN Recruit Decision',
            lines: [
              `Offboard skipped for **${displayMember({ tag })}**.`,
              'Reason: remove role ID is missing, so KRAKEN could not apply the removal state.',
            ],
            color: 0xed4245,
          });
          continue;
        }

        db.prepare(`
          UPDATE profiles
          SET status = ?, probation_until = NULL, updated_at = ?
          WHERE discord_id = ?
        `).run('removed', Date.now(), discordId);

        db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
        clearUnderwatchState(db, discordId);
        clearProbationState(db, discordId);
        clearPostBreakEnforcement(db, discordId);

        leftClan.push({ discordId, tag, name: latestKnownName(history, tag), changed: offboard.changed, removeApplied: offboard.removeApplied });

        // Offer the freed slot to the next person on the waitlist.
        await notifyNextWaiting(client, db, recruitGuildId).catch(() => {});

        const notifyKey = `offboard.notified.${discordId}`;
        if (String(getRecruitSetting(db, notifyKey) ?? '') !== day) {
          const playerName = latestKnownName(history, tag) ?? tag;
          const rolesLine = offboard.removeApplied
            ? 'Clan/recruit roles removed · Remove role applied'
            : 'Clan/recruit roles removed · **Remove role missing** — apply manually';
          await safeSend(client, removalQueueChannelId || decisionsChannelId || logsChannelId, {
            embeds: [new EmbedBuilder()
              .setTitle('Not Found in Clan Roster')
              .setColor(0xed4245)
              .addFields(
                { name: 'Player', value: `${playerName} — #${tag}`, inline: true },
                { name: 'Discord', value: `<@${discordId}>`, inline: true },
                { name: 'Trigger', value: 'Missing from today\'s clan snapshot', inline: true },
                { name: 'Actions taken', value: rolesLine, inline: false },
                { name: 'Action needed', value: 'Confirm they have left the clan in Clash Royale. Remove from server if not already done.', inline: false },
              )
              .setTimestamp()
            ],
          });
          setRecruitSetting(db, notifyKey, day);
        }
      } catch {
        // ignore per-member offboard failures
      }
      continue;
    }

    const sum7 = summarizeWindow(history, tag, last7, EXPECTED_DECKS_PER_DAY, isWarDayForKey);
    const sum14 = summarizeWindow(history, tag, last14, EXPECTED_DECKS_PER_DAY, isWarDayForKey);
    const policy = evaluateWarTierPolicy({ currentTier: 'probation', sum7, sum14 });
    if (policy?.hold) heldNoWarData += 1;

    const noActivity14 = isTwoWarInactive(sum14);
    if (noActivity14) bootReview.push({ discordId, tag, name: latestKnownName(history, tag) });

    results.push({ discordId, tag, name: latestKnownName(history, tag), sum7, sum14, policy });
  }

  for (const r of results) {
    try {
      const member = await guild.members.fetch(r.discordId);
      if (!member) continue;

      const currentTier = tierFromRoles(member, roleIds);
      const policy = evaluateWarTierPolicy({ currentTier, sum7: r.sum7, sum14: r.sum14 });
      let desiredTier = policy.desiredTier;

      const score = scoreByTag.get(cleanTag(r.tag)) ?? null;
      const inOpsWeakRange =
        score &&
        !score.inGrace &&
        (
          (Number(score.risk ?? 0) >= 0.55) ||
          (Number(score.warParticipationRate ?? 0) <= 60) ||
          (Number(score.daysInactive ?? 0) >= 7) ||
          Boolean(score.repeatOffender)
        );

      if (currentTier === 'warcore' && !policy.hold && !policy.remove && inOpsWeakRange && desiredTier === 'warcore') {
        desiredTier = 'probation';
      }

      let change = { changed: false, before: currentTier, after: currentTier };
      let profileStatus = profileStatusFromTier(desiredTier);
      let bootReviewOffboard = null;
      if (manualSafe) {
        // Manual test run: preview only. Report what WOULD change without touching
        // roles, profile statuses, or tracking state.
        const after = policy.remove ? 'remove' : desiredTier;
        change = { changed: after !== currentTier, before: currentTier, after };
        if (policy.remove) profileStatus = 'removed';
      } else if (policy.remove) {
        bootReviewOffboard = await applyRemovedRoleState({
          member,
          runtime,
          reason: 'KRAKEN evaluator: inactive across 1 full war week',
          db,
        });
        change = {
          changed: Boolean(bootReviewOffboard?.changed),
          before: currentTier,
          after: 'remove',
        };
        profileStatus = 'removed';
      } else {
        change = await applyWarHubRoles({ member, ids: roleIds, desiredTier, db });
        // Write what the role cache actually verified, not the tier we merely
        // intended — see applyWarHubRoles' comment for why these can diverge.
        profileStatus = profileStatusFromTier(change.after);
      }

      if (!manualSafe) {
        db.prepare(`
          UPDATE profiles
          SET status = ?, updated_at = ?, probation_until = CASE WHEN ? = 'probation' THEN probation_until ELSE NULL END
          WHERE discord_id = ?
        `).run(profileStatus, Date.now(), profileStatus, r.discordId);
      }
      if (change.changed) {
        const extraReasons = [];
        if (currentTier === 'warcore' && inOpsWeakRange && desiredTier !== 'warcore') {
          const riskPct = Math.round(Number(score?.risk ?? 0) * 100);
          const warPct = Math.round(Number(score?.warParticipationRate ?? 0));
          const inactive = score?.daysInactive == null ? '?' : Number(score.daysInactive);
          extraReasons.push(`OPS_RANGE risk:${riskPct}% war:${warPct}% inactive:${inactive}d repeat:${Boolean(score?.repeatOffender)}`);
        }
        if (bootReviewOffboard?.incomplete) {
          extraReasons.push('⚠️ ROLE_REMOVAL_INCOMPLETE — remove role or tier-role strip did not fully verify on Discord; check this member\'s roles manually.');
        }
        const changeReasons = [...(policy.reasons ?? []), ...extraReasons];
        roleChanges.push({
          discordId: r.discordId,
          tag: r.tag,
          name: r.name,
          before: change.before,
          after: change.after,
          reasons: changeReasons,
          summary7: r.sum7,
          summary14: r.sum14,
        });
        if (!manualSafe) {
          await sendDmSafe(client, r.discordId, buildTierChangeDm({
            before: change.before,
            after: change.after,
            reasons: changeReasons,
            sum7: r.sum7,
            sum14: r.sum14,
            name: r.name,
          }));
        }
      }

      if (!manualSafe) {
        if (policy.remove) {
          clearUnderwatchState(db, r.discordId);
          clearProbationState(db, r.discordId);
        } else if (desiredTier === 'underwatch') {
          const now = Date.now();
          const existing = getUnderwatchState(db, r.discordId);
          const pauseResolved = existing && existing.pauseStartedAt != null
            ? {
              pauseAccumMs: (existing.pauseAccumMs ?? 0) + Math.max(0, now - existing.pauseStartedAt),
              pauseStartedAt: null
            }
            : { pauseAccumMs: existing?.pauseAccumMs ?? 0, pauseStartedAt: existing?.pauseStartedAt ?? null };

          const startedAt = existing?.startedAt && existing.startedAt > 0 ? existing.startedAt : now;

          upsertUnderwatchState(db, {
            discordId: r.discordId,
            startedAt,
            pauseAccumMs: pauseResolved.pauseAccumMs,
            pauseStartedAt: pauseResolved.pauseStartedAt,
            lastNotifiedAt: existing?.lastNotifiedAt ?? null,
          });

          // Removal now follows the completed-war inactivity rule, not a fixed 14-day timer.
        } else {
          clearUnderwatchState(db, r.discordId);
        }

        if (desiredTier === 'warcore' || policy.remove) {
          clearProbationState(db, r.discordId);
        } else if (desiredTier === 'probation') {
          upsertProbationState(db, { discordId: r.discordId, cleanStreakDays: 0, lastEvalDay: day, paused: false });
        }
      }
    } catch {
      // ignore per-member failures
    }
  }

  // Summary logs (no pings)
  const anchorTxt = anchorDecision
    ? `, anchor=${anchorDecision.cycleLabel}`
    : '';
  const line = `[RECRUIT] Daily eval ${day}: judged ${results.length}, roleChanges ${roleChanges.length}, held_no_war_data ${heldNoWarData}, onBreak ${onBreak.length}, untracked ${untracked.length}, bootReview ${bootReview.length} (source=${judgeSource}, periodWarDay=${String(periodWarDay)}, liveWarDay=${String(liveWarDay)}, snapshotWarDay=${snapshotWarDay}${anchorTxt}).`;
  console.log(line);
  await safeSendLogEmbed(client, logsChannelId, {
    title: `KRAKEN Eval ${day}`,
    lines: [
      `Judged: ${results.length}.`,
      `Role changes: ${roleChanges.length}.`,
      `Held (no war data): ${heldNoWarData}.`,
      `On break: ${onBreak.length}.`,
      `Tracked but not in snapshot: ${untracked.length}.`,
      `Boot review: ${bootReview.length}.`,
      '',
      `Decision source: ${judgeSource}.`,
      `War-day signals: period=${String(periodWarDay)}, live=${String(liveWarDay)}, snapshot=${snapshotWarDay}.${anchorDecision ? ` anchor=${anchorDecision.cycleLabel}.` : ''}`,
    ],
  });

  if (roleChanges.length > 0) {
    // Brief summary line in admin logs
    await safeSendLogEmbed(client, logsChannelId, {
      title: `KRAKEN Role Changes ${day}`,
      lines: [
        ...roleChanges.slice(0, 12).map(r => {
          const sum = r.summary14 ?? r.summary7;
          const sumForbiddenDesc = describeForbiddenActions(sum);
          const stats = sum && num(sum.expectedDecks) > 0
            ? ` (${num(sum.usedDecks)}/${num(sum.expectedDecks)} decks · ${num(sum.missedWarDays)}/${num(sum.warDays)} war days missed${sumForbiddenDesc ? ` · forbidden: ${sumForbiddenDesc}` : ''})`
            : '';
          return `**${displayMember(r)}**: ${r.before} → ${r.after}${stats}`;
        }),
        ...(roleChanges.length > 12 ? [`(+${roleChanges.length - 12} more)`] : []),
      ],
    });
    // Permanent per-member rich record in admin logs — never deleted, full context for future reference
    const adminContainers = roleChanges.map(buildRichMemberContainer);
    for (const group of chunk(adminContainers, 10)) {
      await safeSend(client, logsChannelId, { components: group, flags: MessageFlags.IsComponentsV2 });
    }
  }

  // Public-facing weekly decisions — last 3 review cycles are kept visible,
  // oldest is deleted when a 4th arrives so the channel stays readable.
  // Skipped in manual mode: a test run must not post to (or prune) the public channel.
  if (!manualSafe && isValidDiscordId(publicDecisionsChannelId)) {
    const newMessageIds = [];

    // Summary header
    const summaryContainer = buildDashboardContainer({
      accentColor: roleChanges.length === 0 ? STATUS_COLORS.healthy : STATUS_COLORS.neutral,
      thumbnailUrl: CLAN_BADGE_URL,
      header: `## 🐙 KRAKEN Weekly Decisions — ${day}`,
      blocks: [
        `Judged: **${results.length}** • Role changes: **${roleChanges.length}** • On break: **${onBreak.length}**`,
        roleChanges.length === 0
          ? '_No tier changes this week. All tracked members are within performance thresholds._\n\n_See the pinned message above for tier rules and promotion requirements._'
          : '_Individual decisions are shown below. See the pinned message above for tier rules._',
      ],
    });
    const summaryMsg = await safeSendTracked(client, publicDecisionsChannelId, { components: [summaryContainer], flags: MessageFlags.IsComponentsV2 });
    if (summaryMsg?.id) newMessageIds.push(summaryMsg.id);

    // Rich per-member container for every role change — full context, reason, what to do next
    if (roleChanges.length > 0) {
      const memberContainers = roleChanges.map(buildRichMemberContainer);
      for (const group of chunk(memberContainers, 10)) {
        const msg = await safeSendTracked(client, publicDecisionsChannelId, { components: group, flags: MessageFlags.IsComponentsV2 });
        if (msg?.id) newMessageIds.push(msg.id);
      }
    }

    await managePublicDecisionsHistory(client, publicDecisionsChannelId, db, newMessageIds);
  }

  const celebrationsThreadId = String(runtime?.channels?.celebrationsThreadId ?? '');
  const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');

  // PERFECT WAR HONORS — 3600 fame is the weekly maximum (900/day × 4 battle days,
  // fact-checked against Supercell's medal system): every battle fought, every one won.
  // Announced in the celebrations thread with a kraken-member role ping so the whole hub
  // sees it. Runs inside the once-per-war-week review, so it can never double-post.
  if (!manualSafe) {
    const perfectWarriors = results.filter(r => Number(r.sum7?.fame ?? 0) >= 3600);
    for (const r of perfectWarriors) {
      if (!isValidDiscordId(r.discordId)) continue;
      const who = displayMember(r);
      const s = r.sum7 ?? {};
      await postCelebration(client, celebrationsThreadId, {
        content: isValidDiscordId(memberRoleId) ? `<@&${memberRoleId}> Witness. <@${r.discordId}>` : `Witness. <@${r.discordId}>`,
        title: '⚔️ THE GODS HAVE SPOKEN — VALHALLA TAKES NOTICE',
        description: [
          `**${who}** has done what lesser warriors only whisper about.`,
          '',
          '**A PERFECT WAR. 3600 / 3600.**',
          'Every battle fought. Every battle won. Nothing left on the field.',
          '',
          'KRAKEN does not hand out praise. KRAKEN keeps the record.',
          'And this record is *flawless*.',
          '',
          '🏛️ This warrior walks in the grace of the gods. The gates of Valhalla stand open — a seat at the long table is already set.',
          '',
          'The rest of you? KRAKEN is still watching.',
        ].join('\n'),
        fields: [{
          name: 'The Record',
          value: [
            `🏅 Fame: **${num(s.fame)} / 3600**`,
            `🃏 Decks: **${num(s.usedDecks)}/${num(s.expectedDecks)}**`,
            `📅 War days missed: **${num(s.missedWarDays)}**`,
          ].join('\n'),
          inline: false,
        }],
        footer: 'KRAKEN • perfect war honors • earned, never given',
        discordId: r.discordId,
        roleId: memberRoleId,
        logLabel: 'Valhalla honors',
      });
    }
  }

  // WARCORE PROMOTION — a new public celebration alongside the existing private
  // "You have been promoted to WARCORE" DM (buildTierChangeDm, sent earlier above)
  // — that DM stays as the detailed/private notice, this is the short public one.
  if (!manualSafe) {
    const promotions = roleChanges.filter(r => r.before === 'probation' && r.after === 'warcore');
    for (const r of promotions) {
      if (!isValidDiscordId(r.discordId)) continue;
      const who = displayMember(r);
      await postCelebration(client, celebrationsThreadId, {
        content: isValidDiscordId(memberRoleId) ? `<@&${memberRoleId}> Rise. <@${r.discordId}>` : `Rise. <@${r.discordId}>`,
        title: '🛡️ THE GATES OF WARCORE OPEN',
        description: [
          `**${who}** has proven themselves.`,
          '',
          'Probation is over. The trial is complete. Consistency, discipline, decks spent without hesitation — KRAKEN has seen enough.',
          '',
          `**Welcome to WARCORE, ${who}.**`,
          '',
          "The clan's line just got stronger.",
        ].join('\n'),
        footer: 'KRAKEN • warcore promotion • earned, never given',
        discordId: r.discordId,
        roleId: memberRoleId,
        logLabel: 'WARCORE promotion',
      });
    }
  }

  // CLAN HALL OF FAME — donor, war champion, and iron attendance records share
  // one holder each; reconcile on leave before checking for record movement.
  // weekRankCache is shared across every buildWarHistoryRecord call in this block
  // so each completed week's ranking is computed once, not once per member.
  if (!manualSafe) {
    const weekRankCache = new Map();
    await announceClanHallOfFameRecords({
      client,
      db,
      history,
      results,
      celebrationsThreadId,
      memberRoleId,
      logsChannelId,
      expectedDecksPerDay: EXPECTED_DECKS_PER_DAY,
      clanTagsSet,
      weekRankCache,
    });
  }

  if (untracked.length > 0) {
    const sample = untracked.slice(0, 15).map(r => `**${displayMember(r)}**`).join(', ');
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Linkage Audit',
      lines: [
        'Tracked profiles not found in the current clan snapshot.',
        `Members: ${sample}${untracked.length > 15 ? ` (+${untracked.length - 15} more)` : ''}`,
      ],
      color: 0xfee75c,
    });
  }

  if (invalidStoredTags.length > 0) {
    const lines = invalidStoredTags.slice(0, 15).map(row => {
      const raw = row.rawTag ? `"${row.rawTag}"` : '(empty)';
      return `${raw} status=${row.status} discord=${row.discordId}`;
    });
    await safeSendDecisionEmbeds(client, decisionsChannelId || logsChannelId, {
      title: '🐙 KRAKEN Data Audit',
      lines: [
        'Invalid stored player tags detected. Manual cleanup required.',
        '',
        ...lines,
        ...(invalidStoredTags.length > 15 ? [`(+${invalidStoredTags.length - 15} more)`] : []),
      ],
      color: 0xed4245,
    });
  }

  if (!manualSafe && leftClan.length > 0) {
    const sample = leftClan.slice(0, 12).map(r => `**${displayMember(r)}**`).join(', ');
    await safeSendDecisionEmbeds(client, decisionsChannelId || logsChannelId, {
      title: '🐙 KRAKEN Clan Sync',
      lines: [
        `Offboarded **${leftClan.length}** member(s) missing from the current clan roster.`,
        `Members: ${sample}${leftClan.length > 12 ? ` (+${leftClan.length - 12} more)` : ''}`,
      ],
      color: 0xed4245,
    });
    await safeSendLogEmbed(client, logsChannelId, {
      title: 'KRAKEN Clan Sync',
      lines: [
        `Offboarded ${leftClan.length} member(s) missing from the current clan roster.`,
        `Members: ${sample}${leftClan.length > 12 ? ` (+${leftClan.length - 12} more)` : ''}`,
      ],
      color: 0xed4245,
    });
  }

  if (bootReview.length > 0) {
    const sample = bootReview.slice(0, 15).map(r => `**${displayMember(r)}**`).join(', ');
    await safeSendDecisionEmbeds(client, decisionsChannelId || logsChannelId, {
      title: '🐙 KRAKEN Boot Review',
      lines: [
        `Members flagged for boot review: ${sample}${bootReview.length > 15 ? ` (+${bootReview.length - 15} more)` : ''}`,
        'Reason: inactive across the completed-war review window.',
      ],
      color: 0xed4245,
    });
  }

  // Mark this war week as reviewed so it runs exactly once — later training days in
  // the same week skip it, and a review missed due to downtime is caught up exactly
  // once on the next eval (rather than being lost or repeated).
  // Not stamped in manual mode: a preview run must not consume the week's real review.
  if (!manualSafe && latestWarDayKey) {
    setRecruitSetting(db, 'eval.lastReviewedWarDay', latestWarDayKey);
  }

  if (!manualSafe) {
    await runPostBreakEnforcement({ client, guild, db, runtime, history, logsChannelId, decisionsChannelId, publicDecisionsChannelId });
    await runBreakExpiryReminders({ client, db, inviteUrl: recruitConfig?.warServer?.inviteUrl });
    await runNewClanJoinersReport({ client, db, runtime, history, day }).catch(e => console.error('[RECRUIT] New clan joiners report failed:', String(e?.message ?? e)));
  }

  return {
    day,
    shouldJudgeToday: true,
    line,
    source: judgeSource,
    anchorCycle: anchorDecision?.cycleLabel ?? null,
    mode,
    counts: {
      judged: results.length,
      roleChanges: roleChanges.length,
      heldNoWarData,
      onBreak: onBreak.length,
      untracked: untracked.length,
      bootReview: bootReview.length,
      leftClan: leftClan.length,
    },
  };
}

export function startRecruitEvaluator(client, recruitConfig, db) {
  // A fixed wall-clock hour (the old design) is just a guess at a time that's
  // probably safely after the real Supercell period rollover — it doesn't actually
  // know when that rollover happens. Poll periodIndex directly instead (same
  // technique as the diagnostic watch-war-reset.js script) and trigger the full
  // evaluation right when it changes, so snapshots land at the true day boundary
  // instead of hours before or after it.
  const POLL_MS = 10 * 60 * 1000; // matches the proven watcher cadence
  const SAFETY_NET_MS = 24 * 60 * 60 * 1000; // force a run if periodIndex reads never change for a full day (guards against a stuck/misreading API)
  // The eval can outlast a poll interval on its own (its snapshot-refresh retry
  // path alone sleeps up to ~10 minutes), so ticks must never overlap.
  let running = false;
  let warnedNoClanTag = false;

  async function tick() {
    if (running) return;

    const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
    if (!clanTag) {
      // Without a clan tag the eval below never runs, so nothing else will ever
      // surface this — warn once here instead of going silent forever.
      if (!warnedNoClanTag) {
        warnedNoClanTag = true;
        console.error('[RECRUIT] Evaluator disabled: CLAN_TAG is missing from .env — set it and restart.');
      }
      return;
    }

    let currentPeriodIndex = null;
    try {
      const race = await getCurrentRiverRace(clanTag);
      const parsed = Number(race?.periodIndex);
      currentPeriodIndex = Number.isFinite(parsed) ? parsed : null;
    } catch (e) {
      console.error('[RECRUIT] Evaluator: periodIndex check failed, will retry next tick:', String(e?.message ?? e));
      return;
    }

    const lastSeenRaw = getRecruitSetting(db, 'eval.lastSeenPeriodIndex');
    const lastSeenPeriodIndex = lastSeenRaw != null && lastSeenRaw !== '' ? Number(lastSeenRaw) : null;
    const lastRunAtMs = Number(getRecruitSetting(db, 'eval.lastRunAtMs') ?? 0) || 0;

    // "First ever" requires no successful run on record too — if the API serves a
    // race without a periodIndex for an extended stretch (off-season), the first
    // successful run stamps lastRunAtMs and the safety net paces things from there,
    // instead of re-firing a "startup" eval every 10 minutes.
    const isFirstEverCheck = lastSeenPeriodIndex === null && lastRunAtMs === 0;
    const transitioned = !isFirstEverCheck && currentPeriodIndex !== null && currentPeriodIndex !== lastSeenPeriodIndex;
    const safetyNetDue = lastRunAtMs > 0 && (Date.now() - lastRunAtMs) >= SAFETY_NET_MS;

    // Run on: the very first check ever (startup bootstrap/catch-up — covers a
    // transition that happened while the bot was offline), a real detected
    // transition, or the 24h safety net if nothing has fired for a full day.
    if (!isFirstEverCheck && !transitioned && !safetyNetDue) return;

    const trigger = transitioned ? 'transition' : (isFirstEverCheck ? 'startup' : 'safety-net');
    running = true;
    try {
      // finalizePreviousDay only on a genuine flip — see the merge site for why.
      const result = await runRecruitDailyEvaluation(client, recruitConfig, db, { finalizePreviousDay: transitioned });
      if (result === undefined) {
        console.error(`[RECRUIT] Evaluator tick: eval bailed without a result; will retry next tick (trigger=${trigger})`);
        return;
      }
      // Stamp only after a completed run. Stamping the sighting up front consumed
      // the transition even when the eval then failed — pushing the retry out to
      // the next periodIndex change (~a day away) or the 24h net, instead of the
      // next 10-minute tick.
      if (currentPeriodIndex !== null) {
        setRecruitSetting(db, 'eval.lastSeenPeriodIndex', String(currentPeriodIndex));
      }
      setRecruitSetting(db, 'eval.lastRunAtMs', String(Date.now()));
      console.log(`[RECRUIT] Evaluator tick complete (trigger=${trigger}, periodIndex=${currentPeriodIndex})`);
    } catch (e) {
      console.error(`[RECRUIT] Evaluator tick failed (trigger=${trigger}):`, String(e?.message ?? e));
    } finally {
      running = false;
    }
  }

  setInterval(() => {
    tick().catch(() => {});
  }, POLL_MS);

  // Run once immediately on startup — acts as both the initial baseline read and
  // catch-up for a transition that happened while the bot was offline. The two
  // startup audits below both read profiles.status + live Discord roles, and
  // tick() can write both on a genuine transition — running them concurrently
  // with tick() can misread tick()'s own routine sync as manual role drift, so
  // they're sequenced to run only after this first tick settles.
  tick().catch(() => {}).finally(() => {
    // Startup audit-only backfill summary: surfaces prior-day stats after downtime.
    runStartupBackfillAudit({ client, recruitConfig, db }).catch(() => {});
    // Startup role-drift audit: catches Discord role changes made manually
    // while KRAKEN was offline, which nothing else in this codebase can ever
    // detect (manual-role-sync.js only reacts to live gateway events).
    runStartupRoleDriftAudit({ client, recruitConfig, db }).catch(() => {});
  });
}
