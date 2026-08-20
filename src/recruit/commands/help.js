import { MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds } from '../db.js';
import { isLeaderOrAdmin, isServerOwner } from '../../permissions.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../../dashboard-components.js';

export const command = {
  name: 'help',
  description: 'Show what KRAKEN commands you can use and how',
};

export async function handleHelp(interaction, { db }) {
  const runtime = getRecruitRuntimeIds(db);
  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  const isLeader = isLeaderOrAdmin(interaction, leadersRoleId);
  // Short-circuited: isServerOwner does a live guild.fetch(), skip that network
  // call entirely for the common case (a regular member checking /help). The
  // real Discord owner always carries Administrator, so this never hides the
  // owner-only section from the actual owner — worst case on some edge-case
  // permission gap is a missing section in a purely informational command, not
  // a change to what they can actually run.
  const isOwner = isLeader && await isServerOwner(interaction);

  const blocks = [
    [
      '**`/status`** — check your own KRAKEN tier, last week\'s war story, and your season history.',
      'Just run `/status` with no options. Only you can see the result.',
    ].join('\n'),
    [
      '**`/recruit-appeal`** — think a KRAKEN tier decision was wrong? Appeal it here.',
      'Run `/recruit-appeal reason:<explain what happened>` — a leader reviews it and DMs you the outcome. One appeal per 7 days.',
    ].join('\n'),
  ];

  if (isLeader) {
    blocks.push(
      [
        '**Leader tools**',
        '`/standings` — recommendation board for the whole roster: shows every tracked member\'s keep / watch / underwatch / boot-review status based on this week\'s war performance. Paginated.',
        '`/recruit-eval-now` — runs a dry-run preview of the automatic weekly tier evaluation (what roles WOULD change) without applying anything — use it to sanity-check before the real evaluator runs.',
        '`/recruit-season-report` — posts the current season\'s top-5 (fame, wars played, donations) to the leader channel each time it runs. Doesn\'t change any data, but it does post publicly — run it when you want current standings visible, not just to check.',
        '`/recruit-season-reset` — ⚠️ the real season rollover: posts the final season report and starts a new season, after a confirm step. Run this when the season has actually ended. (KRAKEN also auto-posts a reminder to this channel on the first Monday of each month, since real CR seasons roughly follow that cadence — it\'s a nudge only, not automatic action.)',
        '`/recruit-history` — look up one player\'s full war-week history: rank, decks, donations, and streaks for every completed war week on record.',
        '`/recruit-add-member` — manually link a Discord member to a Clash Royale tag and add them on probation, for anyone who joined outside the normal /apply flow. Ops channel only.',
        '`/ops` — main clan dashboard: health score, attention queue, donation rankings, promote/boot-review recommendations.',
        '`/war` — standalone war hub: live leaderboard, war-contribution ranking, boat-attack offenders, tier-decision buckets.',
        '`/recruit-remove-member` — ⚠️ kicks a member from Discord (after a confirmation step) and marks them removed in KRAKEN. Requires a logged reason. Cannot be undone. Needs the bot to have Kick Members permission, which is off by default.',
        '`/recruit-ban-member` — ⚠️ same as above, but bans instead of kicking (they can\'t rejoin with a new invite). Needs Ban Members permission, also off by default.',
      ].join('\n'),
    );
  }

  if (isOwner) {
    blocks.push(
      [
        '**Owner only**',
        '`/recruit-settings` — view or change the expected decks-per-war-day value (default 4) used across every tier decision. Affects the whole roster the next time the evaluator runs — get it wrong and members can be promoted/demoted incorrectly, so this is owner-only rather than any leader.',
        '',
        '**Owner only — irreversible**',
        '`/recruit-setup` — one-time setup: creates (or repairs) every Recruit HQ channel and role KRAKEN needs and saves their IDs. Safe to re-run if something\'s missing.',
        '`/recruit-decisions-reset` — ⚠️ deletes every message in the public decisions channel and posts a fresh rules embed. Asks for confirmation first. Cannot be undone.',
        '`/recruit-break-reset` — ⚠️ deletes every message in the on-a-break channel AND force-clears every member\'s active break from the database. Asks for confirmation first. Cannot be undone.',
      ].join('\n'),
    );
  }

  blocks.push(
    '_KRAKEN is unofficial fan content and is not affiliated with, endorsed, sponsored, or specifically approved by Supercell. See Supercell\'s Fan Content Policy._',
  );

  const container = buildDashboardContainer({
    accentColor: STATUS_COLORS.neutral,
    thumbnailUrl: CLAN_BADGE_URL,
    header: '## 🐙 KRAKEN — Commands',
    blocks,
  });

  return interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] },
  });
}
