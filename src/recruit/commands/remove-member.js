import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getClan } from '../../cr-api.js';
import { formatErrorForLog } from '../../security.js';
import {
  getRecruitRuntimeIds,
  removeFromWaitlist,
  clearUnderwatchState,
  clearProbationState,
  clearPostBreakEnforcement,
} from '../db.js';
import { notifyNextWaiting } from '../waitlist.js';
import { applyRemovedRoleState } from '../evaluator.js';
import { isLeaderOrAdmin, confirmMemberGone } from '../../permissions.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function safeTruncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

async function safeSendToChannel(client, channelId, embed, fallbackChannelId) {
  for (const id of [channelId, fallbackChannelId]) {
    if (!isValidDiscordId(String(id ?? ''))) continue;
    try {
      const ch = await client.channels.fetch(String(id));
      if (ch?.send) {
        await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

export const command = {
  name: 'recruit-remove-member',
  description: '⚠️ IRREVERSIBLE — kicks the member from Discord after confirmation. Leaders/admins only.',
  options: [
    { name: 'player', description: 'Discord member to remove', type: 6, required: true },
    { name: 'reason', description: 'Why this member is being removed (logged)', type: 3, required: true, max_length: 500 },
  ],
};

export async function handleRemoveMember(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({ content: 'Leaders only.', flags: MessageFlags.Ephemeral });
  }

  const targetUser = interaction.options.getUser('player', true);
  if (targetUser.bot) {
    return interaction.reply({ content: 'Cannot remove a bot account.', flags: MessageFlags.Ephemeral });
  }
  const reason = safeTruncate(interaction.options.getString('reason', true).trim(), 500);
  if (!reason) {
    return interaction.reply({ content: 'A reason is required.', flags: MessageFlags.Ephemeral });
  }

  if (!interaction.appPermissions?.has(PermissionFlagsBits.KickMembers)) {
    return interaction.reply({
      content: 'KRAKEN needs **Kick Members** permission in this server to run this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const warningEmbed = new EmbedBuilder()
    .setTitle('⚠️ Confirm: Emergency Member Removal')
    .setColor(0xed4245)
    .setDescription('This will **immediately kick this member from Discord**, mark them removed in KRAKEN, and clear their break/waitlist/tier state.\n\n**This cannot be undone.** If you are not sure what this does, click Cancel.')
    .addFields(
      { name: 'Player', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
      { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Reason', value: reason, inline: false },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recruit:removeConfirm:${targetUser.id}`).setLabel('Confirm — kick now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`recruit:removeCancel:${targetUser.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [warningEmbed], components: [row] });
}

export async function handleRemoveMemberConfirm(interaction, ctx, targetDiscordId) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({ content: 'Leaders only.', flags: MessageFlags.Ephemeral });
  }

  if (!interaction.appPermissions?.has(PermissionFlagsBits.KickMembers)) {
    return interaction.update({
      content: 'KRAKEN needs **Kick Members** permission in this server to run this command.',
      embeds: [],
      components: [],
    });
  }

  // Reason lives in the confirmation embed rather than a separate store — this button only
  // ever confirms the exact removal shown on the message it's attached to.
  const priorEmbed = interaction.message?.embeds?.[0];
  const reason = String(priorEmbed?.fields?.find(f => f.name === 'Reason')?.value ?? '').trim();
  const targetUser = await interaction.client.users.fetch(targetDiscordId).catch(() => null);
  if (!targetUser || !reason) {
    return interaction.update({ content: 'Could not recover the original removal request — run the command again.', embeds: [], components: [] });
  }

  await interaction.update({ content: 'Removing…', embeds: [], components: [] });

  const discordId = String(targetUser.id);
  const now = Date.now();

  // Hard-removal DB work happens BEFORE the kick. Discord fires GuildMemberRemove the
  // moment the kick lands, and that reactive handler already no-ops on status='removed'
  // (see src/index.js) — so setting this first guarantees the emergency path wins over
  // the normal soft grace-period logic, with no race between the two.
  const existingProfile = db.prepare('SELECT * FROM profiles WHERE discord_id = ?').get(discordId);
  const hadActiveBreak = Boolean(db.prepare('SELECT 1 FROM breaks WHERE discord_id = ?').get(discordId));
  const wasOnWaitlist = Boolean(db.prepare('SELECT 1 FROM waitlist WHERE discord_id = ?').get(discordId));

  if (existingProfile) {
    db.prepare('UPDATE profiles SET status = ?, last_verdict = ?, last_reasons = ?, updated_at = ? WHERE discord_id = ?')
      .run('removed', 'leader_emergency_removal', JSON.stringify([`LEADER_REMOVED: ${reason}`]), now, discordId);
  }
  db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
  clearUnderwatchState(db, discordId);
  clearProbationState(db, discordId);
  clearPostBreakEnforcement(db, discordId);
  removeFromWaitlist(db, discordId);

  // A fetch failure other than a confirmed "Unknown Member" (10007) is inconclusive,
  // not evidence they've already left — silently treating it as "gone" would skip the
  // role strip/kick below while still telling the leader "already gone, all clean."
  const { state: membershipState, member } = await confirmMemberGone(interaction.guild, discordId);
  let kickError = null;
  let roleCorrectionSkipped = false;
  if (member) {
    // Strip managed tier roles and apply the remove role BEFORE attempting the kick — not
    // just as a courtesy. If the kick itself fails (bot role hierarchy, missing permission
    // on this specific target, etc.) this is the only thing standing between "leader marked
    // them removed" and the evaluator's next run silently re-including them as an active
    // member, since it reads roles off whichever member is still actually present.
    try {
      const offboard = await applyRemovedRoleState({
        member,
        runtime,
        reason: `KRAKEN emergency removal by ${interaction.user.tag}: ${reason}`,
        db,
      });
      roleCorrectionSkipped = offboard?.skipped === 'remove-role-missing';
    } catch (e) {
      console.error(`[RECRUIT] Emergency role correction failed for <@${discordId}>:`, formatErrorForLog(e));
    }

    try {
      await member.kick(`KRAKEN emergency removal by ${interaction.user.tag}: ${reason}`);
    } catch (e) {
      kickError = formatErrorForLog(e);
      console.error(`[RECRUIT] Emergency kick failed for <@${discordId}>:`, kickError);
    }
  }

  // If the clan currently has space, offer it to the next person waiting —
  // independent of whether this specific member's CR tag is in the clan roster.
  let waitlistNotified = false;
  const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
  if (clanTag) {
    try {
      const clan = await getClan(clanTag);
      if (Array.isArray(clan?.memberList) && clan.memberList.length < 50) {
        await notifyNextWaiting(interaction.client, db, recruitGuildId);
        waitlistNotified = true;
      }
    } catch {
      // non-fatal — waitlist notification is best-effort
    }
  }

  const notes = [];
  if (existingProfile) notes.push(`had a profile (previous status: **${existingProfile.status}**) — marked removed`);
  if (hadActiveBreak) notes.push('had an active break — cleared');
  if (wasOnWaitlist) notes.push('was on the waitlist — cleared');
  if (waitlistNotified) notes.push('clan has space — next waitlist member notified');
  if (membershipState === 'gone') notes.push('was not found in the server (already gone) — DB state cleaned up anyway');
  if (membershipState === 'unknown') notes.push('⚠️ could not confirm Discord membership (fetch failed) — DB marked removed, but the role strip/kick could not be attempted; verify manually and re-run if they are still in the server');
  if (roleCorrectionSkipped) notes.push('⚠️ remove role is not configured — tier roles could not be stripped as a fallback; run /recruit-setup or configure roles.removeRoleId');
  if (kickError) notes.push(`⚠️ kick failed: ${kickError} — check bot role hierarchy, member may still be in the server`);

  const embed = new EmbedBuilder()
    .setTitle('🚨 KRAKEN — Emergency Member Removal')
    .setColor(kickError ? 0xfee75c : 0xed4245)
    .addFields(
      { name: 'Player', value: `<@${discordId}> (${targetUser.tag})`, inline: true },
      { name: 'Removed by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Kicked from Discord', value: member ? (kickError ? '❌ failed' : '✅ yes') : (membershipState === 'unknown' ? '⚠️ could not confirm' : 'already not in server'), inline: true },
      { name: 'Reason', value: reason, inline: false },
    )
    .setTimestamp();
  if (notes.length) embed.addFields({ name: 'Notes', value: notes.map(n => `• ${n}`).join('\n'), inline: false });
  embed.addFields({ name: 'Clan', value: 'This does not remove them from the Clash Royale clan — do that in-game if needed.', inline: false });

  await interaction.editReply({ embeds: [embed] });

  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const removalQueueChannelId = String(runtime?.channels?.removalQueueChannelId ?? '');
  await safeSendToChannel(interaction.client, removalQueueChannelId, embed, logsChannelId);
}

export async function handleRemoveMemberCancel(interaction) {
  return interaction.update({ content: 'Cancelled — no one was removed.', embeds: [], components: [] });
}
