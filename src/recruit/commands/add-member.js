import { MessageFlags } from 'discord.js';
import { normalizePlayerTag } from '../../util.js';
import { getRecruitRuntimeIds, removeFromWaitlist } from '../db.js';
import { suppressManualTierSync } from '../manual-role-sync.js';
import { formatErrorForLog } from '../../security.js';
import { verifyTagInCurrentClan, upsertProfile, resetRelinkTrackingState } from './apply.js';
import { isLeaderOrAdmin, applyRolesVerified } from '../../permissions.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../../dashboard-components.js';
import { sendWelcomeGuideDm } from '../welcome-guide.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

async function safeSendToChannel(client, channelId, payload, fallbackChannelId) {
  for (const id of [channelId, fallbackChannelId]) {
    if (!isValidDiscordId(String(id ?? '')) || String(id) === '') continue;
    try {
      const ch = await client.channels.fetch(String(id));
      if (ch?.send) {
        await ch.send(payload);
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

export const command = {
  name: 'recruit-add-member',
  description: 'Leader override: manually add a member to the clan on probation (ops channel only)',
  options: [
    { name: 'player', description: 'Discord member to add', type: 6, required: true },
    { name: 'tag', description: 'Their Clash Royale player tag (with or without #)', type: 3, required: true },
  ],
};

export async function handleAddMember(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({ content: 'Only leaders/admin can run this.', flags: MessageFlags.Ephemeral });
  }

  const opsChannelId = String(runtime?.channels?.opsChannelId ?? '');
  if (opsChannelId && interaction.channelId !== opsChannelId) {
    return interaction.reply({ content: 'Use this in the ops channel only.', flags: MessageFlags.Ephemeral });
  }

  const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');
  const probationRoleId = String(runtime?.roles?.probationRoleId ?? '');
  if (!isValidDiscordId(memberRoleId) || !isValidDiscordId(probationRoleId)) {
    return interaction.reply({
      content: 'Recruit is not set up yet (missing role IDs). Run `/recruit-setup`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const targetUser = interaction.options.getUser('player', true);
  if (targetUser.bot) {
    return interaction.reply({ content: 'Cannot add a bot account.', flags: MessageFlags.Ephemeral });
  }

  const rawTag = interaction.options.getString('tag', true);
  const tag = normalizePlayerTag(rawTag);
  if (!tag || tag.length < 3) {
    return interaction.reply({ content: 'Invalid tag. Provide a real player tag.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const clanVerification = await verifyTagInCurrentClan(tag);
  if (!clanVerification.ok) {
    const message = clanVerification.code === 'TAG_NOT_IN_CLAN'
      ? `**#${tag}** is not in the current ${String(recruitConfig?.clanName ?? '').trim() || 'clan'} roster. Add them in-game first, then run this again.`
      : 'KRAKEN could not verify that tag against the current clan roster. Try again shortly.';
    return interaction.editReply({ content: message });
  }

  const discordId = String(targetUser.id);

  const clashConflict = db.prepare('SELECT discord_id FROM profiles WHERE player_tag = ? AND discord_id != ?').get(tag, discordId);
  if (clashConflict?.discord_id) {
    return interaction.editReply({
      content: `**#${tag}** is already linked to <@${clashConflict.discord_id}>. Clean up the old link before adding this member.`,
    });
  }

  const member = await interaction.guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `<@${discordId}> is not a member of this server.` });
  }

  const now = Date.now();
  const existing = db.prepare('SELECT * FROM profiles WHERE discord_id = ?').get(discordId);
  const hadExistingProfile = Boolean(existing);
  const wasOnWaitlist = Boolean(db.prepare('SELECT 1 FROM waitlist WHERE discord_id = ?').get(discordId));

  const activeBreakRow = db.prepare('SELECT 1 FROM breaks WHERE discord_id = ?').get(discordId);
  resetRelinkTrackingState(db, discordId, { preserveBreaks: false });

  upsertProfile(db, {
    discord_id: discordId,
    player_tag: tag,
    region: existing?.region ?? null,
    timezone: existing?.timezone ?? null,
    status: 'probation',
    last_score: null,
    last_verdict: 'leader_override',
    last_reasons: JSON.stringify(['LEADER_ADD_OVERRIDE']),
    cooldown_until: 0,
    probation_until: null,
    created_at: Number(existing?.created_at ?? now) || now,
    updated_at: now,
  });

  let roleGrantOk = false;
  let roleGrantDetail = null;
  try {
    const warcoreRoleId = String(runtime?.roles?.warcoreRoleId ?? '');
    const underwatchRoleId = String(runtime?.roles?.underwatchRoleId ?? '');
    const newArrivalRoleId = String(runtime?.roles?.newArrivalRoleId ?? '');
    const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
    const onBreakRoleId = String(runtime?.roles?.onBreakRoleId ?? '');
    const removeRoleId = String(runtime?.roles?.removeRoleId ?? '');

    // onBreakRoleId must be stripped here too — resetRelinkTrackingState (called above with
    // preserveBreaks: false) already clears any break from the DB, so leaving the Discord
    // role behind would show "on a break" on someone KRAKEN now considers freshly onboarded.
    // removeRoleId must be stripped too — nothing else in the codebase ever clears it once
    // applied (evaluator.js only ever adds it), so a previously-removed member leader-added
    // back in would otherwise wear "remove" + "member" + "probation" simultaneously forever.
    const remove = [warcoreRoleId, underwatchRoleId, newArrivalRoleId, waitlistRoleId, onBreakRoleId, removeRoleId];
    const add = [memberRoleId, probationRoleId];

    suppressManualTierSync(db, discordId);
    // applyRolesVerified checks the mutation against the actual resulting role
    // cache instead of assuming success — the leader-facing summary and the
    // target member's DM both used to unconditionally claim "roles granted"
    // even when the grant may not have actually stuck.
    const result = await applyRolesVerified(member, { add, remove, reason: `KRAKEN leader override: added by ${interaction.user.tag}` });
    roleGrantOk = result.ok;
    if (!roleGrantOk) {
      roleGrantDetail = `missing: ${result.missingAdds.join(', ') || 'none'}${result.missingRemoves.length ? `; still has: ${result.missingRemoves.join(', ')}` : ''}`;
    }
  } catch (e) {
    roleGrantDetail = formatErrorForLog(e);
    console.error(`[RECRUIT] Leader-override role grant failed for <@${discordId}> (#${tag}):`, roleGrantDetail);
  }

  removeFromWaitlist(db, discordId);

  const displayName = clanVerification.memberName ?? targetUser.globalName ?? targetUser.username;
  // Role-grant failure is the priority information — send it unconditionally rather
  // than gating it behind the welcome-guide DM's own success/failure (a member whose
  // roles didn't apply needs to know regardless of whether the guide DM went out).
  if (!roleGrantOk) {
    try {
      await targetUser.send({
        content: [
          `You have been added to KRAKEN by a leader (<@${interaction.user.id}>).`,
          'KRAKEN could not confirm your Discord roles were fully applied — a leader has been notified to check this.',
          'You stay on **probation** through your first full war week.',
        ].join('\n'),
      });
    } catch {
      // DMs disabled — not fatal
    }
  } else {
    const { sent, alreadySent } = await sendWelcomeGuideDm(targetUser, runtime, recruitConfig, db, { displayName });
    // alreadySent means nothing was attempted this call (a returning member who got
    // the guide during an earlier stint) — that's not a DM failure, so no fallback
    // claiming one is warranted.
    if (!sent && !alreadySent) {
      try {
        await targetUser.send({
          content: [
            `You have been added to KRAKEN by a leader (<@${interaction.user.id}>).`,
            'Roles granted: **kraken-member** + **probation**.',
            'You stay on **probation** through your first full war week.',
            'KRAKEN reviews roles automatically as soon as the current war week closes.',
            'WARCORE requires a perfect **32/32** across **2 complete wars**.',
            '',
            '_I couldn\'t DM you the full welcome guide — check your privacy settings or ask a leader for the pinned post._',
          ].join('\n'),
        });
      } catch {
        // DMs disabled — not fatal
      }
    }
  }

  const notes = [];
  if (hadExistingProfile) notes.push(`had an existing profile (previous status: **${existing.status}**) — reset to probation`);
  if (wasOnWaitlist) notes.push('was on the waitlist — cleared');
  if (activeBreakRow) notes.push('had an active break — cleared');
  if (!roleGrantOk) notes.push(`⚠️ role grant incomplete: ${roleGrantDetail} — check bot role hierarchy`);

  const container = buildDashboardContainer({
    accentColor: !roleGrantOk ? STATUS_COLORS.warn : STATUS_COLORS.healthy,
    thumbnailUrl: CLAN_BADGE_URL,
    header: '## 🐙 KRAKEN — Leader Override: Member Added',
    blocks: [
      [
        `**Player:** ${clanVerification.memberName ?? tag} — #${tag}`,
        `**Discord:** <@${discordId}>`,
        `**Added by:** <@${interaction.user.id}>`,
        `**Status:** probation`,
        `**When:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      ].join('\n'),
      ...(notes.length ? [`**Notes:**\n${notes.map(n => `• ${n}`).join('\n')}`] : []),
    ],
  });

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };

  await interaction.editReply(payload);

  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const decisionsChannelId = String(runtime?.channels?.decisionsChannelId ?? '');
  await safeSendToChannel(interaction.client, decisionsChannelId, payload, logsChannelId);
}
