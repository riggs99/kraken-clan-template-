import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getClan, getCurrentRiverRace, getRiverRaceLog } from './cr-api.js';
import { buildMemberIntel, filterToCurrentClan } from './war-intel.js';
import { upsertTodaySnapshot, loadHistory } from './history.js';
import { computeHistoryWeightedRisk } from './risk-score.js';
import { classifyPlayers } from './promotions.js';
import { rankWarWeek } from './recruit/policy.js';
import { getLastCompletedWarWeek } from './history.js';
import { todayKeyISO } from './util.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS, medalOrRank } from './dashboard-components.js';
import { isHistoricalWarDay, parseWarAnchorMsFromEnv, warDayFromPeriodType, getWarDayDecision, isWarActivityPresent } from './war-cycle.js';
import { updateDisciplineFromDailyReport, stageLabel } from './discipline.js';
import { initDb, getExpectedDecksPerDay, getRecruitRuntimeIds, recordNameChanges, getRecruitSetting, setRecruitSetting } from './recruit/db.js';
import { processWaitlistChecks } from './recruit/waitlist.js';
import { runDatabaseBackup, shouldRunBackup } from './backup.js';
import { SEASON_ROLLOVER_SCOPE_NOTE, checkCanRollSeason, isFirstMondayOfMonth } from './recruit/season-rollover.js';

function isLikelyDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

// db is optional — pass an already-open handle (e.g. a terminal script's own
// initDb() connection, or a command's ctx.db) to avoid opening a second,
// redundant connection to kraken.db just for this lookup. Falls back to
// initDb() when omitted, matching the original always-open-fresh behavior for
// existing internal callers in this file.
function getReportChannelCandidates(db) {
  const out = [];
  const add = (id) => {
    const s = String(id ?? '').trim();
    if (!isLikelyDiscordId(s)) return;
    if (!out.includes(s)) out.push(s);
  };

  add(process.env.REPORTS_CHANNEL_ID);
  add(process.env.LEADER_CHANNEL_ID);

  try {
    const resolvedDb = db ?? initDb();
    const runtime = getRecruitRuntimeIds(resolvedDb);
    add(runtime?.channels?.opsChannelId);
    add(runtime?.channels?.logsChannelId);
  } catch {
    // ignore DB/runtime lookup failure; env candidates still apply
  }

  return out;
}

let reportsWarnAt = 0;
function warnReportsOnce(message) {
  const now = Date.now();
  const cooldownMs = 6 * 60 * 60 * 1000;
  if (now - reportsWarnAt < cooldownMs) return;
  reportsWarnAt = now;
  console.error(message);
}

export async function resolveReportsChannel(client, db) {
  const candidates = getReportChannelCandidates(db);
  if (candidates.length === 0) {
    return { channel: null, channelId: null, reason: 'No report channel candidates configured' };
  }

  const reasons = [];
  for (const id of candidates) {
    try {
      const channel = await client.channels.fetch(id);
      const permCheck = checkCanSendEmbeds(client, channel);
      if (permCheck.ok) return { channel, channelId: id, reason: '' };
      reasons.push(`${id}: ${permCheck.message}`);
    } catch (e) {
      reasons.push(`${id}: ${e?.message ?? 'fetch failed'}`);
    }
  }

  return { channel: null, channelId: null, reason: reasons.join(' | ') || 'No valid report channel' };
}

function checkCanSendEmbeds(client, channel) {
  if (!channel) return { ok: false, message: 'Channel not found' };
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
    return { ok: false, message: 'Channel is not text-based' };
  }

  const meId = client?.user?.id;
  if (!meId) return { ok: false, message: 'Client not ready (missing client.user)' };

  if (typeof channel.permissionsFor !== 'function') return { ok: true, message: '' };

  const perms = channel.permissionsFor(meId);
  if (!perms) return { ok: false, message: 'Cannot resolve permissions for bot in this channel' };

  const required = [
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    ['SendMessages', PermissionFlagsBits.SendMessages],
    ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ];

  const missing = required.filter(([, bit]) => !perms.has(bit)).map(([name]) => name);
  if (missing.length > 0) {
    return { ok: false, message: `Missing permissions: ${missing.join(', ')}` };
  }

  return { ok: true, message: '' };
}

/**
 * Send daily clan activity report
 */
async function sendDailyReport(client) {
  const resolved = await resolveReportsChannel(client);
  const CLAN_TAG = process.env.CLAN_TAG;
  
  if (!resolved.channel || !CLAN_TAG) {
    console.log('[SCHEDULE] Daily report skipped: REPORTS_CHANNEL_ID (or LEADER_CHANNEL_ID fallback) or CLAN_TAG not configured');
    if (!resolved.channel) warnReportsOnce(`[SCHEDULE] Reports disabled: ${resolved.reason}`);
    return;
  }

  try {
    const [clan, race, raceLog] = await Promise.all([
      getClan(CLAN_TAG),
      getCurrentRiverRace(CLAN_TAG),
      getRiverRaceLog(CLAN_TAG),
    ]);

    let members = buildMemberIntel({ clan, race, clanTag: CLAN_TAG });
    // A truly empty roster from a functioning, previously-populated clan almost certainly means
    // an upstream API hiccup (a 200 OK with a thin/empty payload) rather than a real clan-wide
    // wipe — proceeding would feed an empty weakLinks list into updateDisciplineFromDailyReport
    // below, which resets every currently-tracked member's SEEN/WARNED/KICK REVIEW streak to 0
    // with no way to tell "genuinely improved" apart from "no data this run."
    if (members.length === 0) {
      console.error('[SCHEDULE] Daily report: buildMemberIntel returned an empty roster — skipping this run rather than risk resetting discipline state from bad data.');
      return;
    }
    // Pass meta so report-driven snapshots also stamp the day's war/period identity —
    // the reports were the one snapshot path leaving buckets unflagged, which mattered
    // whenever the bot happened to be offline at the evaluator's transition tick.
    // raceLog/clanTag let upsertTodaySnapshot run its own self-healing reconciliation
    // internally — this is the one guaranteed once-daily snapshot even if no leader
    // opens a command all day, so it needs the same protection against missing a
    // member's final war-day burst as /ops and /war.
    const dailySnapshot = upsertTodaySnapshot(members, {
      periodType: race?.periodType,
      warDay: warDayFromPeriodType(race),
      periodIndex: race?.periodIndex,
      raceLog,
      clanTag: CLAN_TAG,
    });
    const history = dailySnapshot.history;
    const nameChanges = dailySnapshot.nameChanges;
    // members (above) deliberately still includes anyone who fought this race and has
    // since left the clan — buildMemberIntel keeps them so the snapshot just written
    // isn't undercounted. Everything below (report stats, discipline escalation) should
    // reflect who's ACTUALLY in the clan right now, matching the same fix in /ops and
    // /war-board.
    members = filterToCurrentClan(members, clan);

    const _schedDb = initDb();
    const newNameChanges = recordNameChanges(_schedDb, nameChanges ?? []);
    if (newNameChanges.length > 0) {
      const runtime = getRecruitRuntimeIds(_schedDb);
      const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
      if (/^\d{17,20}$/.test(logsChannelId)) {
        const ch = await client.channels.fetch(logsChannelId).catch(() => null);
        if (ch?.send) {
          await ch.send({
            embeds: [new EmbedBuilder()
              .setTitle('KRAKEN — Player Name Changes')
              .setColor(0x5865f2)
              .setDescription(newNameChanges.map(({ tag, oldName, newName }) =>
                `**#${String(tag).replace(/^#/, '')}** — \`${oldName}\` → \`${newName}\``
              ).join('\n'))
            ],
            allowedMentions: { parse: [] },
          });
        }
      }
    }

    const graceDays = Number(process.env.GRACE_DAYS ?? 1);
    const expectedDecksPerDay = getExpectedDecksPerDay(_schedDb);
    const dailyAnchorMs = parseWarAnchorMsFromEnv();
    const dailyIsWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, dailyAnchorMs);
    const dailyWarActive = getWarDayDecision({
      race,
      snapshotWarDay: isWarActivityPresent(members),
      nowMs: Date.now(),
    }).shouldJudgeToday;
    const scored = computeHistoryWeightedRisk(history, members, {
      daysWindow: 7,
      minHistoryDays: 3,
      graceDays,
      expectedDecksPerDay,
      isWarDayForKey: dailyIsWarDayForKey,
      warActiveToday: dailyWarActive,
    });

    // Calculate today's stats
    const activeMembers = members.filter(m => {
      const fame = Number(m.fame ?? 0);
      const repairs = Number(m.repairPoints ?? 0);
      const boatAttacks = Number(m.boatAttacks ?? 0);
      return fame > 0 || repairs > 0 || boatAttacks > 0;
    }).length;

    const totalFame = members.reduce((sum, m) => sum + Number(m.fame ?? 0), 0);
    const totalRepairs = members.reduce((sum, m) => sum + Number(m.repairPoints ?? 0), 0);
    const totalBoat = members.reduce((sum, m) => sum + Number(m.boatAttacks ?? 0), 0);
    const totalDecks = members.reduce((sum, m) => sum + Number(m.decksUsedToday ?? 0), 0);
    const totalDonations = members.reduce((sum, m) => sum + Number(m.donations ?? 0), 0);

    // Average only over members with enough tracked history — right after a season
    // reset everyone reads 0% for a few days purely from missing data, which made
    // this stat (and the Inactive count below) look like a clan-wide collapse.
    const reliableScored = scored.filter(m => !m.inGrace && (m.historyDays ?? 0) >= 3);
    const avgParticipation = reliableScored.length > 0
      ? Math.round(reliableScored.reduce((sum, m) => sum + (m.warParticipationRate ?? 0), 0) / reliableScored.length)
      : 0;

    // Top performers
    const topPerformers = members
      .slice()
      .sort((a, b) => Number(b.fame ?? 0) - Number(a.fame ?? 0))
      .slice(0, 5);

    const byTag = new Map(scored.map(m => [String(m.tag), m]));

    const clamp1024 = (s) => {
      const text = String(s ?? '');
      if (text.length <= 1024) return text;
      return text.slice(0, 1021) + '...';
    };

    // Weak links (leader focus): keep small, actionable, and explainable.
    // Requires historyDays >= 3 (matching minHistoryDays passed to computeHistoryWeightedRisk
    // above) before judging warParticipationRate — without this, the first day or two of a
    // fresh war/colosseum week reads as 0% participation for the whole clan simultaneously
    // (no data yet, not poor performance), and this flows into updateDisciplineFromDailyReport
    // below, which persists a streak that escalates toward KICK REVIEW. Confirmed live: this
    // was flagging 27 of 35 members today purely from insufficient tracked history.
    const weakLinkPlayers = scored
      .filter(m => !m.inGrace && (m.historyDays ?? 0) >= 3)
      .filter(m =>
        (m.risk ?? 0) >= 0.55 ||
        (m.warParticipationRate ?? 0) <= 60 ||
        (m.daysInactive ?? 0) >= 7
      )
      .slice()
      .sort((a, b) => Number(b.risk ?? 0) - Number(a.risk ?? 0))
      .slice(0, 10);

    const weakLinks = weakLinkPlayers.map(m => ({ tag: m.tag, name: m.name }));
    const disciplineUpdate = updateDisciplineFromDailyReport(weakLinks, todayKeyISO());
    const stageByTag = new Map(disciplineUpdate.updated.map(u => [u.tag, u]));

    const weakLinkLines = weakLinkPlayers.map((m, i) => {
      const rec = stageByTag.get(String(m.tag));
      const stage = stageLabel(Number(rec?.stage ?? 0));
      const streak = Number(rec?.streak ?? 0);
      const risk = Math.round(Number(m.risk ?? 0) * 100);
      const war = Number(m.warParticipationRate ?? 0);
      const inactiveTxt = m.daysInactive !== null && m.daysInactive !== undefined ? ` | inactive ${m.daysInactive}d` : '';
      const why = Array.isArray(m.reasons) && m.reasons.length ? ` | ${m.reasons.join(' | ')}` : '';
      return `${i + 1}. ${m.name} (${m.role ?? 'member'}) - ${stage} (${streak}d) | risk ${risk}% | war ${war}%${inactiveTxt}${why}`;
    });

    const kickReviewLines = disciplineUpdate.updated
      .filter(u => Number(u.stage ?? 0) >= 3)
      .slice()
      .sort((a, b) => Number(b.streak ?? 0) - Number(a.streak ?? 0))
      .slice(0, 10)
      .map((u, i) => {
        const m = byTag.get(String(u.tag));
        const name = m?.name ?? u.lastName ?? u.tag;
        const risk = Math.round(Number(m?.risk ?? 0) * 100);
        const war = Number(m?.warParticipationRate ?? 0);
        const why = Array.isArray(m?.reasons) && m.reasons.length ? ` | ${m.reasons.join(' | ')}` : '';
        return `${i + 1}. ${name} - KICK REVIEW (${Number(u.streak ?? 0)}d) | risk ${risk}% | war ${war}%${why}`;
      });

    // Same severity language /ops, /war, /war-board, and /status use — a leader
    // scanning a busy channel can tell from the accent bar alone whether today's
    // auto-report needs a look before reading a word of it.
    const dailyAccentColor = kickReviewLines.length > 0
      ? STATUS_COLORS.critical
      : (weakLinkLines.length > 0 ? STATUS_COLORS.warn : STATUS_COLORS.healthy);

    const blocks = [
      [
        '### 📊 Today\'s Activity',
        `**Active:** ${activeMembers}/${members.length} members`,
        `**Fame:** ${totalFame} · **Repairs:** ${totalRepairs} · **Boat attacks:** ${totalBoat}${totalBoat > 10 ? ' ⚠️' : ''}`,
        `**Decks used:** ${totalDecks} · **Donations:** ${totalDonations}`,
      ].join('\n'),
      [
        '### 📈 7-Day Avg',
        `**Participation:** ${avgParticipation}% · **In grace:** ${scored.filter(m => m.inGrace).length} · **Inactive:** ${reliableScored.filter(m => m.warParticipationRate === 0).length}`,
      ].join('\n'),
    ];

    if (topPerformers.length > 0) {
      blocks.push([
        '### ⭐ Top 5 Today',
        topPerformers.map((m, i) => `${i + 1}. ${m.name} — ${Number(m.fame ?? 0)} fame • ${Number(m.decksUsedToday ?? 0)} decks`).join('\n'),
      ].join('\n'));
    }

    blocks.push([
      '### ⚠️ Weak Links (SEEN → WARNED → KICK REVIEW)',
      clamp1024(weakLinkLines.length ? weakLinkLines.join('\n') : 'None today.'),
    ].join('\n'));

    if (kickReviewLines.length > 0) {
      blocks.push([
        '### 🪓 Kick Review (3+ days in a row)',
        clamp1024(kickReviewLines.join('\n')),
      ].join('\n'));
    }

    const container = buildDashboardContainer({
      accentColor: dailyAccentColor,
      thumbnailUrl: CLAN_BADGE_URL,
      header: `## 📅 Daily Clan Report — ${clan?.name ?? 'Clan'}\nDate: **${todayKeyISO()}** · Tag: **#${CLAN_TAG}**`,
      blocks,
    });

    await resolved.channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
    console.log('[SCHEDULE] Daily report sent successfully');
  } catch (error) {
    console.error('[SCHEDULE] Error sending daily report:', error.message);
  }
}

// Builds the public, member-facing highlights for the war week that just closed:
// participation, top performers, top donors. Deliberately excludes anything
// naming a demotion/kick candidate or risk score — that stays leader-only (see
// buildLeaderWeeklyBlocks). Returns null if no completed war week exists yet
// (e.g. right after a fresh reset).
function buildWeekHighlights(history, members, expectedDecksPerDay) {
  const weekDays = getLastCompletedWarWeek(history);
  if (!weekDays.length) return null;

  const ranked = rankWarWeek(history, weekDays, expectedDecksPerDay);
  const nameByTag = new Map(members.map(m => [m.tag, m.name]));
  const entries = Object.entries(ranked.byTag);
  const activeCount = entries.filter(([, e]) => e.decksTotal > 0).length;
  const expectedDecks = expectedDecksPerDay * ranked.realDayCount;
  const perfectCount = entries.filter(([, e]) => expectedDecks > 0 && e.decksTotal >= expectedDecks).length;
  const topFame = entries
    .filter(([, e]) => e.fameTotal > 0)
    .sort((a, b) => a[1].warRank - b[1].warRank)
    .slice(0, 3);
  const topDonors = entries
    .filter(([, e]) => e.donationsTotal > 0)
    .sort((a, b) => a[1].donationRank - b[1].donationRank)
    .slice(0, 3);

  return { weekDays, nameByTag, activeCount, perfectCount, topFame, topDonors, totalPeers: ranked.totalPeers };
}

function buildMemberWeeklySummaryBlocks(hl) {
  if (!hl) return ['### ℹ️ Status\nNot enough war history yet for a weekly summary.'];
  const blocks = [];
  blocks.push(`### ⚔️ This Week's War\n**${hl.activeCount}/${hl.totalPeers}** members battled · **${hl.perfectCount}** with a perfect deck record`);
  if (hl.topFame.length) {
    const lines = hl.topFame.map(([tag, e], i) => `${medalOrRank(i)} **${hl.nameByTag.get(tag) ?? `#${tag}`}** — ${e.fameTotal.toLocaleString()} fame`);
    blocks.push(`### 🏆 Top War Performers\n${lines.join('\n')}`);
  }
  if (hl.topDonors.length) {
    const lines = hl.topDonors.map(([tag, e], i) => `${medalOrRank(i)} **${hl.nameByTag.get(tag) ?? `#${tag}`}** — ${e.donationsTotal.toLocaleString()} donated`);
    blocks.push(`### 💝 Top Donors\n${lines.join('\n')}`);
  }
  blocks.push('### ℹ️ Your standing\nRun `/status` for your own tier, streaks, and history.');
  return blocks;
}

async function sendMemberWeeklySummary(client, clan, history, members, expectedDecksPerDay) {
  try {
    const runtime = getRecruitRuntimeIds(initDb());
    const memberChatChannelId = String(runtime?.channels?.memberChatChannelId ?? '');
    if (!isLikelyDiscordId(memberChatChannelId)) {
      console.log('[SCHEDULE] Member weekly summary skipped: memberChatChannelId not configured');
      return;
    }
    const channel = await client.channels.fetch(memberChatChannelId);
    const permCheck = checkCanSendEmbeds(client, channel);
    if (!permCheck.ok) {
      console.error(`[SCHEDULE] Member weekly summary skipped: ${memberChatChannelId}: ${permCheck.message}`);
      return;
    }

    const hl = buildWeekHighlights(history, members, expectedDecksPerDay);
    const container = buildDashboardContainer({
      accentColor: STATUS_COLORS.healthy,
      thumbnailUrl: CLAN_BADGE_URL,
      header: `## 📊 Weekly Clan Update — ${clan?.name ?? 'Clan'}\nWar week wrapped up — here's how it went.`,
      blocks: buildMemberWeeklySummaryBlocks(hl),
    });

    await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
    console.log('[SCHEDULE] Member weekly summary sent successfully');
  } catch (error) {
    console.error('[SCHEDULE] Error sending member weekly summary:', error.message);
  }
}

/**
 * Send weekly clan summary with promotion/demotion recommendations to the leader
 * channel, plus a sanitized member-facing highlights post to general chat.
 */
export async function sendWeeklyReport(client) {
  const resolved = await resolveReportsChannel(client);
  const CLAN_TAG = process.env.CLAN_TAG;

  if (!resolved.channel || !CLAN_TAG) {
    console.log('[SCHEDULE] Weekly report skipped: REPORTS_CHANNEL_ID (or LEADER_CHANNEL_ID fallback) or CLAN_TAG not configured');
    if (!resolved.channel) warnReportsOnce(`[SCHEDULE] Reports disabled: ${resolved.reason}`);
    return;
  }

  let sharedData = null;
  try {
    const [clan, race, raceLog] = await Promise.all([
      getClan(CLAN_TAG),
      getCurrentRiverRace(CLAN_TAG),
      getRiverRaceLog(CLAN_TAG),
    ]);

    let members = buildMemberIntel({ clan, race, clanTag: CLAN_TAG });
    const weeklySnapshot = upsertTodaySnapshot(members, {
      periodType: race?.periodType,
      warDay: warDayFromPeriodType(race),
      periodIndex: race?.periodIndex,
      raceLog,
      clanTag: CLAN_TAG,
    });
    const history = weeklySnapshot.history;
    // members (above) deliberately still includes anyone who fought this race and has
    // since left the clan — see sendDailyReport's identical fix above for why.
    members = filterToCurrentClan(members, clan);

    // Fallback-if-unset was 7 here, vs. 1 everywhere else GRACE_DAYS is read
    // (ops.js, promotions.js, schedule.js's own daily report, evaluator.js,
    // war-board.js) — dormant right now since GRACE_DAYS is actually set in .env,
    // but the weekly report would silently apply a different grace window than
    // every other command the moment it wasn't.
    const graceDays = Number(process.env.GRACE_DAYS ?? 1);
    const weeklyEdpd = getExpectedDecksPerDay(initDb());
    const weeklyAnchorMs = parseWarAnchorMsFromEnv();
    const weeklyIsWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, weeklyAnchorMs);
    const weeklyWarActive = getWarDayDecision({
      race,
      snapshotWarDay: isWarActivityPresent(members),
      nowMs: Date.now(),
    }).shouldJudgeToday;
    const scored = computeHistoryWeightedRisk(history, members, {
      daysWindow: 14,
      minHistoryDays: 7,
      graceDays,
      repeatWindowDays: 14,
      repeatThreshold: 2,
      expectedDecksPerDay: weeklyEdpd,
      isWarDayForKey: weeklyIsWarDayForKey,
      warActiveToday: weeklyWarActive,
    });

    const results = classifyPlayers(history, scored, 14, weeklyEdpd, weeklyIsWarDayForKey);
    sharedData = { clan, history, members, weeklyEdpd };

    const blocks = [];

    // Promotions — classifyPlayers's buckets inherit computeHistoryWeightedRisk's
    // descending-risk sort, which is the right order for demote/kick (riskiest first) but
    // backwards here: truncating a promotion list to the first 3 used to surface the most
    // borderline (highest-risk-of-the-eligible) candidates and hide the genuinely cleanest
    // ones behind "...and N more." Sort ascending by risk so the cleanest show first.
    const cleanestFirst = (list) => [...list].sort((a, b) => Number(a.player.risk ?? 0) - Number(b.player.risk ?? 0));
    const promoteToElderSorted = cleanestFirst(results.promoteToElder);
    const promoteToCoSorted = cleanestFirst(results.promoteToCo);
    const promoteCount = results.promoteToElder.length + results.promoteToCo.length;
    if (promoteCount > 0) {
      let promoText = '';
      if (promoteToElderSorted.length > 0) {
        promoText += `**→ Elder (${promoteToElderSorted.length}):**\n`;
        promoText += promoteToElderSorted.slice(0, 3).map(p => `• ${p.player.name}`).join('\n');
        if (promoteToElderSorted.length > 3) promoText += `\n• ...and ${promoteToElderSorted.length - 3} more`;
      }
      if (promoteToCoSorted.length > 0) {
        if (promoText) promoText += '\n\n';
        promoText += `**→ Co-Leader (${promoteToCoSorted.length}):**\n`;
        promoText += promoteToCoSorted.slice(0, 3).map(p => `• ${p.player.name}`).join('\n');
        if (promoteToCoSorted.length > 3) promoText += `\n• ...and ${promoteToCoSorted.length - 3} more`;
      }
      blocks.push(`### ✅ Promotion Candidates\n${promoText}`);
    }

    // Demotions
    const demoteCount = results.demoteCo.length + results.demoteElder.length;
    if (demoteCount > 0) {
      let demoteText = '';
      if (results.demoteCo.length > 0) {
        demoteText += `**Co → Elder (${results.demoteCo.length}):**\n`;
        demoteText += results.demoteCo.slice(0, 3).map(p => `• ${p.player.name}`).join('\n');
        if (results.demoteCo.length > 3) demoteText += `\n• ...and ${results.demoteCo.length - 3} more`;
      }
      if (results.demoteElder.length > 0) {
        if (demoteText) demoteText += '\n\n';
        demoteText += `**Elder → Member (${results.demoteElder.length}):**\n`;
        demoteText += results.demoteElder.slice(0, 3).map(p => `• ${p.player.name}`).join('\n');
        if (results.demoteElder.length > 3) demoteText += `\n• ...and ${results.demoteElder.length - 3} more`;
      }
      blocks.push(`### ⚠️ Demotion Candidates\n${demoteText}`);
    }

    // Kick candidates
    if (results.kick.length > 0) {
      const kickText = results.kick.slice(0, 5)
        .map((p, i) => `${i + 1}. ${p.player.name} — risk ${Math.round((p.player.risk ?? 0) * 100)}%`)
        .join('\n') + (results.kick.length > 5 ? `\n...and ${results.kick.length - 5} more` : '');

      blocks.push(`### 🪓 Kick Candidates\n${kickText}`);
    }

    if (promoteCount === 0 && demoteCount === 0 && results.kick.length === 0) {
      blocks.push('### ✅ Status\nNo action items this week. Clan performance is stable.');
    }

    // /ops no longer has a War/Players tab (War was split out into its own /war
    // command earlier this session; /ops's tabs are Overview/Donations/Actions) —
    // this pointer was stale even before that, since /ops never had a Players tab.
    blocks.push('### ℹ️ Next Steps\nRun **/ops** for the overview/donations/actions tabs, or **/war** for live war standings and tier decisions.');

    // Same severity language as the daily report: kick candidates are the most
    // urgent signal, then demotions, then a clean all-promotions-or-quiet week.
    const weeklyAccentColor = results.kick.length > 0
      ? STATUS_COLORS.critical
      : (demoteCount > 0 ? STATUS_COLORS.warn : STATUS_COLORS.healthy);

    const container = buildDashboardContainer({
      accentColor: weeklyAccentColor,
      thumbnailUrl: CLAN_BADGE_URL,
      header: `## 📊 Weekly Clan Summary — ${clan?.name ?? 'Clan'}\nWeek ending: **${todayKeyISO()}** · Tag: **#${CLAN_TAG}**\nAutomated 14-day analysis with promotion/demotion recommendations.`,
      blocks,
    });

    await resolved.channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
    console.log('[SCHEDULE] Weekly report sent successfully');
  } catch (error) {
    console.error('[SCHEDULE] Error sending weekly report:', error.message);
  }

  // Public member-facing summary — separate try/catch so a failure here (e.g.
  // memberChatChannelId misconfigured) can't take down the leader report above,
  // and vice versa. Reuses the same fetch/snapshot/filter so both posts describe
  // the exact same data, not two slightly different API reads moments apart.
  if (sharedData) {
    await sendMemberWeeklySummary(client, sharedData.clan, sharedData.history, sharedData.members, sharedData.weeklyEdpd);
  }
}

/**
 * Check if it's time to send daily report (at 20:00 UTC daily)
 */
function shouldSendDailyReport(lastDaily) {
  const now = new Date();
  const lastDate = lastDaily ? new Date(lastDaily) : null;
  
  // Send at 20:00 UTC (8 PM)
  const targetHour = 20;
  
  if (!lastDate || lastDate.toDateString() !== now.toDateString()) {
    if (now.getUTCHours() === targetHour) {
      return true;
    }
  }
  
  return false;
}

/**
 * Returns the war day the weekly report is due for, or null if none is due yet.
 * Tied to the war cycle rather than a fixed calendar day: fires once, right after
 * the evaluator's post-war role review has run (eval.lastReviewedWarDay, stamped
 * by recruit/evaluator.js once per completed war week) and stats are updated
 * clan-wide — not on a fixed "Sunday 20:00 UTC" that could land mid-war or hours
 * before/after the week actually closed, depending on the clan's real war schedule.
 *
 * Returns the war day itself (not a boolean) so the caller can persist the exact
 * value the decision was based on, instead of re-reading eval.lastReviewedWarDay
 * from the DB after the async report send completes — evaluator.js runs its own
 * independent poll and could advance that setting mid-send, which would silently
 * mis-stamp (and skip) a report if the value were re-read afterward.
 */
function getDueWeeklyReportWarDay(db, lastSentWarDay) {
  const lastReviewedWarDay = String(getRecruitSetting(db, 'eval.lastReviewedWarDay') ?? '');
  if (!lastReviewedWarDay) return null;
  if (lastReviewedWarDay === String(lastSentWarDay ?? '')) return null;
  return lastReviewedWarDay;
}

// Returns the YYYY-MM month string to stamp if a reminder is due, or null.
// Purely calendar-based — doesn't need DB/history, unlike the report-due checks
// above which key off tracked state. isFirstMondayOfMonth is imported from
// season-rollover.js (not reimplemented here) so the reminder day and the
// actual roll-eligibility guard below can never independently drift apart —
// they used to be two separate hand-written implementations of the same rule.
function getDueSeasonReminderMonth(lastReminderMonth) {
  const now = new Date();
  if (!isFirstMondayOfMonth(now)) return null;
  const thisMonth = now.toISOString().slice(0, 7);
  if (thisMonth === String(lastReminderMonth ?? '')) return null;
  return thisMonth;
}

// Returns true if the caller should mark this month's reminder as handled
// (sent successfully, OR intentionally skipped because the season was already
// rolled this month), false if it should retry on the next tick (a transient
// failure — nothing was actually delivered, so the month must not be marked
// done or the reminder silently never fires again this month).
async function sendSeasonRolloverReminder(client) {
  try {
    const history = loadHistory();
    // Reuses the real roll-eligibility guard instead of a separate day-count
    // heuristic — if it says the season was already rolled this month, there's
    // nothing to remind about; this can never disagree with checkCanRollSeason
    // itself since it IS checkCanRollSeason.
    if (!checkCanRollSeason(history).ok) {
      console.log('[SCHEDULE] Season reminder skipped: season already rolled this month.');
      return true;
    }

    const resolved = await resolveReportsChannel(client);
    if (!resolved.channel) {
      warnReportsOnce(`[SCHEDULE] Season reminder skipped: ${resolved.reason}`);
      return false;
    }

    const container = buildDashboardContainer({
      accentColor: STATUS_COLORS.neutral,
      thumbnailUrl: CLAN_BADGE_URL,
      header: '## 📅 Season Check-In\nToday is the first Monday of the month — Clash Royale seasons typically roll over around now.',
      blocks: [
        '### ➡️ Next Steps\n1. Run `/recruit-season-report` to check the outgoing season\'s standings (posts to this channel each time, but doesn\'t change any data).\n2. When ready, run `/recruit-season-reset` (there\'s a confirm step) to post the final report and start the new season.',
        `${SEASON_ROLLOVER_SCOPE_NOTE} This is a reminder only, not a detection — KRAKEN has no way to confirm the real Clash Royale season calendar. No action was taken automatically.`,
      ],
    });

    await resolved.channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
    console.log('[SCHEDULE] Season rollover reminder sent successfully');

    // Also DM the server owner directly — they're the only one who can run
    // /recruit-season-reset, and a channel post is easy to miss. Best-effort: a
    // closed-DM owner or a fetch failure must never fail the reminder itself
    // (the channel post above is the primary delivery and already succeeded).
    try {
      const guild = resolved.channel.guild;
      const owner = await guild.fetchOwner();
      await owner.user.send({
        content: [
          `📅 **KRAKEN Season Check-In — ${guild.name}**`,
          '',
          "It's the first Monday of the month, so the Clash Royale season has likely rolled over.",
          'When you\'re ready, run `/recruit-season-reset` in your server to post the final season report and start the new season (there\'s a confirm step).',
          'Run `/recruit-season-report` first if you want to preview the standings.',
          '',
          '_Reminder only — KRAKEN takes no action automatically._',
        ].join('\n'),
      });
      console.log('[SCHEDULE] Season rollover reminder DM sent to owner');
    } catch (dmErr) {
      console.log('[SCHEDULE] Could not DM the owner the season reminder (DMs closed or fetch failed):', dmErr?.message ?? dmErr);
    }

    return true;
  } catch (error) {
    console.error('[SCHEDULE] Error sending season rollover reminder:', error.message);
    return false;
  }
}

// Persisted (not just in-memory) so a crash/restart mid-hour can't re-send a report
// that already went out before the process died — see schedule.lastDailyReport /
// schedule.lastWeeklyReportWarDay in recruit_settings, loaded once at startup below.
let lastDailyReport = null;
let lastWeeklyReportWarDay = null;
let lastBackup = null;
let lastSeasonReminderMonth = null;

export function startScheduler(client, recruitConfig = null) {
  try {
    const db = initDb();
    const storedDaily = getRecruitSetting(db, 'schedule.lastDailyReport');
    const storedWeeklyWarDay = getRecruitSetting(db, 'schedule.lastWeeklyReportWarDay');
    const storedBackup = getRecruitSetting(db, 'schedule.lastBackup');
    const storedSeasonReminderMonth = getRecruitSetting(db, 'schedule.lastSeasonReminderMonth');
    if (storedSeasonReminderMonth) lastSeasonReminderMonth = String(storedSeasonReminderMonth);
    if (storedDaily) lastDailyReport = new Date(Number(storedDaily));
    if (storedWeeklyWarDay) {
      lastWeeklyReportWarDay = String(storedWeeklyWarDay);
    } else {
      // First boot after the war-day-keyed weekly report gate replaced the old
      // fixed-calendar-day check: eval.lastReviewedWarDay may already be non-empty
      // from before this upgrade, which would otherwise read as "a fully new,
      // never-reported war week" and fire an immediate out-of-cycle report on the
      // very next hourly tick. Seed the new key to the CURRENTLY reviewed war day
      // instead, so only a genuinely new transition after this point sends.
      const currentReviewedWarDay = String(getRecruitSetting(db, 'eval.lastReviewedWarDay') ?? '');
      if (currentReviewedWarDay) {
        lastWeeklyReportWarDay = currentReviewedWarDay;
        setRecruitSetting(db, 'schedule.lastWeeklyReportWarDay', lastWeeklyReportWarDay);
      }
    }
    if (storedBackup) lastBackup = new Date(Number(storedBackup));
  } catch (e) {
    console.error('[SCHEDULE] Failed to load persisted report timestamps:', e?.message ?? String(e));
  }

  // Preflight permission check at startup (helps operators fix "Missing Permissions" quickly).
  (async () => {
    try {
      const resolved = await resolveReportsChannel(client);
      if (!resolved.channel) {
        warnReportsOnce(`[SCHEDULE] Reports disabled: ${resolved.reason}`);
      }
    } catch (e) {
      console.error('[SCHEDULE] Reports preflight failed:', e?.message ?? String(e));
    }
  })();

  // Heartbeat every minute
  setInterval(() => {
    console.log('[SCHEDULE] Kraken heartbeat OK');
  }, 60_000);

  // Check for report triggers every hour
  setInterval(async () => {
    // One handle reused for every check below instead of a fresh initDb() per
    // branch — initDb() isn't a cached singleton (it opens a new connection and
    // re-runs the full schema DDL every call), so opening it unconditionally per
    // check adds real wasted work on every tick, most of which fire nothing.
    const _schedDb = initDb();
    try {
      if (shouldSendDailyReport(lastDailyReport)) {
        await sendDailyReport(client);
        lastDailyReport = new Date();
        setRecruitSetting(_schedDb, 'schedule.lastDailyReport', lastDailyReport.getTime());
      }

      const dueWarDay = getDueWeeklyReportWarDay(_schedDb, lastWeeklyReportWarDay);
      if (dueWarDay) {
        await sendWeeklyReport(client);
        lastWeeklyReportWarDay = dueWarDay;
        setRecruitSetting(_schedDb, 'schedule.lastWeeklyReportWarDay', lastWeeklyReportWarDay);
      }

      if (shouldRunBackup(lastBackup)) {
        await runDatabaseBackup(client);
        lastBackup = new Date();
        setRecruitSetting(_schedDb, 'schedule.lastBackup', lastBackup.getTime());
      }

      const dueSeasonReminderMonth = getDueSeasonReminderMonth(lastSeasonReminderMonth);
      if (dueSeasonReminderMonth) {
        // Only mark the month done when the reminder actually went out (or was
        // intentionally skipped because the season was already rolled) — a
        // transient failure (channel resolution, a thrown send error) must NOT
        // be marked done, or a single bad tick silently suppresses the reminder
        // for the rest of the month with nothing left to retry it.
        const handled = await sendSeasonRolloverReminder(client);
        if (handled) {
          lastSeasonReminderMonth = dueSeasonReminderMonth;
          setRecruitSetting(_schedDb, 'schedule.lastSeasonReminderMonth', lastSeasonReminderMonth);
        }
      }
    } catch (error) {
      console.error('[SCHEDULE] Error in report scheduler:', error.message);
    }

    // Waitlist checks — expire non-responders, send 7-day pings
    if (recruitConfig?.enabled) {
      try {
        await processWaitlistChecks(client, _schedDb, String(recruitConfig.recruitGuildId ?? ''));
      } catch (wlError) {
        console.error('[SCHEDULE] Waitlist checks failed:', wlError.message);
      }
    }
  }, 60 * 60 * 1000); // Check hourly

  console.log('[SCHEDULE] Daily and weekly reports, daily backups, and season rollover reminders, configured');
}
