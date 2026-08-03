import { MessageFlags } from 'discord.js';
import { getClan } from '../../cr-api.js';
import { loadHistory } from '../../history.js';
import { resolveReportsChannel } from '../../schedule.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import { buildSeasonReport } from '../season-report-builder.js';
import { getExpectedDecksPerDay, getRecruitRuntimeIds } from '../db.js';

export const command = {
  name: 'recruit-season-report',
  description: 'Posts the CURRENT season top-5 to the leader channel each time it runs (leaders/admin only)',
};

export async function handleSeasonReport(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({
      content: 'Only leaders/admin can run this.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const CLAN_TAG = process.env.CLAN_TAG;
    if (!CLAN_TAG) {
      return interaction.editReply({ content: 'CLAN_TAG not configured.' });
    }

    const clan = await getClan(CLAN_TAG);
    const history = loadHistory();
    const expectedDecksPerDay = getExpectedDecksPerDay(db);

    const result = buildSeasonReport({ clan, history, db, expectedDecksPerDay });
    if (!result.ok) {
      return interaction.editReply({ content: result.reason });
    }

    const resolved = await resolveReportsChannel(interaction.client, db);
    if (!resolved.channel) {
      return interaction.editReply({ content: `Could not resolve leader channel to post to: ${resolved.reason}` });
    }

    await resolved.channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [result.container],
      allowedMentions: { parse: [] },
    });

    return interaction.editReply({ content: `Season report posted to <#${resolved.channelId}>. When the Clash Royale season has actually ended, run /recruit-season-reset (or \`scripts/season-reset.js\` from the terminal) to roll to the next one.` });
  } catch (e) {
    const msg = String(e?.message ?? e ?? 'Unknown error');
    return interaction.editReply({ content: `Season report failed: ${msg}` });
  }
}
