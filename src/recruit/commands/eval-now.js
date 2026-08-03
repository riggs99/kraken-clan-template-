import { MessageFlags } from 'discord.js';
import { runRecruitDailyEvaluation } from '../evaluator.js';
import { getRecruitRuntimeIds } from '../db.js';
import { isLeaderOrAdmin } from '../../permissions.js';

export const command = {
  name: 'recruit-eval-now',
  description: 'Run Recruit evaluator now (leaders/admin, Recruit HQ only)',
};

export async function handleEvalNow(interaction, ctx) {
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
    const result = await runRecruitDailyEvaluation(interaction.client, recruitConfig, db, { mode: 'manual' });

    const localDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const line = String(result?.line ?? '[RECRUIT] Daily eval completed.');
    return interaction.editReply({
      content: [
        'Recruit evaluator test run completed.',
        'Mode: manual-safe preview — no role changes applied, no profile updates, no offboarding, no public posts, no post-break enforcement, no daily-run or review stamps.',
        `Local day (Australia/Sydney): ${localDay}`,
        '',
        line,
      ].join('\n'),
    });
  } catch (e) {
    const msg = String(e?.message ?? e ?? 'Unknown error');
    return interaction.editReply({ content: `Recruit evaluator failed: ${msg}` });
  }
}
