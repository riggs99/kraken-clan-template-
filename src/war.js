import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { extractRaceMeta } from './war-intel.js';
import { getWarDayDecision, isWarActivityPresent } from './war-cycle.js';
import { categorizeTierDecisions, explainPolicyReason } from './recruit/policy.js';
import { renderTable, renderSpotlight, buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from './dashboard-components.js';
import { cleanTag, daysSinceLastSeen, formatDaysAgo } from './util.js';
import { formatErrorForLog } from './security.js';
import {
  loadOpsData,
  pageSlice,
  displayNameWithRoles,
  buildRoleContext,
  formatList,
  getExpectedDecksPerDay,
  isWarActiveToday,
  toWindowDays,
  toPage,
  decodeOwnerIdToken,
  PAGE_SIZE,
  WINDOW_OPTIONS,
} from './ops.js';

export const command = {
  name: 'war',
  description: 'War performance, live leaders, and tier decisions — the standalone war hub',
};

// Mirrors ops.js's OPS_PANEL_BY_USER — without this, running /war repeatedly (the
// normal way a leader checks in on a war day) posts a brand-new dashboard message
// every time instead of updating the same one in place.
const WAR_PANEL_BY_USER = new Map();

export function parseWarAction(customId) {
  const parts = String(customId ?? '').split(':');
  if (parts[0] !== 'war') return null;

  if (parts[1] === 'refresh') {
    return { windowDays: toWindowDays(parts[2]), page: toPage(parts[3]), ownerId: decodeOwnerIdToken(parts[4]) };
  }
  if (parts[1] === 'win') {
    return { windowDays: toWindowDays(parts[2]), page: 0, ownerId: decodeOwnerIdToken(parts[3]) };
  }
  if (parts[1] === 'page') {
    const dir = parts[2] === 'prev' ? 'prev' : 'next';
    const currentPage = toPage(parts[4]);
    return {
      windowDays: toWindowDays(parts[3]),
      page: dir === 'prev' ? currentPage - 1 : currentPage + 1,
      ownerId: decodeOwnerIdToken(parts[5]),
    };
  }
  return { windowDays: 7, page: 0, ownerId: null };
}

function warTopRow(state) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`war:refresh:${state.windowDays}:${state.page}:${state.ownerId}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
  );
  for (const w of WINDOW_OPTIONS) {
    const label = w === 1 ? 'TODAY' : `${w}D`;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`war:win:${w}:${state.ownerId}`)
        .setLabel(label)
        .setStyle(w === state.windowDays ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  return row;
}

function warPagingRow(state, paging) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`war:page:prev:${state.windowDays}:${state.page}:${state.ownerId}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!paging.canPrev),
    new ButtonBuilder()
      .setCustomId(`war:page:info:${state.windowDays}:${state.page}:${state.ownerId}`)
      .setLabel(`Page ${paging.page + 1}/${paging.totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`war:page:next:${state.windowDays}:${state.page}:${state.ownerId}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!paging.canNext),
  );
  return row;
}

// Same numbered-line density as the rest of this view (Missing War Today, Boat
// Actions) — capped at 5 with a pointer to /war-board rather than a second
// incomplete copy of its fully-paginated decision board.
function bucketLines(rows) {
  return rows.slice(0, 5).map((r, i) => {
    const tag = cleanTag(r.tag);
    const deckBits = Number(r.sum14?.expectedDecks ?? 0) > 0
      ? `${Number(r.sum14?.usedDecks ?? 0)}/${Number(r.sum14?.expectedDecks ?? 0)} decks`
      : 'no war data yet';
    const reason = Array.isArray(r.policy?.reasons) && r.policy.reasons.length
      ? explainPolicyReason(r.policy.reasons[0])
      : '';
    return `${i + 1}) **${r.name ?? `#${tag}`}** | 🃏${deckBits}${reason ? ` | ${reason}` : ''}`;
  });
}

function bucketBlock(title, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = bucketLines(list);
  const more = list.length > lines.length ? `\n+${list.length - lines.length} more — full list in \`/war-board\`` : '';
  return `### ${title} (${list.length})\n${formatList(lines, 'None right now.')}${more}`;
}

// Computes the tier-decision buckets once and returns both the rendered blocks and
// the severity color derived from them (most severe wins — same rule as war-board.js's
// section color), so buildWarPayload doesn't need a second categorizeTierDecisions
// pass over the same data just to pick an accent color.
function buildDecisionBlocks(data) {
  const { ranked, watchClosely, moveUnderwatch, bootReview, warcoreReady } = categorizeTierDecisions(data.policyRows, {
    scoredByTag: data.scoredByTag,
    onBreakTags: data.onBreakTags,
  });

  const summaryBlock = [
    '### 📋 Tier Decisions',
    `Ready for or keep warcore: **${warcoreReady.length}** · Watch closely: **${watchClosely.length}** · Move to underwatch: **${moveUnderwatch.length}** · Boot-review: **${bootReview.length}**`,
    `Linked clan members: **${ranked.length}** · Full decision board (every tier, fully paged): \`/war-board\``,
  ].join('\n');

  const severityColor = bootReview.length > 0
    ? STATUS_COLORS.critical
    : (moveUnderwatch.length > 0 || watchClosely.length > 0)
      ? STATUS_COLORS.warn
      : STATUS_COLORS.healthy;

  return {
    blocks: [
      summaryBlock,
      bucketBlock('⛔ Boot Review', bootReview),
      bucketBlock('⚠️ Underwatch Path', moveUnderwatch),
      bucketBlock('👀 Needs Watching', watchClosely),
    ],
    severityColor,
  };
}

function buildWarView(data, page, roleCtx, windowDays = 7) {
  const meta = extractRaceMeta(data.race);
  const cycleDecision = getWarDayDecision({
    race: data.race,
    snapshotWarDay: isWarActivityPresent(data.members),
    nowMs: Date.now(),
  });
  const derivedPhase = (cycleDecision.source === 'anchor' && cycleDecision.anchorDecision?.cycleLabel)
    ? cycleDecision.anchorDecision.cycleLabel
    : (cycleDecision.shouldJudgeToday ? 'war-active' : 'training/non-war');

  const edpd = getExpectedDecksPerDay();
  const policyByTag = new Map((data.policyRows ?? []).map(r => [cleanTag(r.tag), r]));
  const scoredByTag = new Map(data.scored.map(s => [cleanTag(s.tag), s]));
  const merged = data.members.map(m => ({ ...m, ...(scoredByTag.get(cleanTag(m.tag)) ?? {}) }));
  const activeNow = merged.filter(isWarActiveToday).length;
  const missingNow = cycleDecision.shouldJudgeToday ? merged.filter(m => !isWarActiveToday(m)).length : 0;

  const rankedToday = merged
    .slice()
    .sort((a, b) => Number(b.fame ?? 0) - Number(a.fame ?? 0));

  const windowRanked = data.scored
    .filter(m => !m.inGrace)
    .slice()
    .sort((a, b) => Number(b.windowAgg?.fameDeltaSum ?? 0) - Number(a.windowAgg?.fameDeltaSum ?? 0));

  const slice = pageSlice(windowRanked, page);
  const winLabel = windowDays === 1 ? 'today' : `${windowDays}d`;
  const warTable = renderTable(
    [
      { key: 'rank', label: '#', width: 3, align: 'right' },
      { key: 'name', label: 'Name', width: 14, align: 'left' },
      { key: 'fame', label: 'Fame', width: 6, align: 'right' },
      { key: 'decks', label: 'War wk', width: 7, align: 'right' },
      { key: 'war', label: 'War%', width: 4, align: 'right' },
      { key: 'risk', label: 'Risk', width: 4, align: 'right' },
    ],
    slice.pageItems.map((m, i) => {
      const agg = m.windowAgg ?? {};
      const fame = Math.round(Number(agg.fameDeltaSum ?? 0));
      const sum7 = policyByTag.get(cleanTag(m.tag))?.sum7;
      const used = Number(sum7?.usedDecks ?? agg.decksDeltaSum ?? 0);
      const expected = Number(sum7?.expectedDecks ?? 0);
      const warPct = Number(m.warParticipationRate ?? 0);
      const risk = Math.round(Number(m.risk ?? 0) * 100);
      return {
        rank: slice.page * PAGE_SIZE + i + 1,
        name: String(m?.name ?? 'unknown'),
        fame: `+${fame}`,
        decks: expected > 0 ? `${used}/${expected}` : `${Math.round(used)}`,
        war: `${warPct}%`,
        risk: `${risk}%`,
      };
    }),
  );

  const missingLines = cycleDecision.shouldJudgeToday
    ? merged
      .filter(m => !m.inGrace && !isWarActiveToday(m))
      .slice()
      .sort((a, b) => Number(b.risk ?? 0) - Number(a.risk ?? 0))
      .slice(0, 8)
      .map((m, i) => `${i + 1}) ${displayNameWithRoles(m, roleCtx)} | 🎯${Math.round(Number(m.risk ?? 0) * 100)}% | ⚔${m.warParticipationRate ?? 0}% | ⏱${formatDaysAgo(daysSinceLastSeen(m.lastSeen))}`)
    : [];

  const todayTable = renderTable(
    [
      { key: 'rank', label: '#', width: 3, align: 'right' },
      { key: 'name', label: 'Name', width: 12, align: 'left' },
      { key: 'raceFame', label: 'Race', width: 5, align: 'right' },
      { key: 'weekDecks', label: 'Wk', width: 6, align: 'right' },
      { key: 'todayDecks', label: 'Today', width: 5, align: 'right' },
      { key: 'rep', label: 'Rep', width: 4, align: 'right' },
      { key: 'boat', label: 'Boat', width: 4, align: 'right' },
    ],
    rankedToday.slice(0, 8).map((m, i) => {
      const sum7 = policyByTag.get(cleanTag(m.tag))?.sum7;
      const expectedWk = Number(sum7?.expectedDecks ?? 0) || (edpd * 4);
      const weekUsed = Number(m.decksUsed ?? 0);
      const todayUsed = Number(m.decksUsedToday ?? 0);
      return {
        rank: i + 1,
        name: String(m?.name ?? 'unknown'),
        raceFame: Number(m.fame ?? 0),
        weekDecks: `${weekUsed}/${expectedWk}`,
        todayDecks: `${todayUsed}/${edpd}`,
        rep: Number(m.repairPoints ?? 0),
        boat: Number(m.boatAttacks ?? 0),
      };
    }),
  );

  const reliableForAvg = data.scored.filter(m => !m.inGrace && Number(m.historyDays ?? 0) >= 3);
  const windowAvgParticipation = reliableForAvg.length
    ? Math.round(reliableForAvg.reduce((sum, m) => sum + Number(m.warParticipationRate ?? 0), 0) / reliableForAvg.length)
    : 0;

  const windowAvgDeck = reliableForAvg.length
    ? Math.round(reliableForAvg.reduce((sum, m) => sum + (1 - Number(m.deckMissRate ?? 1)) * 100, 0) / reliableForAvg.length)
    : 0;

  const windowTotals = data.scored.reduce((acc, m) => {
    acc.fame += Number(m.windowAgg?.fameDeltaSum ?? 0);
    acc.decks += Number(m.windowAgg?.decksDeltaSum ?? 0);
    acc.repairs += Number(m.windowAgg?.repairsSum ?? 0);
    acc.boat += Number(m.windowAgg?.boatSum ?? 0);
    return acc;
  }, { fame: 0, decks: 0, repairs: 0, boat: 0 });

  const boatNegWindow = data.scored
    .filter(m => Number(m.windowAgg?.boatSum ?? 0) > 0)
    .slice()
    .sort((a, b) => Number(b.windowAgg?.boatSum ?? 0) - Number(a.windowAgg?.boatSum ?? 0))
    .slice(0, 10)
    .map((m, i) => {
      const boat = Math.round(Number(m.windowAgg?.boatSum ?? 0));
      const riskPct = Math.round(Number(m.risk ?? 0) * 100);
      const warPct = Number(m.warParticipationRate ?? 0);
      return `${i + 1}) ${displayNameWithRoles(m, roleCtx)} | 🚤${boat} | ⚔${warPct}% | 🎯${riskPct}%`;
    });

  const boatNegToday = merged
    .filter(m => Number(m.boatAttacks ?? 0) > 0)
    .slice()
    .sort((a, b) => Number(b.boatAttacks ?? 0) - Number(a.boatAttacks ?? 0))
    .slice(0, 10)
    .map((m, i) => `${i + 1}) ${displayNameWithRoles(m, roleCtx)} | 🚤${Number(m.boatAttacks ?? 0)} | 🏅${Number(m.fame ?? 0)} | 🃏${Number(m.decksUsedToday ?? 0)}`);

  const bestWarContributor = windowRanked[0] ?? null;
  const worstWarContributor = windowRanked.length ? windowRanked[windowRanked.length - 1] : null;
  const warSpotlight = renderSpotlight({
    topLabel: '🏆 Top war contributor',
    bottomLabel: '⚠️ Lowest war contribution',
    top: bestWarContributor ? `${String(bestWarContributor.name ?? 'unknown')} · +${Math.round(Number(bestWarContributor.windowAgg?.fameDeltaSum ?? 0))} fame · ${Number(bestWarContributor.warParticipationRate ?? 0)}% war` : null,
    bottom: worstWarContributor ? `${String(worstWarContributor.name ?? 'unknown')} · +${Math.round(Number(worstWarContributor.windowAgg?.fameDeltaSum ?? 0))} fame · ${Number(worstWarContributor.warParticipationRate ?? 0)}% war` : null,
  });

  const decisions = buildDecisionBlocks(data);

  return {
    header: [
      '## ⚔️ KRAKEN WAR',
      `**Phase:** ${derivedPhase} via **${cycleDecision.source}** · **Race state:** ${meta.state}`,
    ].join('\n'),
    blocks: [
      warSpotlight,
      [
        '### 📊 War Snapshot',
        `Section/Period: **${meta.sectionIndex ?? '-'} / ${meta.periodIndex ?? '-'}**`,
        `Active today: **${activeNow}/${data.members.length}** · Missing today: **${missingNow}**`,
        `Clan health: **${data.health.score}/100 (${data.health.grade})**`,
      ].join('\n'),
      [
        '### 📡 War Signals',
        `Window avg participation: **${windowAvgParticipation}%** · Window avg deck completion: **${windowAvgDeck}%** (expected ${getExpectedDecksPerDay()}/day)`,
        `Window totals: 🏅${Math.round(windowTotals.fame)} | 🃏${Math.round(windowTotals.decks)} | 🛠${Math.round(windowTotals.repairs)} | 🚤${Math.round(windowTotals.boat)}`,
      ].join('\n'),
      ...decisions.blocks,
      [
        `### 🏅 Top War Contribution (${winLabel} window)`,
        '_Fame = earned in window · War wk = decks used/expected across tracked war days (e.g. 12/16)_',
        warTable ?? 'No war contribution data yet.',
      ].join('\n'),
      [
        '### 🔴 Live Race (API right now)',
        '_Race = cumulative week fame · Wk = race decksUsed total · Today = battles this Supercell day only (0 = not played yet)_',
        todayTable ?? 'No live race data yet.',
      ].join('\n'),
      `### 🚤 Boat Actions\n**Window offenders:**\n${formatList(boatNegWindow, 'None')}\n\n**Today offenders:**\n${formatList(boatNegToday, 'None')}`,
      `### 🚫 Missing War Today\n${formatList(missingLines, cycleDecision.shouldJudgeToday ? 'No one is missing war today.' : 'Not a war day — nothing to report.')}`,
    ],
    page: slice.page,
    totalPages: slice.totalPages,
    severityColor: decisions.severityColor,
  };
}

function buildWarPayload({ state, data, view }) {
  const winLabel = state.windowDays === 1 ? 'Today' : `${state.windowDays} days`;
  const metaLine = `**Window:** ${winLabel} · **Page:** ${view.page + 1}/${view.totalPages} · **Updated:** ${data.day}`;
  const container = buildDashboardContainer({
    accentColor: view.severityColor,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `${view.header}\n${metaLine}`,
    blocks: view.blocks,
  });

  const paging = {
    canPrev: view.page > 0,
    canNext: view.page < (view.totalPages - 1),
    page: view.page,
    totalPages: view.totalPages,
  };
  const stateForButtons = { ...state, page: view.page };

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      container,
      warTopRow(stateForButtons),
      warPagingRow(stateForButtons, paging),
    ],
    allowedMentions: { parse: [] },
  };
}

export async function warHandler(interaction) {
  try {
    const isComponent = interaction.isButton?.() ?? false;
    const parsedForAuth = isComponent ? (parseWarAction(interaction.customId) ?? { ownerId: null }) : { ownerId: null };

    if (isComponent && parsedForAuth.ownerId && interaction.user?.id && interaction.user.id !== parsedForAuth.ownerId) {
      const payload = { content: 'This WAR panel belongs to someone else. Run `/war` to open your own panel.', flags: MessageFlags.Ephemeral };
      if (!interaction.deferred && !interaction.replied) return interaction.reply(payload);
      return interaction.followUp(payload);
    }

    if (isComponent && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    if (!isComponent && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const parsed = isComponent
      ? (parseWarAction(interaction.customId) ?? { windowDays: 7, page: 0, ownerId: null })
      : { windowDays: 7, page: 0, ownerId: null };

    const state = {
      windowDays: toWindowDays(parsed.windowDays),
      page: toPage(parsed.page),
      ownerId: parsed.ownerId ?? interaction.user?.id ?? null,
    };

    const data = await loadOpsData(state.windowDays);
    const roleCtx = await buildRoleContext(interaction.guild, data.members);
    const view = buildWarView(data, state.page, roleCtx, state.windowDays);
    const payload = buildWarPayload({ state, data, view });

    if (isComponent) {
      return interaction.editReply(payload);
    }

    const userId = interaction?.user?.id;
    const channelId = interaction?.channelId;
    const cached = userId ? WAR_PANEL_BY_USER.get(userId) : null;

    if (cached && cached.channelId === channelId && interaction.channel) {
      try {
        const previous = await interaction.channel.messages.fetch(cached.messageId);
        if (previous) {
          await previous.edit(payload);
          return interaction.editReply({
            content: 'Updated your existing WAR panel above.',
            embeds: [],
            components: [],
          });
        }
      } catch {
        // If old panel is gone/uneditable, create a new one below.
      }
    }

    await interaction.editReply(payload);
    const replyMessage = await interaction.fetchReply().catch(() => null);

    if (userId && replyMessage?.id) {
      WAR_PANEL_BY_USER.set(userId, { messageId: replyMessage.id, channelId });
    }

    return replyMessage;
  } catch (err) {
    console.error('[WAR] handler error:', formatErrorForLog(err));
    const failPayload = { content: 'WAR failed to load. Check logs.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: failPayload.content });
    }
    return interaction.reply(failPayload);
  }
}
