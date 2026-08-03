import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, setRecruitSetting } from '../db.js';
import { isServerOwner } from '../../permissions.js';
import { buildConfirmCancelRow } from '../../dashboard-components.js';

export const command = {
  name: 'recruit-decisions-reset',
  description: '⚠️ IRREVERSIBLE — deletes ALL decisions channel messages now. Server owner only.',
};

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function buildRulesEmbed() {
  return new EmbedBuilder()
    .setTitle('KRAKEN — Tier System & Role Rules')
    .setColor(0x5865f2)
    .setDescription(
      'Role reviews run on the **first training day after each war week closes**.\n' +
      'Performance is tracked across **2 complete war weeks** (14 days).\n\n' +
      '⛔ **Forbidden actions** — boat attacks and repair points disqualify you from promotion and recovery. Play normal war battles only.'
    )
    .addFields(
      {
        name: '🟡  PROBATION — New Member',
        value: [
          'All new recruits start here and are tracked through their first full war week.',
          '',
          '**→ Promote to WARCORE** — complete a perfect **2-war window**:',
          '  • 32/32 decks across both wars',
          '  • Zero missed war days',
          '  • No boat attacks or repair points',
          '',
          '**→ Drop to UNDERWATCH** — across 1 full war week:',
          '  • Fewer than 9 decks used, OR',
          '  • More than 1 missed war day, OR',
          '  • Any forbidden actions',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🟢  WARCORE — Full Member',
        value: [
          'Earned through consistent war performance.',
          '',
          '**→ Stays WARCORE** — across 2 wars:',
          '  • At least 17 decks used, AND',
          '  • 3 or fewer missed war days, AND',
          '  • No forbidden actions',
          '  *(minor misses receive leniency)*',
          '',
          '**→ Drop to PROBATION** — across 2 wars:',
          '  • Fewer than 17 decks, OR',
          '  • More than 3 missed war days, OR',
          '  • Any forbidden actions',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🔴  UNDERWATCH — At Risk',
        value: [
          'Performance fell below the minimum for 1 full war week.',
          '',
          '**→ Recover to PROBATION** — complete a perfect **2-war window**:',
          '  • 32/32 decks across both wars',
          '  • Zero missed war days',
          '  • No boat attacks or repair points',
          '  *(recovery goes back to Probation, not directly to Warcore)*',
          '',
          '**→ Boot review** — zero decks and zero fame for 1 full war week.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '⛔  BOOT REVIEW — Inactive',
        value: [
          'Triggered by **zero war activity** for 1 full war week.',
          'Remove role is applied automatically and leaders review for server removal.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🏖️  ON BREAK',
        value: [
          'Use the break system if you need time off — break days do not count against you.',
          '',
          '• **The day before your break ends** — friendly reminder DM sent.',
          '• **On the day your break ends** — warning DM sent if you haven\'t clicked I\'m Back.',
          '• If you still haven\'t returned, you will be placed in **Underwatch** for leader review.',
          '• If the clan is full while in Underwatch, leaders may remove you to make room.',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: 'KRAKEN automated management • Role decisions are final unless manually reviewed by a leader' });
}

async function purgeChannel(channel) {
  const cutoffMs = 14 * 24 * 60 * 60 * 1000 - 60_000; // 14 days minus 1-min safety margin
  let total = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100 });
    if (batch.size === 0) break;

    const now = Date.now();
    const bulk = batch.filter(m => now - m.createdTimestamp < cutoffMs);
    const old = batch.filter(m => now - m.createdTimestamp >= cutoffMs);

    if (bulk.size >= 2) {
      await channel.bulkDelete(bulk);
    } else {
      for (const m of bulk.values()) await m.delete().catch(() => {});
    }
    for (const m of old.values()) await m.delete().catch(() => {});

    total += batch.size;
    if (batch.size < 100) break;
  }

  return total;
}

export async function handleDecisionsReset(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');

  if (interaction.guildId !== recruitGuildId) return;

  if (!(await isServerOwner(interaction))) {
    return interaction.reply({ content: 'Only the server owner can run this.', flags: MessageFlags.Ephemeral });
  }

  const publicDecisionsChannelId = String(runtime?.channels?.publicDecisionsChannelId ?? '');
  if (!isValidDiscordId(publicDecisionsChannelId)) {
    return interaction.reply({
      content: 'Public decisions channel is not configured. Run /recruit-setup first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const warningEmbed = new EmbedBuilder()
    .setTitle('⚠️ Confirm: Reset Decisions Channel')
    .setColor(0xed4245)
    .setDescription([
      'This will **permanently delete every message** in <#' + publicDecisionsChannelId + '> and post a fresh rules embed.',
      '',
      '**This cannot be undone.** If you are not sure what this does, click Cancel.',
    ].join('\n'));

  const row = buildConfirmCancelRow({
    confirmCustomId: 'recruit:decisionsResetConfirm',
    confirmLabel: 'Confirm — delete everything',
    cancelCustomId: 'recruit:decisionsResetCancel',
  });

  return interaction.reply({ embeds: [warningEmbed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleDecisionsResetConfirm(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');

  if (interaction.guildId !== recruitGuildId) return;

  if (!(await isServerOwner(interaction))) {
    return interaction.reply({ content: 'Only the server owner can run this.', flags: MessageFlags.Ephemeral });
  }

  const publicDecisionsChannelId = String(runtime?.channels?.publicDecisionsChannelId ?? '');
  if (!isValidDiscordId(publicDecisionsChannelId)) {
    return interaction.update({ content: 'Public decisions channel is not configured. Run /recruit-setup first.', embeds: [], components: [] });
  }

  await interaction.update({ content: 'Resetting…', embeds: [], components: [] });

  try {
    const channel = await interaction.client.channels.fetch(publicDecisionsChannelId);
    if (!channel || typeof channel.messages?.fetch !== 'function') {
      return interaction.editReply({ content: 'Could not access the decisions channel.' });
    }

    const deleted = await purgeChannel(channel);

    const rulesMsg = await channel.send({ embeds: [buildRulesEmbed()], allowedMentions: { parse: [] } });
    await rulesMsg.pin().catch(() => {});

    // Clear tracked daily message IDs so next eval posts fresh
    setRecruitSetting(db, 'decisions.publicMessageHistory', '[]');
    setRecruitSetting(db, 'decisions.pinnedRulesMessageId', rulesMsg.id);

    return interaction.editReply({
      content: [
        '**Decisions channel reset complete.**',
        `Deleted: ${deleted} message(s).`,
        'Rules embed posted and pinned.',
        'The next eval run will post a fresh daily decisions message.',
      ].join('\n'),
    });
  } catch (e) {
    return interaction.editReply({ content: `Reset failed: ${String(e?.message ?? e)}` });
  }
}

export async function handleDecisionsResetCancel(interaction) {
  return interaction.update({ content: 'Cancelled — nothing was deleted.', embeds: [], components: [] });
}
