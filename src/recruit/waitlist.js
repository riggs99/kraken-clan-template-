import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import {
  addToWaitlist,
  removeFromWaitlist,
  getWaitlist,
  getNextWaiting,
  confirmWaitlist,
  setPingedAt,
  getPlayersToPing,
  getPlayersToExpire,
  getActiveBreak,
  upsertActiveBreak,
  clearUnderwatchState,
  clearProbationState,
  clearPostBreakEnforcement,
  getRecruitRuntimeIds,
  getRecruitSetting,
  setRecruitSetting,
} from './db.js';
import { getClan } from '../cr-api.js';
import { suppressManualTierSync } from './manual-role-sync.js';
import { normalizePlayerTag } from '../util.js';
import { applyRolesVerified } from '../permissions.js';
import { loadRecruitConfig } from '../config/loadConfig.js';

function clanNameFromConfig() {
  return String(loadRecruitConfig()?.clanName ?? '').trim() || 'the clan';
}

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function buildInfoEmbed(queueSize) {
  return new EmbedBuilder()
    .setTitle('🐙 KRAKEN — Clan Waitlist')
    .setColor(0xf1c40f)
    .setDescription([
      "You're on our radar. When a spot opens in the clan, KRAKEN will DM the next person in line.",
      '',
      '**How it works:**',
      '• Spots are offered in the order you joined this list — first in, first offered.',
      '• Keep your DMs open so KRAKEN can reach you.',
      '• Every 7 days KRAKEN checks you\'re still interested. Click **Still Interested** below to stay on the list.',
      '• No reply within 48 hours removes you automatically.',
      '',
      queueSize > 0
        ? `**${queueSize} player${queueSize !== 1 ? 's' : ''} currently waiting.**`
        : '**No players currently waiting.**',
    ].join('\n'))
    .setFooter({ text: 'KRAKEN • fair queue — first joined, first offered' });
}

function buildConfirmButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('recruit:waitlist:confirm')
      .setLabel('✅ Still Interested')
      .setStyle(ButtonStyle.Success)
  );
}

// Posts or updates the info embed + confirm button in #waiting-list.
// recruitConfig may be null when called internally (guild check is skipped).
export async function ensureWaitlistPost(client, recruitConfig, db) {
  const runtime = getRecruitRuntimeIds(db);
  const channelId = String(runtime?.channels?.waitingListChannelId ?? '');
  if (!isValidDiscordId(channelId)) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (recruitGuildId && channel.guildId && channel.guildId !== recruitGuildId) return;

  const queueSize = getWaitlist(db).length;
  const embed = buildInfoEmbed(queueSize);
  const components = [buildConfirmButton()];

  const existingId = String(getRecruitSetting(db, 'messages.waitlistPanelId') ?? '');
  if (existingId) {
    const existing = await channel.messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }
  }

  const msg = await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch(() => null);
  if (msg?.id) {
    setRecruitSetting(db, 'messages.waitlistPanelId', msg.id);
    await msg.pin().catch(() => {});
  }
}

// Called after each player is removed from the clan.
// Finds the next person in line, DMs them, removes them from the DB,
// strips their waitlist role, and logs to the waiting-list channel.
export async function notifyNextWaiting(client, db, recruitGuildId) {
  const next = getNextWaiting(db);
  if (!next) return;

  const discordId = String(next.discord_id);

  // Atomic claim — check .changes so two concurrent evaluator runs can't both notify the same person.
  const claimed = db.prepare('DELETE FROM waitlist WHERE discord_id = ?').run(discordId);
  if (claimed.changes === 0) return;

  const runtime = getRecruitRuntimeIds(db);
  const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
  const waitingListChannelId = String(runtime?.channels?.waitingListChannelId ?? '');
  const logsChannelId = String(
    runtime?.channels?.logsChannelId ??
    runtime?.channels?.decisionsLogChannelId ?? ''
  );

  // Remove the waitlist role
  if (isValidDiscordId(recruitGuildId) && isValidDiscordId(waitlistRoleId)) {
    try {
      const guild = await client.guilds.fetch(recruitGuildId).catch(() => null);
      if (guild) {
        const gMember = await guild.members.fetch(discordId).catch(() => null);
        if (gMember?.roles.cache.has(waitlistRoleId)) {
          await gMember.roles.remove(waitlistRoleId, 'Slot offered — notified via DM').catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }

  // DM the member
  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (user) {
      await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('🐙 KRAKEN — A Clan Spot Has Opened')
          .setColor(0x57f287)
          .setDescription([
            '**A spot has opened in the KRAKEN clan.**',
            '',
            'You are next on the waitlist — this offer is yours.',
            '',
            '**What to do:**',
            '1. Join the KRAKEN clan in Clash Royale',
            '2. Head to the welcome channel in this server to complete your application',
            '',
            'If the clan looks full when you try to join, a removal may still be processing — try again shortly or contact a leader directly.',
          ].join('\n'))
          .setTimestamp()
          .setFooter({ text: 'KRAKEN • waitlist notification' }),
        ],
      });
    }
  } catch { /* ignore */ }

  const remaining = getWaitlist(db).length;

  if (isValidDiscordId(waitingListChannelId)) {
    const ch = await client.channels.fetch(waitingListChannelId).catch(() => null);
    if (ch?.send) {
      await ch.send({
        embeds: [new EmbedBuilder()
          .setTitle('Spot Offered')
          .setColor(0x57f287)
          .addFields(
            { name: 'Notified', value: `<@${discordId}>`, inline: true },
            { name: 'Queue remaining', value: String(remaining), inline: true },
          )
          .setTimestamp()
          .setFooter({ text: 'KRAKEN sent a DM — they have been offered the next available spot' }),
        ],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }

  if (isValidDiscordId(logsChannelId)) {
    const ch = await client.channels.fetch(logsChannelId).catch(() => null);
    if (ch?.send) {
      await ch.send({
        embeds: [new EmbedBuilder()
          .setTitle('Waitlist — Spot Notification Sent')
          .setColor(0x57f287)
          .addFields(
            { name: 'Member', value: `<@${discordId}>`, inline: true },
            { name: 'Queue remaining', value: String(remaining), inline: true },
          )
          .setTimestamp(),
        ],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }

  await ensureWaitlistPost(client, null, db).catch(() => {});
}

// Called from GuildMemberUpdate — detects waitlist role being added or removed manually.
export function handleWaitlistRoleChange(oldMember, newMember, db, waitlistRoleId) {
  if (!isValidDiscordId(String(waitlistRoleId ?? ''))) return;
  const hadRole = oldMember.roles.cache.has(waitlistRoleId);
  const hasRole = newMember.roles.cache.has(waitlistRoleId);
  if (!hadRole && hasRole) addToWaitlist(db, String(newMember.id));
  else if (hadRole && !hasRole) removeFromWaitlist(db, String(newMember.id));
}

// Called from GuildMemberAdd — auto-assigns waitlist role and DMs the new member with context.
export async function onMemberJoin(client, member, db) {
  if (!member?.id) return;
  const discordId = String(member.id);

  // Skip existing clan members who are rejoining the server — their profile will be re-synced by the evaluator.
  const existingProfile = db.prepare('SELECT status FROM profiles WHERE discord_id = ?').get(discordId);
  if (existingProfile && existingProfile.status !== 'removed') return;

  const runtime = getRecruitRuntimeIds(db);
  const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
  const waitingListChannelId = String(runtime?.channels?.waitingListChannelId ?? '');
  const newArrivalRoleId = String(runtime?.roles?.newArrivalRoleId ?? '');

  // Marks "hasn't applied yet" — independent of the waitlist question below.
  // apply.js strips this role the moment someone successfully applies.
  if (isValidDiscordId(newArrivalRoleId)) {
    await member.roles.add(newArrivalRoleId, 'New member joined — pending application').catch(() => {});
  }

  // Per-clan choice: auto-open queue (default, unchanged) vs leader-gated. When gated, a
  // leader manually assigns the waitlist role to approve someone — handleWaitlistRoleChange
  // (wired to GuildMemberUpdate) picks that up exactly the same way this auto-add does, so
  // the rest of the waitlist system (queue order, pings, offers) needs no other changes.
  const requiresApproval = Boolean(loadRecruitConfig()?.waitlistRequiresApproval);

  // DB first — role assignment also triggers addToWaitlist via GuildMemberUpdate, but ON CONFLICT DO NOTHING makes it safe.
  if (!requiresApproval) {
    addToWaitlist(db, discordId);
    if (isValidDiscordId(waitlistRoleId)) {
      await member.roles.add(waitlistRoleId, 'Auto-assigned on server join').catch(() => {});
    }
  }

  // Check clan capacity to send the right DM
  let clanFull = false;
  const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
  if (clanTag) {
    try {
      const clan = await getClan(clanTag);
      clanFull = Array.isArray(clan?.memberList) && clan.memberList.length >= 50;
    } catch { /* ignore */ }
  }

  const channelMention = isValidDiscordId(waitingListChannelId) ? `<#${waitingListChannelId}>` : '#waiting-list';
  const clanName = clanNameFromConfig();

  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (user) {
      const embed = clanFull
        ? new EmbedBuilder()
            .setTitle(requiresApproval ? '🐙 KRAKEN — Clan Full' : "🐙 KRAKEN — You're on the Waitlist")
            .setColor(0xf1c40f)
            .setDescription(requiresApproval ? [
              'Welcome to the KRAKEN server!',
              '',
              `The **${clanName}** clan is currently full.`,
              '',
              "Reach out to a leader if you'd like to be considered — they'll add you to the waitlist once approved. From there it's a fair queue, first approved, first offered.",
            ].join('\n') : [
              'Welcome to the KRAKEN server!',
              '',
              `The **${clanName}** clan is currently full, but you've been added to the waitlist.`,
              '',
              'When a spot opens, KRAKEN will DM you — spots are filled in the order players joined the list.',
              '',
              `Check ${channelMention} for updates. Every 7 days we'll check you're still interested — click **Still Interested** there to keep your place.`,
            ].join('\n'))
            .setFooter({ text: 'KRAKEN • waitlist' })
        : new EmbedBuilder()
            .setTitle('🐙 KRAKEN — Welcome!')
            .setColor(0x5865f2)
            .setDescription([
              'Welcome to the KRAKEN server!',
              '',
              `To get fully set up, you'll need to **join the ${clanName} clan in Clash Royale first**.`,
              '',
              'Once you\'re in the clan, head to the welcome channel to complete your application.',
              '',
              requiresApproval
                ? "If the clan's full when you're ready, ask a leader about the waitlist."
                : "You've been added to the waitlist in the meantime. Once you apply through the clan, your waitlist spot is no longer needed.",
            ].join('\n'))
            .setFooter({ text: 'KRAKEN • welcome' });

      await user.send({ embeds: [embed] }).catch(() => {});
    }
  } catch { /* ignore */ }

  await ensureWaitlistPost(client, null, db).catch(() => {});
}

// Button handler for recruit:waitlist:confirm
export async function handleWaitlistConfirm(interaction, db) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordId = String(interaction.user.id);
  const entry = db.prepare('SELECT discord_id FROM waitlist WHERE discord_id = ?').get(discordId);

  if (!entry) {
    return interaction.editReply({ content: "You're not currently on the waitlist." });
  }

  confirmWaitlist(db, discordId);
  return interaction.editReply({ content: "✅ You're still on the list! We'll check in again in 7 days. Keep your DMs open." });
}

// Scheduled check — expires non-responders and sends 7-day pings.
export async function processWaitlistChecks(client, db, recruitGuildId) {
  const clanName = clanNameFromConfig();
  const runtime = getRecruitRuntimeIds(db);
  const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
  const waitingListChannelId = String(runtime?.channels?.waitingListChannelId ?? '');
  const logsChannelId = String(
    runtime?.channels?.logsChannelId ??
    runtime?.channels?.decisionsLogChannelId ?? ''
  );
  const channelMention = isValidDiscordId(waitingListChannelId) ? `<#${waitingListChannelId}>` : '#waiting-list';

  // Step 1: Remove players who didn't respond within 48 hours of a weekly ping
  const toExpire = getPlayersToExpire(db);
  const guild = (isValidDiscordId(recruitGuildId) && isValidDiscordId(waitlistRoleId))
    ? await client.guilds.fetch(recruitGuildId).catch(() => null)
    : null;

  for (const entry of toExpire) {
    const discordId = String(entry.discord_id);
    removeFromWaitlist(db, discordId);

    if (guild) {
      try {
        const gMember = await guild.members.fetch(discordId).catch(() => null);
        if (gMember?.roles.cache.has(waitlistRoleId)) {
          await gMember.roles.remove(waitlistRoleId, 'Waitlist expired — no response within 48 hours').catch(() => {});
        }
      } catch { /* ignore */ }
    }

    try {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('🐙 KRAKEN — Removed from Waitlist')
            .setColor(0xed4245)
            .setDescription([
              `You've been removed from the **${clanName}** waitlist.`,
              '',
              "We sent a check-in 7 days ago but didn't hear back within 48 hours.",
              '',
              "If you're still interested, rejoin the KRAKEN server and you'll be added back to the end of the waitlist.",
            ].join('\n'))
            .setFooter({ text: 'KRAKEN • waitlist' })
          ],
        }).catch(() => {});
      }
    } catch { /* ignore */ }

    if (isValidDiscordId(logsChannelId)) {
      const ch = await client.channels.fetch(logsChannelId).catch(() => null);
      if (ch?.send) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setTitle('Waitlist — Player Expired')
            .setColor(0xed4245)
            .addFields({ name: 'Member', value: `<@${discordId}>`, inline: true })
            .setTimestamp()
            .setFooter({ text: 'Removed: no response to weekly check within 48 hours' })
          ],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    }
  }

  // Step 2: DM players who are 7+ days since joining/confirming and haven't been pinged yet this cycle
  const toPing = getPlayersToPing(db);
  for (const entry of toPing) {
    const discordId = String(entry.discord_id);
    setPingedAt(db, discordId, Date.now());

    try {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('🐙 KRAKEN — Weekly Waitlist Check-In')
            .setColor(0xf1c40f)
            .setDescription([
              `Are you still interested in joining the **${clanName}** clan?`,
              '',
              `Click **Still Interested** in ${channelMention} to stay on the waitlist.`,
              '',
              "⏳ **You have 48 hours to respond.** If we don't hear back, you'll be removed from the list automatically.",
              '',
              'Your position in the queue is preserved as long as you confirm.',
            ].join('\n'))
            .setFooter({ text: 'KRAKEN • waitlist check-in' })
          ],
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  }

  if (toExpire.length > 0 || toPing.length > 0) {
    console.log(`[WAITLIST] Processed: ${toExpire.length} expired, ${toPing.length} pinged`);
    await ensureWaitlistPost(client, null, db).catch(() => {});
  }
}

export const LEFT_SERVER_BREAK_REASON = 'left-server-auto';
const AUTO_BREAK_DAYS = 7;

// Called from GuildMemberRemove for members who have a non-removed profile.
// Checks if they're still in the clan and either grants an auto-break or marks them removed.
export async function handleMemberLeave(client, member, db, profile) {
  const discordId = String(member.id);
  const tag = String(profile.player_tag ?? '').replace(/^#/, '');
  const displayName = String(member.displayName ?? member.user?.username ?? tag ?? discordId);
  const recruitGuildId = String(member.guild?.id ?? '');

  const runtime = getRecruitRuntimeIds(db);
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const removalChannelId = String(
    runtime?.channels?.removalQueueChannelId ??
    runtime?.channels?.logsChannelId ??
    runtime?.channels?.decisionsLogChannelId ?? ''
  );

  // Three-state clan check: 'in' | 'out' | 'unknown'.
  // 'unknown' (API failure) falls back to the auto-break path — never mark someone
  // removed on a failed lookup; the daily evaluator will offboard them correctly later.
  let clanCheck = 'unknown';
  let clanHasSpace = false;
  const clanTag = String(process.env.CLAN_TAG ?? '').replace('#', '');
  if (clanTag && tag) {
    try {
      const clan = await getClan(clanTag);
      if (Array.isArray(clan?.memberList)) {
        const normalizedTag = normalizePlayerTag(tag);
        clanCheck = clan.memberList.some(m => normalizePlayerTag(m?.tag) === normalizedTag) ? 'in' : 'out';
        clanHasSpace = clan.memberList.length < 50;
      }
    } catch { /* ignore */ }
  }

  if (clanCheck === 'in' || clanCheck === 'unknown') {
    // Still in clan — grant a 7-day auto-break (only if no active break already)
    const existingBreak = getActiveBreak(db, discordId);
    if (!existingBreak) {
      upsertActiveBreak(db, {
        discordId,
        breakUntil: Date.now() + AUTO_BREAK_DAYS * 24 * 60 * 60 * 1000,
        reason: LEFT_SERVER_BREAK_REASON,
        grantedBy: 'KRAKEN',
      });
    }

    if (isValidDiscordId(logsChannelId)) {
      const ch = await client.channels.fetch(logsChannelId).catch(() => null);
      if (ch?.send) {
        const breakNote = existingBreak
          ? `Already on break until <t:${Math.floor(existingBreak.breakUntil / 1000)}:D> — existing break preserved`
          : `${AUTO_BREAK_DAYS}-day auto-break granted`;
        const clanNote = clanCheck === 'in'
          ? '✅ Still in clan'
          : '⚠️ Could not verify (CR API error) — treated as still in clan';
        await ch.send({
          embeds: [new EmbedBuilder()
            .setTitle('Member Left Server — Still in Clan')
            .setColor(0xfee75c)
            .addFields(
              { name: 'Player', value: `${displayName}${tag ? ` — #${tag}` : ''}`, inline: true },
              { name: 'Discord', value: `<@${discordId}>`, inline: true },
              { name: 'Clan', value: clanNote, inline: true },
              { name: 'Break', value: breakNote, inline: false },
              { name: 'Next step', value: 'Roles will be restored when they rejoin. If they don\'t return in time, KRAKEN escalates to underwatch then boot review.', inline: false },
            )
            .setTimestamp()
          ],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    }
  } else {
    // Confirmed left clan AND left server — remove from all tracking, boot review
    db.prepare('UPDATE profiles SET status = ?, updated_at = ? WHERE discord_id = ?')
      .run('removed', Date.now(), discordId);

    db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
    clearUnderwatchState(db, discordId);
    clearProbationState(db, discordId);
    clearPostBreakEnforcement(db, discordId);

    // Their departure freed a clan spot — offer it to the next person in line.
    // Skip if the roster shows the clan is still full (they weren't occupying a spot).
    if (clanHasSpace) {
      await notifyNextWaiting(client, db, recruitGuildId).catch(() => {});
    }

    if (isValidDiscordId(removalChannelId)) {
      const ch = await client.channels.fetch(removalChannelId).catch(() => null);
      if (ch?.send) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setTitle('Member Left Server — Not in Clan')
            .setColor(0xed4245)
            .addFields(
              { name: 'Player', value: `${displayName}${tag ? ` — #${tag}` : ''}`, inline: true },
              { name: 'Discord', value: `<@${discordId}>`, inline: true },
              { name: 'Clan', value: '❌ Not in clan', inline: true },
              { name: 'Action taken', value: 'Profile marked removed · all tracking cleared', inline: false },
              { name: 'Action needed', value: 'Confirm they have left the clan in Clash Royale. Remove in-game if still there.', inline: false },
            )
            .setTimestamp()
          ],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    }
  }
}

// Called from GuildMemberAdd for members who have a non-removed profile.
// Restores their roles and clears the auto-break if they were away.
export async function handleMemberReturn(client, member, db, profile) {
  const discordId = String(member.id);
  const runtime = getRecruitRuntimeIds(db);
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');
  const warcoreRoleId = String(runtime?.roles?.warcoreRoleId ?? '');
  const probationRoleId = String(runtime?.roles?.probationRoleId ?? '');
  const underwatchRoleId = String(runtime?.roles?.underwatchRoleId ?? '');
  const onBreakRoleId = String(runtime?.roles?.onBreakRoleId ?? '');

  const status = String(profile.status ?? 'probation');
  const tag = String(profile.player_tag ?? '').replace(/^#/, '');
  const displayName = String(member.displayName ?? member.user?.username ?? tag ?? discordId);

  // Suppress the manual-tier-sync handler so role additions below don't trigger DB updates
  suppressManualTierSync(db, discordId, 30_000);

  // Read the raw break row (not getActiveBreak) so an EXPIRED left-server-auto break is
  // still detected and cleaned up — otherwise post-break enforcement would escalate a
  // member who already returned.
  const rawBreak = db.prepare('SELECT break_until, reason FROM breaks WHERE discord_id = ?').get(discordId);
  const isAutoBreak = String(rawBreak?.reason ?? '') === LEFT_SERVER_BREAK_REASON;
  const hasActiveRegularBreak = !isAutoBreak && rawBreak && Number(rawBreak.break_until ?? 0) > Date.now();

  if (isAutoBreak) {
    // Returned — clear the auto-break (active or expired) and any enforcement it spawned.
    db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(discordId);
    clearPostBreakEnforcement(db, discordId);
  }

  // Restore base member role + tier role from profile status in every case —
  // Discord drops all roles when a member leaves, and the I'm Back button
  // only removes the on-break role (it assumes tier roles were never lost).
  // applyRolesVerified checks the mutation against the actual resulting role
  // cache instead of assuming success — a silently-swallowed role add here
  // used to tell the returning member "your roles have been restored"
  // regardless of whether that was actually true.
  const tierRoleId = (status === 'warcore' || status === 'approved')
    ? warcoreRoleId
    : status === 'underwatch'
      ? underwatchRoleId
      : probationRoleId;
  const rolesToRestore = [memberRoleId, tierRoleId];
  if (hasActiveRegularBreak) rolesToRestore.push(onBreakRoleId); // also restore break-channel access

  const { ok: rolesRestored, missingAdds } = await applyRolesVerified(member, {
    add: rolesToRestore,
    reason: 'KRAKEN: returning member role restore',
  });
  const restoredNote = rolesRestored
    ? ' Your roles have been restored.'
    : ' KRAKEN is restoring your roles — a leader has been notified if anything didn\'t apply.';

  if (hasActiveRegularBreak) {
    try {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user) {
        const breakEnds = Math.floor(Number(rawBreak.break_until) / 1000);
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('🐙 KRAKEN — Welcome Back!')
            .setColor(0xfee75c)
            .setDescription([
              `Welcome back, **${displayName}**!${restoredNote}`,
              '',
              `Your break is still active — it ends <t:${breakEnds}:D>.`,
              '',
              'Head to **#on-a-break** to manage your break or click **I\'m Back** when you\'re ready to return to war duty.',
            ].join('\n'))
            .setTimestamp()
          ],
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  } else {
    try {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle('🐙 KRAKEN — Welcome Back!')
            .setColor(0x57f287)
            .setDescription([
              `Welcome back, **${displayName}**!${restoredNote}`,
              '',
              'KRAKEN will resume evaluating you as soon as the current war week closes.',
            ].join('\n'))
            .setTimestamp()
          ],
        }).catch(() => {});
      }
    } catch { /* ignore */ }
  }

  if (isValidDiscordId(logsChannelId)) {
    const ch = await client.channels.fetch(logsChannelId).catch(() => null);
    if (ch?.send) {
      const embed = new EmbedBuilder()
        .setTitle('Member Returned to Server')
        .setColor(rolesRestored ? 0x57f287 : 0xfee75c)
        .addFields(
          { name: 'Player', value: `${displayName}${tag ? ` — #${tag}` : ''}`, inline: true },
          { name: 'Discord', value: `<@${discordId}>`, inline: true },
          { name: 'Status', value: status, inline: true },
          { name: 'Break', value: isAutoBreak ? 'Auto-break cleared — roles restored' : hasActiveRegularBreak ? 'Active break continued — break role restored' : 'No break', inline: false },
        )
        .setTimestamp();
      if (!rolesRestored) {
        embed.addFields({ name: '⚠️ Role restore incomplete', value: `Missing: ${missingAdds.join(', ')} — verify manually.`, inline: false });
      }
      await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
}
