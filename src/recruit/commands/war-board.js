import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getClan, getCurrentRiverRace, getRiverRaceLog } from '../../cr-api.js';
import { buildMemberIntel, filterToCurrentClan } from '../../war-intel.js';
import { upsertTodaySnapshot } from '../../history.js';
import { computeHistoryWeightedRisk } from '../../risk-score.js';
import { cleanTag, normalizePlayerTag } from '../../util.js';
import { renderSpotlight, buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../../dashboard-components.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import {
  getWarDayDecision,
  isWarActivityPresent,
  parseWarAnchorMsFromEnv,
  warDayFromPeriodType,
  isHistoricalWarDay,
} from '../../war-cycle.js';
import { getActiveBreak, getExpectedDecksPerDay } from '../db.js';
import {
  evaluateWarTierPolicy,
  latestKnownName,
  summarizeWindow,
  tierFromProfileStatus,
} from '../policy.js';

// EXPECTED_DECKS_PER_DAY is read from DB at runtime inside handleWarBoard.

// Section colours by overall severity (most severe wins).
const COLOR_CRITICAL = STATUS_COLORS.critical; // boot review present
const COLOR_WARN = STATUS_COLORS.warn;         // underwatch / watch / integrity blockers
const COLOR_HEALTHY = STATUS_COLORS.healthy;   // all clear

function roleTier(member, runtimeRoles) {
  const roles = member?.roles?.cache;
  if (!roles) return 'unlinked';

  const warcore = String(runtimeRoles?.warcoreRoleId ?? '');
  const underwatch = String(runtimeRoles?.underwatchRoleId ?? '');
  const probation = String(runtimeRoles?.probationRoleId ?? '');
  const onBreak = String(runtimeRoles?.onBreakRoleId ?? '');

  if (onBreak && roles.has(onBreak)) return 'on-break';
  if (probation && roles.has(probation)) return 'probation';
  if (underwatch && roles.has(underwatch)) return 'underwatch';
  if (warcore && roles.has(warcore)) return 'warcore';
  return 'member';
}

function labelName(row) {
  return String(row?.name ?? '').trim() || `#${row?.tag ?? 'UNKNOWN'}`;
}

function recommendationLabel(row) {
  if (row.onBreak) return 'Hold — on break';
  if (row.inGrace) return 'Hold — grace period';
  if (row.policy?.remove) return 'Boot review role next';
  if (row.opsWeakOverride) return 'Demote to probation (OPS risk)';
  if (row.policy?.desiredTier === 'underwatch' && row.currentTier !== 'underwatch') return 'Move to underwatch';
  if (row.policy?.desiredTier === 'probation' && row.currentTier === 'warcore') return 'Watch closely';
  if (row.policy?.desiredTier === 'warcore') return row.currentTier === 'warcore' ? 'Keep warcore' : 'Ready for warcore';
  if (row.currentTier === 'underwatch' && row.policy?.desiredTier === 'underwatch') return 'Underwatch continues';
  return 'Keep probation tracking';
}

// Terse, board-friendly reason. Full sentences live in policy.explainPolicyReason for DMs/logs.
const REASON_SHORT = {
  TRACKING_WEEK_INCOMPLETE: 'war week not complete yet',
  PERFECT_2W_32_32: 'perfect 2-war window',
  WARCORE_LARGE_2W_INCONSISTENCY: 'large 2-war inconsistency',
  PROBATION_FAILED_2W_REVIEW: 'failed probation review',
  PROBATION_TRACKING_CONTINUES: 'tracking continues',
  WARCORE_LENIENCY_HOLD: 'leniency applied — clean',
  UNDERWATCH_RECOVERY: 'recovered — back to probation',
  UNDERWATCH_CONTINUES: 'needs clean 2-war recovery',
  TWO_WAR_INACTIVE: 'inactive a full war week',
};

function shortReason(row) {
  if (row.onBreak) return 'on an active break';
  if (row.inGrace) return 'inside grace period';
  if (row.opsWeakOverride) return 'OPS risk flags trip a demotion';
  const code = Array.isArray(row.policy?.reasons) && row.policy.reasons.length ? row.policy.reasons[0] : null;
  return REASON_SHORT[code] ?? '';
}

// True when a member missed EVERY war day KRAKEN has tracked for them this
// window — a materially different, more severe signal than a partial miss (e.g.
// 2/4), but "4/4 war days missed" sitting next to a partial "2/4" in the same list
// doesn't make that jump in severity obvious at a glance. Shared by the per-row
// bit below and buildSectionBlock's section-level callout so both call it out the
// same way instead of drifting.
function isFullyMissed(row) {
  const s = row.sum14 ?? row.sum7 ?? {};
  const warDays = Number(s.warDays ?? 0);
  const missed = Number(s.missedWarDays ?? 0);
  return warDays > 0 && missed === warDays;
}

function memberStatBits(row) {
  const s = row.sum14 ?? row.sum7 ?? {};
  const used = Number(s.usedDecks ?? 0);
  const exp = Number(s.expectedDecks ?? 0);
  const missed = Number(s.missedWarDays ?? 0);
  const warDays = Number(s.warDays ?? 0);
  const bits = [];
  if (exp > 0) bits.push(`${used}/${exp} decks`);
  else bits.push('no war data yet');
  // Spelled out as "war days missed" (with the denominator) rather than a bare
  // "N missed" — that read as ambiguous next to the decks count right before it,
  // easy to misread as N missed BATTLES rather than N whole war days with zero
  // decks played (confirmed live: this was the exact question asked about the
  // board's underwatch/boot-review sections). A complete miss (N/N) is called out
  // with its own distinct wording+icon rather than reading as just a bigger
  // version of a partial miss like 2/4 — it means zero activity across this
  // member's ENTIRE tracked window, not "mostly inactive."
  if (missed > 0) {
    bits.push(isFullyMissed(row)
      ? `⛔ missed ALL ${warDays} tracked war day${warDays === 1 ? '' : 's'}`
      : `${missed}/${warDays} war days missed`);
  }
  if (Number(s.yetToPlayWarDays ?? 0) > 0) bits.push('yet to play today');
  if (s.hasForbidden) bits.push(`⚠ forbidden (boat ${Number(s.boatTotal ?? 0)} / repair ${Number(s.repairTotal ?? 0)})`);
  if (!row.profileLinked) bits.push('discord not linked');
  return bits;
}

function formatMemberRow(row) {
  const name = labelName(row);
  const action = recommendationLabel(row);
  const bits = memberStatBits(row);
  const reason = shortReason(row);
  if (reason) bits.push(reason);
  // One bit per line (not all joined with " · " into a single long line) — a row
  // with 3-4 bits (decks, missed days, link status, reason) read as a cramped run-on
  // sentence; each fact gets its own bullet instead. Same "• " marker status.js's
  // lifecycle section already uses, for one consistent list style across the bot.
  const sub = bits.length ? `\n${bits.map(b => `   • ${b}`).join('\n')}` : '';
  return `**${name}** · ${action}${sub}`;
}

// PAGE_SIZE items per section per page. Every section pages together on the same
// page number (like /ops's single per-tab page) — sections stay grouped, but
// nothing is permanently stuck behind a "+N more" that used to have no way to
// actually reach the rest.
// Sized so a full page of WORST-CASE rows (~190 chars: long name + OPS-override
// action + full bit stack incl. forbidden warning) still fits the 1000-char field
// clamp below. At 8/page the clamp could shrink a page to 5 shown while the next
// page still started at the fixed +8 offset — silently stranding rows 6-8 of every
// page with no way to ever reach them.
const PAGE_SIZE = 5;

function buildSectionBlock(title, rows, page, { alwaysShow = false, emptyText = 'None this cycle' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return alwaysShow ? `### ${title}\n${emptyText}` : null;
  }

  const start = page * PAGE_SIZE;
  let shown = list.slice(start, start + PAGE_SIZE);
  // Blank line between each member's entry (not just a single \n) — with the
  // 2-line name+substat format, back-to-back rows with no gap read as one dense
  // wall of text instead of a scannable list.
  let lines = shown.map(formatMemberRow).join('\n\n');
  while (lines.length > 1000 && shown.length > 1) {
    shown = shown.slice(0, -1);
    lines = shown.map(formatMemberRow).join('\n\n');
  }

  const rangeLabel = list.length > PAGE_SIZE ? `${list.length}, showing ${start + 1}-${start + shown.length}` : `${list.length}`;
  // Section-level rollup — counted against the FULL list (not just this page), so
  // it stays accurate across pagination. Called out separately from the per-row
  // ⛔ tag above: a leader who only skims section headers still sees "most of
  // this list is completely inactive" without opening every row.
  const fullyMissedCount = list.filter(isFullyMissed).length;
  const calloutLine = fullyMissedCount > 0
    ? `⛔ **${fullyMissedCount} of ${list.length}** missed every war day tracked this window`
    : null;
  return [`### ${title} (${rangeLabel})`, calloutLine, lines || emptyText].filter(Boolean).join('\n\n');
}

function buildAuditBlock(title, items, page, formatter = (value) => String(value)) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return null;

  const start = page * PAGE_SIZE;
  const shown = rows.slice(start, start + PAGE_SIZE).map(formatter);
  const rangeLabel = rows.length > PAGE_SIZE ? `${rows.length}, showing ${start + 1}-${start + shown.length}` : `${rows.length}`;
  return `### ${title} (${rangeLabel})\n\n${shown.join('\n').slice(0, 1000)}`;
}

function pageCountFor(...lists) {
  const maxLen = lists.reduce((m, l) => Math.max(m, Array.isArray(l) ? l.length : 0), 0);
  return Math.max(1, Math.ceil(maxLen / PAGE_SIZE));
}

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function decodeOwnerIdToken(token) {
  const s = String(token ?? '').trim();
  return isValidDiscordId(s) ? s : null;
}

export function parseWarBoardAction(customId) {
  const parts = String(customId ?? '').split(':');
  if (parts[0] !== 'warboard' || parts[1] !== 'page') return null;
  const dir = parts[2] === 'prev' ? 'prev' : 'next';
  const currentPage = Number(parts[3]);
  return {
    page: dir === 'prev' ? (Number.isFinite(currentPage) ? currentPage - 1 : 0) : (Number.isFinite(currentPage) ? currentPage + 1 : 0),
    ownerId: decodeOwnerIdToken(parts[4]),
  };
}

function warBoardPagingRow(page, totalPages, ownerId) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`warboard:page:prev:${page}:${ownerId}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`warboard:page:info:${page}:${ownerId}`)
      .setLabel(`Page ${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`warboard:page:next:${page}:${ownerId}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1),
  );
  return row;
}

export const command = {
  name: 'war-board',
  description: 'Leader war decision board with clear recommendations and context',
};

export async function handleWarBoard(interaction, ctx, options = {}) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime;
  const EXPECTED_DECKS_PER_DAY = getExpectedDecksPerDay(db);
  const isComponent = interaction.isButton?.() ?? false;
  const requestedPage = Math.max(0, Number(options?.page ?? 0) || 0);
  const ownerId = String(options?.ownerId ?? interaction.user?.id ?? '');

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  if (isComponent && interaction.user?.id && ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({
      content: 'This war-board panel belongs to someone else. Run `/war-board` to open your own.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({ content: 'Only leaders/admin can run this.', flags: MessageFlags.Ephemeral });
  }

  const opsChannelId = String(runtime?.channels?.opsChannelId ?? '');
  if (opsChannelId && interaction.channelId !== opsChannelId) {
    return interaction.reply({ content: 'Use this in the ops channel only.', flags: MessageFlags.Ephemeral });
  }

  const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
  if (!clanTag) {
    return interaction.reply({ content: 'CLAN_TAG missing in .env', flags: MessageFlags.Ephemeral });
  }

  if (isComponent) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply();
  }

  try {
    const [clan, race, raceLog] = await Promise.all([getClan(clanTag), getCurrentRiverRace(clanTag), getRiverRaceLog(clanTag)]);
    const members = buildMemberIntel({ clan, race, clanTag });
    // raceLog/clanTag let upsertTodaySnapshot run its own self-healing reconciliation
    // internally — keeps this leader-facing decision board from disagreeing with
    // /ops, /war, the scheduled reports, and the evaluator on the same member/day.
    const boardSnapshot = upsertTodaySnapshot(members, {
      periodType: race?.periodType,
      warDay: warDayFromPeriodType(race),
      periodIndex: race?.periodIndex,
      raceLog,
      clanTag,
    });
    const history = boardSnapshot.history;

    // members (above) deliberately still includes anyone who fought this race and has
    // since left the clan — buildMemberIntel keeps them so the day they actually played
    // isn't undercounted in history. That's correct for the snapshot just written above,
    // but everything display/scoring-facing below should reflect who's ACTUALLY in the
    // clan right now, not a leaver who's still trailing through the race's participant
    // list. currentMembers is the live-roster-filtered view for that.
    const currentMembers = filterToCurrentClan(members, clan);

    const warDecision = getWarDayDecision({
      race,
      snapshotWarDay: isWarActivityPresent(currentMembers),
      nowMs: Date.now(),
    });

    const anchorMs = parseWarAnchorMsFromEnv();
    const isWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, anchorMs);

    const profiles = db.prepare("SELECT discord_id, player_tag, status FROM profiles WHERE player_tag IS NOT NULL AND player_tag != '' AND status != 'removed'").all();
    const last7 = Object.keys(history?.days ?? {}).sort().slice(-7);
    const last14 = Object.keys(history?.days ?? {}).sort().slice(-14);
    const discordByTag = new Map(
      profiles
        .map(p => [normalizePlayerTag(p.player_tag), String(p.discord_id ?? '')])
        .filter(([tag]) => Boolean(tag))
    );
    const profileByTag = new Map(
      profiles
        .map(p => [normalizePlayerTag(p.player_tag), p])
        .filter(([tag]) => Boolean(tag))
    );

    const guild = interaction.guild;
    const rows = [];
    const managedRoleIds = [
      runtime?.roles?.memberRoleId,
      runtime?.roles?.newArrivalRoleId,
      runtime?.roles?.applicantRoleId,
      runtime?.roles?.approvedRoleId,
      runtime?.roles?.probationRoleId,
      runtime?.roles?.underwatchRoleId,
      runtime?.roles?.warcoreRoleId,
      runtime?.roles?.onBreakRoleId,
    ].filter(Boolean).map(String);

    // Bulk-fetch the full member list before reading the cache. Without this, guild.members.cache
    // only reflects whoever the bot has happened to see via gateway events since it last connected
    // — reliably incomplete right after a restart. Two things below depend on it being complete:
    // per-member currentTier below (a cache miss silently falls back to the DB-stored status,
    // defeating the point of cross-checking live Discord roles against it), and serverWithoutProfile
    // further down (which needs the FULL member list to find "who's here but untracked" — a
    // targeted per-tag fetch wouldn't help there since it only knows about already-linked tags).
    if (guild) {
      await guild.members.fetch().catch(() => {});
    }
    const guildMembersCache = guild?.members?.cache ?? new Map();

    for (const memberScore of currentMembers) {
      const tag = normalizePlayerTag(memberScore.tag);
      if (!tag) continue;
      const discordId = discordByTag.get(tag) ?? '';
      const profileLinked = Boolean(discordId);
      const discordMember = discordId ? (guildMembersCache.get(discordId) ?? null) : null;
      const profile = profileByTag.get(tag) ?? null;
      const currentTier = discordMember
        ? roleTier(discordMember, runtime?.roles)
        : tierFromProfileStatus(profile?.status);
      const discordRole = profileLinked ? currentTier : 'none';
      const onBreak = discordId ? Boolean(getActiveBreak(db, discordId)) : false;
      const sum7 = summarizeWindow(history, tag, last7, EXPECTED_DECKS_PER_DAY, isWarDayForKey);
      const sum14 = summarizeWindow(history, tag, last14, EXPECTED_DECKS_PER_DAY, isWarDayForKey);
      const policy = evaluateWarTierPolicy({ currentTier, sum7, sum14 });

      rows.push({
        tag,
        name: memberScore.name,
        clanRole: String(memberScore.role ?? 'member'),
        discordRole,
        currentTier,
        discordLinked: profileLinked,
        profileLinked,
        discordVisible: Boolean(discordMember),
        inGrace: false,
        onBreak,
        sum7,
        sum14,
        policy,
      });
    }

    // Risk scores feed two things: the OPS-score override (so the board matches the
    // evaluator's actual decision) and the grace-period flag (so new joiners are held).
    const scoreMap = new Map();
    let scoreMapFailed = false;
    try {
      // Pass GRACE_DAYS explicitly — without it risk-score falls back to its internal
      // 7-day default while /ops honors the env value, and after a season reset (which
      // restamps every member's firstSeen) the whole clan silently reads as in-grace
      // here for a week, dumping all 30+ rows into "hold" while /ops shows none.
      const graceDays = Number(process.env.GRACE_DAYS ?? 1);
      const scores = computeHistoryWeightedRisk(history, currentMembers, { expectedDecksPerDay: EXPECTED_DECKS_PER_DAY, isWarDayForKey, graceDays, warActiveToday: warDecision.shouldJudgeToday });
      for (const s of scores) {
        if (s?.tag) scoreMap.set(cleanTag(s.tag), s);
      }
    } catch (e) {
      // Risk scoring failure doesn't break the board — rows keep their defaults (inGrace:
      // false, no OPS override). That default is silently optimistic: a genuinely new joiner
      // would show as fully evaluable instead of held in grace. Surfaced below so leaders
      // know results this run may be inaccurate rather than trusting them blind.
      scoreMapFailed = true;
      console.error('[WAR-BOARD] risk scoring failed, grace/OPS-override data unavailable this run:', e?.message ?? e);
    }
    for (const row of rows) {
      const score = scoreMap.get(row.tag) ?? null;
      if (score) row.inGrace = Boolean(score.inGrace);
      const inOpsWeakRange = score && !score.inGrace && (
        Number(score.risk ?? 0) >= 0.55 ||
        Number(score.warParticipationRate ?? 0) <= 60 ||
        Number(score.daysInactive ?? 0) >= 7 ||
        Boolean(score.repeatOffender)
      );
      row.opsWeakOverride = Boolean(
        row.currentTier === 'warcore' &&
        !row.policy?.hold &&
        !row.policy?.remove &&
        inOpsWeakRange &&
        row.policy?.desiredTier === 'warcore'
      );
    }

    const basePool = rows.filter(r => !r.inGrace && !r.onBreak);
    const hold = rows.filter(r => r.inGrace || r.onBreak);

    // Boot review is a distinct severity from underwatch — leaders must see it separately.
    const bootReview = basePool
      .filter(r => r.policy?.remove)
      .sort((a, b) => Number(a.sum14?.usedDecks ?? 0) - Number(b.sum14?.usedDecks ?? 0));
    const moveUnderwatch = basePool
      .filter(r => !r.policy?.remove && r.policy?.desiredTier === 'underwatch')
      .sort((a, b) => Number(a.sum14?.usedDecks ?? 0) - Number(b.sum14?.usedDecks ?? 0));
    const keepStable = basePool
      // desiredTier !== 'underwatch' excludes anyone moveUnderwatch above already claims —
      // without it, a currently-warcore member whose policy now recommends underwatch
      // satisfied both filters and appeared under contradictory sections on the same render.
      .filter(r => !r.policy?.remove && !r.opsWeakOverride && r.policy?.desiredTier !== 'underwatch' && (r.policy?.desiredTier === 'warcore' || r.currentTier === 'warcore'))
      .sort((a, b) => Number(b.sum14?.usedDecks ?? 0) - Number(a.sum14?.usedDecks ?? 0));
    const watchClosely = basePool
      .filter(r => !bootReview.includes(r) && !moveUnderwatch.includes(r) && !keepStable.includes(r) && (r.currentTier === 'warcore' || r.policy?.desiredTier === 'probation' || r.opsWeakOverride))
      .sort((a, b) => Number(a.sum14?.usedDecks ?? 0) - Number(b.sum14?.usedDecks ?? 0));

    // Coverage + integrity figures.
    const linkedCount = rows.filter(r => r.discordLinked).length;
    const clanOnlyCount = rows.length - linkedCount;
    const onBreakCount = rows.filter(r => r.onBreak).length;
    const graceCount = rows.filter(r => r.inGrace).length;
    const serverCount = Number(guild?.memberCount ?? 0);
    const profileTags = new Set(profiles.map(p => normalizePlayerTag(p.player_tag)).filter(Boolean));
    const clanTags = new Set(rows.map(r => r.tag).filter(Boolean));
    const invalidStoredProfiles = profiles.filter(p => !normalizePlayerTag(p.player_tag));
    const trackedNotInClanTags = [...profileTags].filter(t => !clanTags.has(t));
    const trackedNotInClan = trackedNotInClanTags.length;
    const unlinkedClanRows = rows.filter(r => !r.discordLinked);
    const profileByDiscordId = new Map(profiles.map(p => [String(p.discord_id ?? ''), normalizePlayerTag(p.player_tag)]));
    const serverWithoutProfile = Array.from(guildMembersCache.values())
      .filter(member => !member.user.bot)
      .filter(member => managedRoleIds.some(roleId => member.roles.cache.has(roleId)))
      .filter(member => !profileByDiscordId.get(String(member.id)))
      .map(member => member.displayName);

    const blockers = [];
    if (clanOnlyCount > 0) blockers.push(`${clanOnlyCount} need Discord linking`);
    if (trackedNotInClan > 0) blockers.push(`${trackedNotInClan} tracked profile(s) left the clan`);
    const topBlocker = blockers.length ? blockers.join(' · ') : null;

    // Overall severity colour.
    const color = scoreMapFailed
      ? COLOR_WARN
      : bootReview.length > 0
        ? COLOR_CRITICAL
        : (moveUnderwatch.length > 0 || watchClosely.length > 0 || clanOnlyCount > 0 || trackedNotInClan > 0)
          ? COLOR_WARN
          : COLOR_HEALTHY;

    const clanName = String(clan?.name ?? '').trim() || `#${clanTag}`;
    const reviewMode = warDecision.shouldJudgeToday ? '🟢 War tracking active' : '⚪ Training-day review only';
    // Only show the anchor-cycle label when the anchor actually made the call (same
    // rule as /ops). It's the last-resort fallback and its February-calibrated weekly
    // alignment drifts — displaying "war-3" next to an authoritative api-periodType
    // decision on real day 4 just reads as the board disagreeing with itself.
    const decisionSource = `${warDecision.source}${warDecision.source === 'anchor' && warDecision.anchorDecision?.cycleLabel ? ` · ${warDecision.anchorDecision.cycleLabel}` : ''}`;
    const countStrip = `✅ **${keepStable.length}** stable  ·  👀 **${watchClosely.length}** watch  ·  ⚠️ **${moveUnderwatch.length}** underwatch  ·  ⛔ **${bootReview.length}** boot  ·  ⏸️ **${hold.length}** hold`;

    const descLines = [
      `${reviewMode}  ·  ${decisionSource}`,
      countStrip,
    ];
    if (scoreMapFailed) descLines.push('⚠️ Risk scoring failed this run — grace-period holds and OPS-risk overrides below may be inaccurate. Re-run shortly.');
    if (topBlocker) descLines.push(`🚩 ${topBlocker}`);

    const coverageBlock = [
      '### 📊 Coverage',
      `Clan roster: **${currentMembers.length}** · Recruit HQ: **${serverCount}**`,
      `Linked: **${linkedCount}** · Not linked: **${clanOnlyCount}**`,
      `On break: **${onBreakCount}** · Grace: **${graceCount}**`,
    ].join('\n');

    // The direct answer to "show the best and worst performer" for the war board:
    // most reliable keeper vs. the most severe open item across boot/underwatch/watch.
    const bestPerformer = keepStable[0] ?? null;
    const worstPerformer = bootReview[0] ?? moveUnderwatch[0] ?? watchClosely[0] ?? null;
    const spotlight = renderSpotlight({
      topLabel: '🏆 Most reliable this window',
      bottomLabel: '⚠️ Needs attention most',
      top: bestPerformer ? `${labelName(bestPerformer)} · ${memberStatBits(bestPerformer).join(' · ')}` : null,
      bottom: worstPerformer ? `${labelName(worstPerformer)} · ${recommendationLabel(worstPerformer)}` : null,
    });

    // All sections page together on one shared page number, sized to whichever
    // list is longest, so every row across every section is reachable via Prev/Next.
    const totalPages = pageCountFor(keepStable, watchClosely, moveUnderwatch, bootReview, hold, unlinkedClanRows, trackedNotInClanTags);
    const page = Math.min(requestedPage, totalPages - 1);

    // Decision buckets — the four key tiers always render so the board reads consistently.
    const decisionBlocks = [
      buildSectionBlock('✅ Safe / Keep Stable', keepStable, page, { alwaysShow: true }),
      buildSectionBlock('👀 Needs Watching', watchClosely, page, { alwaysShow: true }),
      buildSectionBlock('⚠️ Underwatch Path', moveUnderwatch, page, { alwaysShow: true }),
      buildSectionBlock('⛔ Boot Review — Remove Role', bootReview, page, { alwaysShow: true }),
      buildSectionBlock('⏸️ On Hold (break / grace)', hold, page, { alwaysShow: false }),
    ];

    // Integrity audits — only surface when there is something to act on.
    const integrityLines = [];
    if (serverWithoutProfile.length) {
      const sample = serverWithoutProfile.slice(0, 6).map(n => `**${n}**`).join(', ');
      integrityLines.push(`Server members without a profile (${serverWithoutProfile.length}): ${sample}${serverWithoutProfile.length > 6 ? ', …' : ''}`);
    }
    if (invalidStoredProfiles.length) {
      const sample = invalidStoredProfiles.slice(0, 6).map(p => String(p.player_tag ?? '').trim() || '(empty)').join(', ');
      integrityLines.push(`Invalid stored tags (${invalidStoredProfiles.length}): ${sample}${invalidStoredProfiles.length > 6 ? ', …' : ''}`);
    }
    const integrityBlock = integrityLines.length
      ? `### 🧹 Integrity Checks\n\n${integrityLines.join('\n').slice(0, 1000)}`
      : null;

    const auditBlocks = [
      buildAuditBlock('🔗 Not Linked Yet', unlinkedClanRows, page, (row, idx) => `${idx + 1}. **${labelName(row)}**`),
      buildAuditBlock('📤 Tracked But Not In Clan', trackedNotInClanTags, page, (tag, idx) => `${idx + 1}. **${latestKnownName(history, tag) || `#${tag}`}**`),
      integrityBlock,
    ];

    const footerLine = `Completed-war windows · 14-day view · ${EXPECTED_DECKS_PER_DAY} decks/day · ${guildMembersCache.size} HQ members cached · page ${page + 1}/${totalPages}`;

    const container = buildDashboardContainer({
      accentColor: color,
      thumbnailUrl: CLAN_BADGE_URL,
      header: [
        `## 🐙 War Board — ${clanName}`,
        descLines.join('\n'),
      ].join('\n'),
      blocks: [
        spotlight,
        coverageBlock,
        ...decisionBlocks,
        ...auditBlocks,
        footerLine,
      ],
    });

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container, warBoardPagingRow(page, totalPages, ownerId)],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    console.error('[WAR-BOARD] handler error:', e);
    await interaction.editReply({ content: 'War board failed to load. Check logs.' });
  }
}
