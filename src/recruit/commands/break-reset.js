import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, setRecruitSetting, clearUnderwatchState, clearProbationState, clearPostBreakEnforcement } from '../db.js';
import { ensureBreakPost } from '../breaks.js';
import { isServerOwner } from '../../permissions.js';
import { buildConfirmCancelRow } from '../../dashboard-components.js';

export const command = {
  name: 'recruit-break-reset',
  description: '⚠️ IRREVERSIBLE — wipes the break channel + all active breaks now. Server owner only.',
};

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

export async function handleBreakReset(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');

  if (interaction.guildId !== recruitGuildId) return;

  if (!(await isServerOwner(interaction))) {
    return interaction.reply({ content: 'Only the server owner can run this.', flags: MessageFlags.Ephemeral });
  }

  const onBreakChannelId = String(runtime?.channels?.onBreakChannelId ?? '');
  if (!isValidDiscordId(onBreakChannelId)) {
    return interaction.reply({
      content: 'On-a-break channel is not configured. Run /recruit-setup first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const activeBreakCount = db.prepare('SELECT COUNT(*) as cnt FROM breaks').get()?.cnt ?? 0;
  const warningEmbed = new EmbedBuilder()
    .setTitle('⚠️ Confirm: Reset Break Channel')
    .setColor(0xed4245)
    .setDescription([
      'This will **permanently delete every message** in <#' + onBreakChannelId + '> and post a fresh panel.',
      `It will also **clear all ${activeBreakCount} currently active break(s)** from the database — those members' break state is gone, not paused.`,
      '',
      '**This cannot be undone.** If you are not sure what this does, click Cancel.',
    ].join('\n'));

  const row = buildConfirmCancelRow({
    confirmCustomId: 'recruit:breakResetConfirm',
    confirmLabel: 'Confirm — wipe breaks',
    cancelCustomId: 'recruit:breakResetCancel',
  });

  return interaction.reply({ embeds: [warningEmbed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleBreakResetConfirm(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');

  if (interaction.guildId !== recruitGuildId) return;

  if (!(await isServerOwner(interaction))) {
    return interaction.reply({ content: 'Only the server owner can run this.', flags: MessageFlags.Ephemeral });
  }

  const onBreakChannelId = String(runtime?.channels?.onBreakChannelId ?? '');
  if (!isValidDiscordId(onBreakChannelId)) {
    return interaction.update({ content: 'On-a-break channel is not configured. Run /recruit-setup first.', embeds: [], components: [] });
  }

  await interaction.update({ content: 'Resetting…', embeds: [], components: [] });

  try {
    // Count active breaks before clearing (for the summary)
    const activeBreakCount = db.prepare('SELECT COUNT(*) as cnt FROM breaks').get()?.cnt ?? 0;
    const clearedDiscordIds = db.prepare('SELECT discord_id FROM breaks').all().map(r => r.discord_id);

    // Clear all active breaks from DB
    db.prepare('DELETE FROM breaks').run();

    // Every other break-clearing path (the "I'm Back" button, resetRelinkTrackingState) also
    // clears underwatch/probation pause-state alongside the break row. Without this, anyone
    // who was paused in underwatch while on break keeps a stale pauseStartedAt forever — the
    // normal flows that would resolve it never run once this command force-deletes the break
    // directly, since neither "I'm Back" nor the evaluator's break-check ever fires for them.
    for (const discordId of clearedDiscordIds) {
      clearUnderwatchState(db, discordId);
      clearProbationState(db, discordId);
      clearPostBreakEnforcement(db, discordId);
    }

    // Clear stored message IDs — ensureBreakPost sees no info embed ID and does a full purge + re-post
    setRecruitSetting(db, 'messages.breakInfoEmbedId', '');
    setRecruitSetting(db, 'messages.breakPanelId', '');

    // Purge channel and post fresh info embed + panel
    await ensureBreakPost(interaction.client, recruitConfig, db);

    // Log the reset permanently to logsChannelId
    const logsChannelId = String(runtime?.channels?.logsChannelId ?? '');
    if (isValidDiscordId(logsChannelId)) {
      try {
        const logsChannel = await interaction.client.channels.fetch(logsChannelId);
        if (logsChannel?.send) {
          await logsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Break Channel Reset')
                .setColor(0xfee75c)
                .setDescription('The on-a-break channel was purged and reset.')
                .addFields(
                  { name: 'Reset by', value: `<@${interaction.user.id}>`, inline: true },
                  { name: 'Active breaks cleared', value: String(activeBreakCount), inline: true },
                ),
            ],
            allowedMentions: { parse: [] },
          });
        }
      } catch {
        // ignore log failures
      }
    }

    return interaction.editReply({
      content: [
        '**On-a-break channel reset complete.**',
        `Active breaks cleared from DB: **${activeBreakCount}**`,
        'Fresh info embed and panel posted and pinned.',
        '',
        activeBreakCount > 0
          ? '⚠️ Members who were on break have had their DB entry cleared. Remove their `on a break` role manually if needed.'
          : 'No active breaks were in progress.',
      ].join('\n'),
    });
  } catch (e) {
    return interaction.editReply({ content: `Reset failed: ${String(e?.message ?? e)}` });
  }
}

export async function handleBreakResetCancel(interaction) {
  return interaction.update({ content: 'Cancelled — nothing was deleted.', embeds: [], components: [] });
}
