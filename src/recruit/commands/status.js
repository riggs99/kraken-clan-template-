import { MessageFlags } from 'discord.js';
import {
  getActiveBreak,
  getRecruitRuntimeIds,
  getRecruitSetting,
  getUnderwatchState,
  getProbationState,
  getPostBreakEnforcement,
} from '../db.js';
import { cleanTag } from '../../util.js';
import { loadOpsData, getExpectedDecksPerDay } from '../../ops.js';
import { loadHistory } from '../../history.js';
import { explainPolicyReason, tierFromProfileStatus, rankLastCompletedWarWeek, buildWarHistoryRecord } from '../policy.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS, renderTable } from '../../dashboard-components.js';
import { onCooldown } from '../../cooldown.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import { HIGH_RISK_THRESHOLD } from '../../risk-score.js';

// Below HIGH_RISK_THRESHOLD but still worth a leader/member's attention — this
// mid-tier only exists here (no other view currently needs a 3-way split), so it's
// not promoted to the shared risk-score.js threshold alongside HIGH_RISK_THRESHOLD.
const NEEDS_ATTENTION_THRESHOLD = 0.35;

// Unlike the old DB-only /status, this now runs the same clan-wide CR API fetch +
// history write + full-roster risk/policy pipeline as /ops and /war (loadOpsData) —
// so it needs the same kind of per-user throttling those commands get from
// src/index.js's cooldown gate, which recruit-guild commands never pass through.
const STATUS_COOLDOWN_MS = 30_000;

// Mirrors appeal.js's APPEAL_COOLDOWN_MS (module-private there, not exported).
const APPEAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const TIER_BADGE = {
  warcore: '🛡️ WARCORE',
  probation: '🔎 Probation',
  underwatch: '⚠️ Underwatch',
  none: '❔ Unlinked',
};

// Renders a week's day-keys as a short human date range for a table caption, e.g.
// "Jul 9" (single day) or "Jul 9–12" (span) — always UTC since that's the timezone
// every war-day/period boundary in this codebase is computed in.
function formatWeekRange(weekDays) {
  if (!weekDays?.length) return '';
  const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const startIso = weekDays[0];
  const endIso = weekDays[weekDays.length - 1];
  if (startIso === endIso) return fmt(startIso);
  const startStr = fmt(startIso);
  // Same month: drop the repeated month name on the end date ("Jul 9–12" not
  // "Jul 9–Jul 12"). Different month (a week straddling a month boundary): keep
  // both full labels ("Jun 30–Jul 2") since the month itself is the useful part.
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  const endStr = sameMonth ? String(new Date(`${endIso}T00:00:00Z`).getUTCDate()) : fmt(endIso);
  return `${startStr}–${endStr}`;
}

// Turns the last completed war week's rank/stats into a headline sentence (the
// actual "wow" the card is built around) plus a readable stat table — replaces the
// old middot-joined single line, which read as cramped and hard to scan. Picks the
// most exceptional true thing about the week (top-3 rank in either category, or a
// perfect deck week) for the headline. A quiet or below-average week gets a
// factual, forward-looking line instead of silence or a scold — same tone
// philosophy as everywhere else in this command (encouraging for self, plain for a
// leader's lookup).
function buildWeekStory({ weekRank, subject, possessive, isSelf, edpd }) {
  if (!weekRank) return null;
  const { warRank, donationRank, fameTotal, decksTotal, donationsTotal, totalPeers, weekDayCount, weekDays } = weekRank;
  const expectedDecks = edpd * weekDayCount;
  const perfectDecks = expectedDecks > 0 && decksTotal >= expectedDecks;
  const topWar = warRank <= 3;
  const topDonor = donationRank <= 3;
  // "of N" always means N people who actually fought last war week, NOT the current
  // clan roster size — those two numbers genuinely differ (anyone who's since left
  // is still counted here) and reading it as "the bot thinks the clan has N members"
  // is an easy, understandable misread, so every occurrence spells out "who fought"
  // rather than a bare count.
  const peerLabel = `${totalPeers} who fought`;

  let headline;
  if (topDonor && donationRank === 1) {
    headline = `💝 **#1 in donations** last week — ${isSelf ? 'the' : `${possessive} the`} clan's most generous member`;
  } else if (topWar && warRank === 1) {
    headline = `🏆 **#1 in war performance** last week — ${isSelf ? "you're" : `${subject} is`} the clan's top warrior`;
  } else if (topDonor) {
    headline = `💝 **#${donationRank} in donations** last week (of ${peerLabel}) — generous with the clan`;
  } else if (topWar) {
    headline = `🏆 **#${warRank} in war performance** last week (of ${peerLabel}) — one of the clan's top warriors`;
  } else if (perfectDecks) {
    headline = `✅ **Perfect war week** — every battle, every deck used`;
  } else if (warRank > totalPeers * 0.8) {
    headline = isSelf
      ? `📊 A quieter week — #${warRank} in war performance (of ${peerLabel}), plenty of time to bounce back`
      : `📊 Quiet week — #${warRank} in war performance (of ${peerLabel})`;
  } else {
    headline = isSelf
      ? `📈 Solid week — #${warRank} in war performance (of ${peerLabel})`
      : `📈 Steady week — #${warRank} in war performance (of ${peerLabel})`;
  }

  // Full stat table underneath the headline — unlike the old single joined line,
  // a table doesn't need to dodge repeating whatever the headline already said
  // (repetition across a headline + a scannable table row is normal, not clutter),
  // so every stat is always shown here regardless of which one the headline led with.
  const deckPct = expectedDecks > 0 ? Math.round((decksTotal / expectedDecks) * 100) : 0;
  const table = renderTable(
    [
      { key: 'metric', label: 'Stat', width: 12 },
      { key: 'value', label: 'Result', width: 20 },
    ],
    [
      { metric: 'War Rank', value: `#${warRank} of ${totalPeers}` },
      { metric: 'Decks Used', value: expectedDecks > 0 ? `${decksTotal}/${expectedDecks} (${deckPct}%)` : `${decksTotal}` },
      { metric: 'Donations', value: donationsTotal > 0 ? `${donationsTotal} (#${donationRank} of ${totalPeers})` : '0' },
      { metric: 'Fame', value: fameTotal.toLocaleString() },
    ],
  );
  const rangeCaption = formatWeekRange(weekDays);

  return { headline, caption: rangeCaption ? `*War week of ${rangeCaption}*` : null, table };
}

// Resolves a leader's typed `name` option to a clan member. Tried as a tag FIRST —
// an autocomplete suggestion's submitted value is always the tag, not the display
// name (see handleStatusAutocomplete), so picking a suggestion resolves here with
// zero ambiguity. Free-typed input that was never selected from the list falls back
// to matching against in-game names instead, since that's what a leader who ignored
// the suggestions actually typed.
function resolvePlayerByNameOrTag(rawInput, policyRows) {
  const asTag = cleanTag(rawInput);
  const byTag = policyRows.find(m => cleanTag(m.tag) === asTag);
  if (byTag) return { match: byTag, candidates: [] };

  const query = String(rawInput ?? '').trim().toLowerCase();
  if (!query) return { match: null, candidates: [] };

  const exactName = policyRows.filter(m => String(m.name ?? '').trim().toLowerCase() === query);
  if (exactName.length === 1) return { match: exactName[0], candidates: [] };
  if (exactName.length > 1) return { match: null, candidates: exactName };

  const partial = policyRows.filter(m => String(m.name ?? '').trim().toLowerCase().includes(query));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial };
}

export const command = {
  name: 'status',
  description: 'Check your KRAKEN status — leaders can also look up another member\'s',
  options: [
    {
      type: 6, // USER
      name: 'player',
      description: 'Leaders only — view another member\'s status',
      required: false,
    },
    {
      type: 3, // STRING
      name: 'name',
      description: 'Leaders only — look up by in-game name instead (start typing for suggestions)',
      required: false,
      autocomplete: true,
    },
  ],
};

// Fast, local suggestion source for the `name` option — NOT loadOpsData, which hits
// the live CR API 3x plus a full risk-score pass and would blow Discord's 3-second
// autocomplete response window (and get called on every keystroke). The latest
// history.json snapshot is a synchronous file read and close enough to current —
// same tradeoff latestKnownName (policy.js) already makes for name lookups.
// Suggestion VALUES are player tags, not names (see resolvePlayerByNameOrTag) —
// picking one always resolves unambiguously regardless of duplicate/similar names.
export async function handleStatusAutocomplete(interaction, ctx) {
  const db = ctx?.db;
  try {
    const runtime = getRecruitRuntimeIds(db);
    const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
    // Don't leak the roster to non-leaders via suggestions even though they'd be
    // rejected at execution time anyway — same permission this command enforces.
    if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
      return await interaction.respond([]);
    }

    const focused = String(interaction.options.getFocused() ?? '').trim().toLowerCase();
    const history = loadHistory();
    const days = Object.keys(history?.days ?? {}).sort();
    const latestDay = days[days.length - 1];
    const membersMap = history?.days?.[latestDay]?.members ?? {};

    const candidates = Object.values(membersMap)
      .map(m => ({ name: String(m?.name ?? '').trim(), tag: cleanTag(m?.tag) }))
      .filter(m => m.name && m.tag);

    const filtered = focused ? candidates.filter(m => m.name.toLowerCase().includes(focused)) : candidates;
    filtered.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(focused) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(focused) ? 0 : 1;
      return aStarts !== bStarts ? aStarts - bStarts : a.name.localeCompare(b.name);
    });

    const choices = filtered.slice(0, 25).map(m => ({ name: `${m.name} (#${m.tag})`, value: m.tag }));
    return await interaction.respond(choices);
  } catch (e) {
    console.error('[STATUS] autocomplete failed:', e?.message ?? e);
    return interaction.respond([]).catch(() => {});
  }
}

export async function handleStatus(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const runtime = getRecruitRuntimeIds(db);
  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');

  const playerOption = interaction.options.getUser('player');
  const nameOption = interaction.options.getString('name');
  if (playerOption && nameOption) {
    return interaction.reply({ content: 'Use either `player` or `name`, not both.', flags: MessageFlags.Ephemeral });
  }

  let targetUser = interaction.user;
  let isSelf = true;
  if (playerOption || nameOption) {
    if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
      return interaction.reply({ content: 'Only leaders can look up another member\'s status.', flags: MessageFlags.Ephemeral });
    }
    if (playerOption) {
      targetUser = playerOption;
      isSelf = targetUser.id === interaction.user.id;
    }
    // nameOption's targetUser is resolved further below, once live clan data is
    // loaded — a Discord display name and an in-game name are frequently different,
    // so this is looked up by name against the CLAN roster, not Discord's user list.
  }

  const cd = onCooldown(interaction.user.id, 'status', STATUS_COOLDOWN_MS);
  if (cd.on) {
    return interaction.reply({
      content: `Cooldown active for **status**. Try again in **${cd.retryAfter}s**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // A name lookup needs the live roster to resolve the typed name/tag to a member
  // BEFORE it even knows which Discord profile (if any) to load — fetched early only
  // for this path. The player/self paths keep their original fast exit below (skip
  // the CR API call entirely) when the target simply isn't linked yet.
  let data = null;
  if (nameOption) {
    try {
      data = await loadOpsData(14);
    } catch {
      return interaction.editReply({ content: 'Could not load live clan data right now. Try again shortly.' });
    }

    const resolved = resolvePlayerByNameOrTag(nameOption, data.policyRows);
    if (!resolved.match) {
      const content = resolved.candidates.length
        ? `Multiple clan members match "${nameOption}" — pick one from the autocomplete suggestions instead: ${resolved.candidates.slice(0, 10).map(c => c.name).join(', ')}`
        : `No clan member found matching "${nameOption}". Try the autocomplete suggestions.`;
      return interaction.editReply({ content });
    }

    const resolvedTag = cleanTag(resolved.match.tag);
    const allProfiles = db.prepare('SELECT discord_id, player_tag FROM profiles').all();
    const linked = allProfiles.find(p => cleanTag(p.player_tag) === resolvedTag);

    if (!linked?.discord_id) {
      const header = `## 🐙 KRAKEN STATUS — ${resolved.match.name}\n#${resolvedTag} · looked up by leader · not linked to Discord`;
      const container = buildDashboardContainer({
        accentColor: STATUS_COLORS.neutral,
        thumbnailUrl: CLAN_BADGE_URL,
        header,
        blocks: ['This clan member has not linked a Discord account yet — no profile, tier, or lifecycle data is tracked for them until they do.'],
      });
      return interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        allowedMentions: { parse: [] },
      });
    }

    targetUser = await interaction.client.users.fetch(linked.discord_id).catch(() => null);
    if (!targetUser) {
      return interaction.editReply({ content: 'Found the player but could not resolve their Discord account right now. Try again shortly.' });
    }
    isSelf = targetUser.id === interaction.user.id;
  }

  const profile = db.prepare('SELECT status, player_tag, cooldown_until, created_at FROM profiles WHERE discord_id = ?')
    .get(String(targetUser.id));

  if (!profile?.player_tag) {
    // Friendlier, second-person framing for a member checking their own status;
    // leaders looking someone else up get the plain, name-first version instead —
    // same information either way, just different tone for a different reader.
    const header = isSelf
      ? `## 🐙 Your KRAKEN Status\nYou're not linked to KRAKEN yet.`
      : `## 🐙 KRAKEN STATUS\n<@${targetUser.id}> is not linked to KRAKEN yet.`;
    const container = buildDashboardContainer({
      accentColor: STATUS_COLORS.neutral,
      thumbnailUrl: CLAN_BADGE_URL,
      header,
      blocks: ['Linking happens automatically the first time a member clicks **Agree & Join** in #welcome.'],
    });
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    });
  }

  const tag = cleanTag(profile.player_tag);

  if (!data) {
    try {
      data = await loadOpsData(14);
    } catch {
      return interaction.editReply({ content: 'Could not load live clan data right now. Try again shortly.' });
    }
  }

  const scoredRow = data.scored.find(m => cleanTag(m.tag) === tag) ?? null;
  const policyRow = data.policyRows.find(m => cleanTag(m.tag) === tag) ?? null;

  const currentTier = policyRow?.currentTier ?? tierFromProfileStatus(profile.status);
  const displayName = scoredRow?.name ?? policyRow?.name ?? targetUser.username;
  const edpd = getExpectedDecksPerDay();

  // The headline "wow" moment: how this specific player did in the last completed
  // war week, ranked against everyone who actually fought that week (not just
  // currently-linked members) — a different, more tellable signal than the rolling
  // risk trend below, which is why it leads the card.
  const weekRankData = rankLastCompletedWarWeek(data.history, edpd);
  const weekEntry = weekRankData.byTag[tag] ?? null;
  const weekStory = weekEntry
    ? buildWeekStory({
        weekRank: { ...weekEntry, totalPeers: weekRankData.totalPeers, weekDayCount: weekRankData.realDayCount, weekDays: weekRankData.weekDays },
        subject: displayName,
        possessive: isSelf ? 'You are' : `${displayName} is`,
        isSelf,
        edpd,
      })
    : null;
  const weekBlock = weekStory
    ? [weekStory.headline, weekStory.caption, weekStory.table].filter(Boolean).join('\n')
    : null;

  // Standing verdict — the rolling risk trend (a different signal from the week
  // story above: "how are things trending" vs "how was that one week"). Same
  // underlying signal for both audiences, just second-person/encouraging for a
  // member checking themselves vs. plain/clinical for a leader scanning someone else's.
  let standingLine;
  let accentColor;
  if (!scoredRow) {
    standingLine = isSelf
      ? 'ℹ️ **No recent war data for you yet** — not currently on the tracked clan roster.'
      : 'ℹ️ **No recent war data** — not currently on the tracked clan roster.';
    accentColor = STATUS_COLORS.neutral;
  } else {
    const risk = Number(scoredRow.risk ?? 0);
    const topReason = scoredRow.reasons?.[0] ?? null;
    if (risk >= HIGH_RISK_THRESHOLD) {
      standingLine = (isSelf ? '🔴 **You\'re currently at risk**' : '🔴 **At risk**') + (topReason ? ` — ${topReason}` : '');
      accentColor = STATUS_COLORS.critical;
    } else if (risk >= NEEDS_ATTENTION_THRESHOLD) {
      standingLine = (isSelf ? '🟡 **You need some attention**' : '🟡 **Needs attention**') + (topReason ? ` — ${topReason}` : '');
      accentColor = STATUS_COLORS.warn;
    } else {
      standingLine = (isSelf ? '🟢 **You\'re in good standing!**' : '🟢 **Good standing**') + (topReason ? ` — ${topReason}` : '');
      accentColor = STATUS_COLORS.healthy;
    }
  }
  // accentColor always reflects the current rolling risk trend (or roster status),
  // never the week story above — a great last-completed week must not visually mask
  // a currently declining trend (or repaint a departed member's card as healthy); the
  // week story's own medal/checkmark emoji and bold text already carry its own weight.

  // Only surface reasons beyond the one already quoted inline in standingLine —
  // repeating it verbatim in a "Flags:" section right below added a whole extra
  // block for zero new information (confirmed live: this was the single biggest
  // "bland" complaint about the old card).
  const extraReasons = (scoredRow?.reasons ?? []).slice(1);
  const issuesBlock = extraReasons.length ? `**Also:**\n${extraReasons.map(r => `• ${r}`).join('\n')}` : null;

  const tierLine = `**Tier:** ${TIER_BADGE[currentTier] ?? currentTier}`;
  let decisionLine = null;
  if (policyRow?.policy && policyRow.policy.desiredTier !== currentTier) {
    const reason = explainPolicyReason(policyRow.policy.reasons?.[0]);
    decisionLine = policyRow.policy.remove
      ? `⚠️ **Flagged for boot review** — ${reason}`
      : `📋 **Pending move → ${TIER_BADGE[policyRow.policy.desiredTier] ?? policyRow.policy.desiredTier}** — ${reason}`;
  }
  const tierBlock = [tierLine, decisionLine].filter(Boolean).join('\n');

  // Rolling trend underneath the single-week story above — same window and fields
  // computeHistoryWeightedRisk already produces for the risk score itself, just
  // surfaced directly instead of only feeding into the hidden risk number.
  const rollingBlock = scoredRow
    ? `**Last ${scoredRow.historyDays ?? 14} days:** ${Math.round(Number(scoredRow.warParticipationRate ?? 0))}% war participation · ${Math.round((1 - Number(scoredRow.deckMissRate ?? 0)) * 100)}% deck usage · ${scoredRow.donations ?? 0} donated / ${scoredRow.donationsReceived ?? 0} received`
    : null;

  const lifecycleLines = [];
  const activeBreak = getActiveBreak(db, targetUser.id);
  if (activeBreak?.breakUntil) {
    const ts = Math.floor(activeBreak.breakUntil / 1000);
    lifecycleLines.push(`🌴 On a break until <t:${ts}:F>${activeBreak.reason ? ` — ${activeBreak.reason}` : ''}`);
  }
  // Only surfaced once it's actually notable — a permanent "Days inactive: —" row
  // in the old table added a line that was blank almost all the time.
  if (Number(scoredRow?.daysInactive ?? 0) > 2) {
    lifecycleLines.push(`⏱️ Inactive ${scoredRow.daysInactive} day(s)`);
  }
  if (currentTier === 'underwatch') {
    const uw = getUnderwatchState(db, targetUser.id);
    if (uw?.startedAt) {
      lifecycleLines.push(`⚠️ Underwatch since <t:${Math.floor(uw.startedAt / 1000)}:D> — needs 2 clean complete wars to recover`);
    }
  }
  if (currentTier === 'probation') {
    const ps = getProbationState(db, targetUser.id);
    if (ps) lifecycleLines.push(`🔎 Probation clean streak: ${ps.cleanStreakDays} day(s)${ps.paused ? ' (paused)' : ''}`);
  }
  const cooldownUntil = Number(profile.cooldown_until ?? 0);
  if (cooldownUntil > Date.now()) {
    lifecycleLines.push(`⏳ Reapply cooldown active until <t:${Math.floor(cooldownUntil / 1000)}:R>`);
  }
  const appealLastSubmit = Number(getRecruitSetting(db, `appeal.lastSubmit.${targetUser.id}`) ?? 0);
  if (appealLastSubmit) {
    const nextMs = appealLastSubmit + APPEAL_COOLDOWN_MS;
    if (nextMs > Date.now()) lifecycleLines.push(`📨 Appeal cooldown active until <t:${Math.floor(nextMs / 1000)}:R>`);
  }
  // post_break_enforcement rows are only ever created for breaks already matched by
  // `WHERE break_until <= now` (evaluator.js's runPostBreakEnforcement), so breakUntil
  // is always in the past by construction — a still-existing row with warnCount > 0
  // is itself the "still active" signal; it's cleared (clearPostBreakEnforcement) once
  // war activity resumes or the member leaves, so there's nothing further to compare.
  const postBreak = getPostBreakEnforcement(db, targetUser.id);
  if (postBreak?.warnCount > 0) {
    lifecycleLines.push(`🚧 Post-break enforcement: ${postBreak.warnCount} warning(s)`);
  }
  const lifecycleBlock = lifecycleLines.length
    ? `**Lifecycle:**\n${lifecycleLines.join('\n')}`
    : '**Lifecycle:** No active flags — clean record.';

  // Bottom half of the card: the historical record — when they joined, how many
  // completed war weeks KRAKEN has tracked for them, current streaks, and personal
  // bests. A separate signal from everything above (which is all "now" — this
  // week's story, the current tier, the rolling trend) — this is "over time."
  const warHistory = buildWarHistoryRecord(data.history, tag, edpd);
  const historicalHeaderBlock = '## 📜 Historical Record';

  const weeksTrackedLabel = warHistory.weeksTracked > 0
    ? `${warHistory.weeksTracked} war week${warHistory.weeksTracked === 1 ? '' : 's'} tracked`
    : 'No completed war weeks tracked yet';
  const memberSinceLine = profile.created_at
    ? `**Member since:** <t:${Math.floor(Number(profile.created_at) / 1000)}:D> · ${weeksTrackedLabel}`
    : null;

  const streakLines = [];
  if (warHistory.streaks.top1War >= 2) streakLines.push(`• 🥇 #1 in war performance — ${warHistory.streaks.top1War} weeks running`);
  if (warHistory.streaks.perfectDecks >= 2) streakLines.push(`• 💯 Perfect deck usage — ${warHistory.streaks.perfectDecks} weeks running`);
  if (warHistory.streaks.top1Donor >= 2) streakLines.push(`• 💝 #1 in donations — ${warHistory.streaks.top1Donor} weeks running`);
  if (warHistory.streaks.attendance >= 2) streakLines.push(`• 🛡️ Zero missed war days — ${warHistory.streaks.attendance} weeks running`);
  const streaksBlock = streakLines.length ? `**🔥 Current Streaks**\n${streakLines.join('\n')}` : null;

  let bestsBlock = null;
  if (warHistory.bests) {
    const b = warHistory.bests;
    const bestLines = [
      `• Best war rank: #${b.bestWarRankWeek.warRank} of ${b.bestWarRankWeek.totalPeers} (week of ${formatWeekRange(b.bestWarRankWeek.weekDays)})`,
      `• Most fame in a week: ${b.bestFameWeek.fameTotal.toLocaleString()} (week of ${formatWeekRange(b.bestFameWeek.weekDays)})`,
    ];
    if (b.bestDonationWeek.donationsTotal > 0) {
      bestLines.push(`• Most donated in a week: ${b.bestDonationWeek.donationsTotal} (week of ${formatWeekRange(b.bestDonationWeek.weekDays)})`);
    }
    if (b.perfectWeekCount > 0) {
      bestLines.push(`• Perfect deck weeks: ${b.perfectWeekCount}`);
    }
    bestsBlock = `**🏅 Personal Bests**\n${bestLines.join('\n')}`;
  }

  const header = isSelf
    ? `## 🐙 Your KRAKEN Status\n${displayName} · #${tag}`
    : `## 🐙 KRAKEN STATUS — ${displayName}\n<@${targetUser.id}> · #${tag} · looked up by leader`;

  const container = buildDashboardContainer({
    accentColor,
    thumbnailUrl: CLAN_BADGE_URL,
    header,
    blocks: [
      weekBlock, standingLine, issuesBlock, tierBlock, rollingBlock, lifecycleBlock,
      historicalHeaderBlock, memberSinceLine, streaksBlock, bestsBlock,
    ].filter(Boolean),
  });

  return interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  });
}
