import { PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, setRecruitSetting } from '../db.js';
import { ensureWelcomePost } from '../onboarding.js';
import { ensureBreakPost } from '../breaks.js';
import { isServerOwner } from '../../permissions.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

export const command = {
  name: 'recruit-setup',
  description: 'One-time setup for Recruit HQ (creates channels/roles and stores IDs)',
};

async function requireOwnerOrAdmin(interaction) {
  if (await isServerOwner(interaction)) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

async function enforceHoist(role, hoist) {
  if (role && role.hoist !== hoist) {
    try {
      await role.setHoist(hoist, 'KRAKEN Recruit setup: role display grouping');
    } catch {
      // ignore hoist update failures
    }
  }
  return role;
}

async function findOrCreateRole(guild, name, hoist = false) {
  const existing = guild.roles.cache.find(r => r.name === name) ?? null;
  if (existing) return enforceHoist(existing, hoist);
  return guild.roles.create({ name, mentionable: false, hoist, reason: 'KRAKEN Recruit setup' });
}

function rolesWithModPowers(guild) {
  return guild.roles.cache
    .filter(r => r.permissions?.has(PermissionFlagsBits.Administrator) || r.permissions?.has(PermissionFlagsBits.ManageGuild))
    .map(r => r.id);
}

async function findOrCreateTextChannel(guild, name, overwrites, parentId) {
  const existing = guild.channels.cache.find(c => c?.type === ChannelType.GuildText && c?.name === name) ?? null;
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    reason: 'KRAKEN Recruit setup'
  });
}

async function findOrCreateCategory(guild, name, overwrites) {
  const existing = guild.channels.cache.find(c => c?.type === ChannelType.GuildCategory && c?.name === name) ?? null;
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: 'KRAKEN Recruit setup'
  });
}

function findTextChannelByPrefix(guild, prefix) {
  const p = String(prefix ?? '').toLowerCase();
  if (!p) return null;
  return guild.channels.cache.find(c =>
    c?.type === ChannelType.GuildText && typeof c?.name === 'string' && c.name.toLowerCase().startsWith(p)
  ) ?? null;
}

async function resolveTextChannelById(guild, channelId) {
  const id = String(channelId ?? '');
  if (!isValidDiscordId(id)) return null;
  const cached = guild.channels.cache.get(id) ?? null;
  if (cached?.type === ChannelType.GuildText) return cached;
  try {
    const fetched = await guild.channels.fetch(id);
    return fetched?.type === ChannelType.GuildText ? fetched : null;
  } catch {
    return null;
  }
}

async function resolveRoleById(guild, roleId) {
  const id = String(roleId ?? '');
  if (!isValidDiscordId(id)) return null;
  const cached = guild.roles.cache.get(id) ?? null;
  if (cached) return cached;
  try {
    return await guild.roles.fetch(id);
  } catch {
    return null;
  }
}

// Prefer the role/channel this server was provisioned with last time, looked up by the ID
// stored in SQLite — never by name. A name-only lookup silently reassigns the wrong channel
// (with its existing message history) if a default name ever changes between template
// versions; keying off the stored ID makes a rename affect only genuine first-time setups.
async function findOrCreateRoleByIdOrName(guild, storedId, name, hoist = false) {
  const byId = await resolveRoleById(guild, storedId);
  if (byId) return enforceHoist(byId, hoist);
  return findOrCreateRole(guild, name, hoist);
}

async function findOrCreateTextChannelByIdOrName(guild, storedId, name, overwrites, parentId) {
  return (await resolveTextChannelById(guild, storedId)) ?? findOrCreateTextChannel(guild, name, overwrites, parentId);
}

export async function handleSetup(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const allowed = await requireOwnerOrAdmin(interaction);
  if (!allowed) {
    return interaction.reply({ content: 'Only the server owner or an admin can run this.', flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Guild not available.', flags: MessageFlags.Ephemeral });

  if (!interaction.appPermissions?.has(PermissionFlagsBits.ManageChannels) || !interaction.appPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: 'KRAKEN needs **Manage Channels** and **Manage Roles** in this server to run setup.',
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = getRecruitRuntimeIds(db);
  const alreadyConfigured =
    isValidDiscordId(existing?.channels?.welcomeChannelId ?? '') &&
    isValidDiscordId(existing?.channels?.decisionsLogChannelId ?? '') &&
    isValidDiscordId(existing?.roles?.memberRoleId ?? '') &&
    isValidDiscordId(existing?.roles?.probationRoleId ?? '');

  // hoist: true = shown as its own group in the member sidebar. We hoist standing/tier roles
  // (leaders + the tier ladder + probation + on-a-break) so a clan's standings read at a glance,
  // and leave the operational gate/exit roles (new-arrival, remove) ungrouped to avoid clutter.
  const roleProbation = await findOrCreateRoleByIdOrName(guild, existing?.roles?.probationRoleId, 'probation', true);

  // War Hub core roles (chat + war standard + probation overlay)
  // Gate role: invite can grant this so new arrivals only see #welcome until they agree.
  const roleNewArrival = await findOrCreateRoleByIdOrName(guild, existing?.roles?.newArrivalRoleId, 'new-arrival');
  const roleMember = await findOrCreateRoleByIdOrName(guild, existing?.roles?.memberRoleId, 'kraken-member', true);
  const roleWarcore = await findOrCreateRoleByIdOrName(guild, existing?.roles?.warcoreRoleId, 'kraken-warcore', true);
  const roleUnderwatch = await findOrCreateRoleByIdOrName(guild, existing?.roles?.underwatchRoleId, 'kraken-underwatch', true);
  const roleOnBreak = await findOrCreateRoleByIdOrName(guild, existing?.roles?.onBreakRoleId, 'on a break', true);
  const roleRemove = await findOrCreateRoleByIdOrName(guild, existing?.roles?.removeRoleId, 'remove');

  // Leaders role (permission gate for war hub controls)
  const roleLeaders = await findOrCreateRoleByIdOrName(guild, existing?.roles?.leadersRoleId, 'leaders', true);

  const modRoleIds = rolesWithModPowers(guild);

  const everyoneId = guild.roles.everyone.id;
  const botId = interaction.client.user.id;

  // Created up front so every leader-only channel below can be parented into it at creation
  // time, instead of a leader having to drag channels into a category by hand afterward —
  // that drag defaults to syncing (and silently overwriting) the channel's explicit overwrites.
  const leadersOnlyOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const leadersCategory = await findOrCreateCategory(guild, 'leaders', leadersOnlyOverwrites);

  const decisionsOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    // modRoleIds (existing Administrator/Manage Server roles) keep access too, alongside
    // the leaders role above — filtered so a role that's both doesn't get a duplicate
    // overwrite entry, which Discord's API rejects.
    ...modRoleIds.filter(id => id !== roleLeaders.id).map(id => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    }))
  ];
 
  // Public landing channel: readable by everyone, writable only by KRAKEN (+ leaders).
  const welcomeOverwrites = [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  const welcomeChannel = await findOrCreateTextChannelByIdOrName(guild, existing?.channels?.welcomeChannelId, 'welcome', welcomeOverwrites);
  try {
    // Enforce overwrites even if the channel already existed (prevents modal submit "Something went wrong" due to bot lacking SendMessages).
    if (welcomeChannel?.permissionOverwrites?.set) {
      await welcomeChannel.permissionOverwrites.set(welcomeOverwrites, 'KRAKEN Recruit setup: enforce welcome permissions');
    }
  } catch {
    // ignore overwrite update failures
  }
  const configuredDecisionsId = String(recruitConfig?.channels?.decisionsChannelId ?? '');
  const configuredDecisionsChannel = await resolveTextChannelById(guild, configuredDecisionsId);
  const decisionsChannel = configuredDecisionsChannel ?? await findOrCreateTextChannelByIdOrName(guild, existing?.channels?.decisionsChannelId, 'kraken-decisions-leaders', decisionsOverwrites, leadersCategory.id);

  // Public read-only channel for daily KRAKEN decisions (no pings).
  const publicDecisionsConfiguredId = String(recruitConfig?.channels?.publicDecisionsChannelId ?? '');
  const publicDecisionsConfigured = await resolveTextChannelById(guild, publicDecisionsConfiguredId);
  const publicDecisionsOverwrites = [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  // Resolve the public channel by: configured ID > stored ID > a name match that is ALREADY
  // public > a fresh channel. A name match that currently hides itself from @everyone is NEVER
  // adopted — it would be an old leaders-only "kraken-decisions" from before the public/private
  // split, and the re-affirm below would flip it public and leak its entire decision history to
  // every member. In that case we create a fresh public channel and leave the private one alone.
  let publicDecisionsChannel = publicDecisionsConfigured
    ?? await resolveTextChannelById(guild, existing?.channels?.publicDecisionsChannelId);
  if (!publicDecisionsChannel) {
    const byName = guild.channels.cache.find(c => c?.type === ChannelType.GuildText && c?.name === 'kraken-decisions') ?? null;
    const byNameHidesEveryone = Boolean(byName?.permissionOverwrites?.cache?.get(everyoneId)?.deny?.has(PermissionFlagsBits.ViewChannel));
    publicDecisionsChannel = (byName && !byNameHidesEveryone)
      ? byName
      : await guild.channels.create({ name: 'kraken-decisions', type: ChannelType.GuildText, permissionOverwrites: publicDecisionsOverwrites, reason: 'KRAKEN Recruit setup' });
  }
  try {
    // Safe to re-affirm public overwrites + top-level placement now: publicDecisionsChannel is
    // always either our own channel (resolved by ID), an already-public name match, or freshly
    // created — never a currently-private channel.
    if (publicDecisionsChannel?.permissionOverwrites?.set) {
      await publicDecisionsChannel.permissionOverwrites.set(publicDecisionsOverwrites, 'KRAKEN Recruit setup: enforce kraken-decisions (public) permissions');
    }
    if (!publicDecisionsConfigured && publicDecisionsChannel?.parentId !== null) {
      await publicDecisionsChannel.setParent(null, { lockPermissions: false, reason: 'KRAKEN Recruit setup: kraken-decisions is public, not a leaders-only channel' });
    }
  } catch {
    // ignore overwrite update failures
  }

  // Public break request channel (read-only panel; breaks start immediately and leaders acknowledge in decisions).
  const breakOverwrites = [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const onBreakChannel = await findOrCreateTextChannelByIdOrName(guild, existing?.channels?.onBreakChannelId, 'on-a-break', breakOverwrites);
  try {
    // Ensure overwrites are correct even if the channel already existed (fixes "Missing Access" after re-invite/role changes).
    if (onBreakChannel?.permissionOverwrites?.set) {
      await onBreakChannel.permissionOverwrites.set(breakOverwrites, 'KRAKEN Recruit setup: enforce on-a-break permissions');
    }
  } catch {
    // ignore overwrite update failures
  }

  // Leaders-only ops + logs channels (no pings; operators use these as control surface)
  const opsChannel =
    (await resolveTextChannelById(guild, existing?.channels?.opsChannelId)) ??
    findTextChannelByPrefix(guild, 'kraken-ops') ??
    await findOrCreateTextChannel(guild, 'kraken-ops', leadersOnlyOverwrites, leadersCategory.id);
  const logsChannel = await findOrCreateTextChannelByIdOrName(guild, existing?.channels?.logsChannelId, 'logs', leadersOnlyOverwrites, leadersCategory.id);
  const configuredRemovalQueueId = String(recruitConfig?.channels?.removalQueueChannelId ?? '');
  const configuredRemovalQueueChannel = await resolveTextChannelById(guild, configuredRemovalQueueId);
  const removalQueueChannel =
    configuredRemovalQueueChannel ??
    (await resolveTextChannelById(guild, existing?.channels?.removalQueueChannelId)) ??
    findTextChannelByPrefix(guild, 'remov') ??
    findTextChannelByPrefix(guild, 'kick') ??
    await findOrCreateTextChannel(guild, 'removal-queue', leadersOnlyOverwrites, leadersCategory.id);
  try {
    // Enforce leader-only visibility even if channels already existed (prevents new members from landing here).
    if (opsChannel?.permissionOverwrites?.set) {
      await opsChannel.permissionOverwrites.set(leadersOnlyOverwrites, 'KRAKEN Recruit setup: enforce kraken-ops permissions');
    }
    if (logsChannel?.permissionOverwrites?.set) {
      await logsChannel.permissionOverwrites.set(leadersOnlyOverwrites, 'KRAKEN Recruit setup: enforce logs permissions');
    }
    if (removalQueueChannel?.permissionOverwrites?.set) {
      await removalQueueChannel.permissionOverwrites.set(leadersOnlyOverwrites, 'KRAKEN Recruit setup: enforce removal queue permissions');
    }
    // lockPermissions: false is required — setParent defaults to syncing (overwriting) a
    // channel's permissions to match its new category, which would wipe the explicit
    // overwrites just (re-)enforced above.
    const reparentReason = 'KRAKEN Recruit setup: group under leaders category';
    if (opsChannel?.parentId !== leadersCategory.id) {
      await opsChannel.setParent(leadersCategory.id, { lockPermissions: false, reason: reparentReason });
    }
    if (logsChannel?.parentId !== leadersCategory.id) {
      await logsChannel.setParent(leadersCategory.id, { lockPermissions: false, reason: reparentReason });
    }
    if (removalQueueChannel?.parentId !== leadersCategory.id) {
      await removalQueueChannel.setParent(leadersCategory.id, { lockPermissions: false, reason: reparentReason });
    }
    if (!configuredDecisionsChannel && decisionsChannel?.parentId !== leadersCategory.id) {
      await decisionsChannel.setParent(leadersCategory.id, { lockPermissions: false, reason: reparentReason });
    }
  } catch {
    // ignore overwrite update failures
  }

  setRecruitSetting(db, 'channels.opsChannelId', opsChannel.id);
  setRecruitSetting(db, 'channels.logsChannelId', logsChannel.id);
  setRecruitSetting(db, 'channels.decisionsChannelId', decisionsChannel.id);
  setRecruitSetting(db, 'channels.publicDecisionsChannelId', publicDecisionsChannel.id);
  setRecruitSetting(db, 'channels.welcomeChannelId', welcomeChannel.id);
  // We run onboarding and applications from #welcome (panel + modal).
  setRecruitSetting(db, 'channels.applyChannelId', welcomeChannel.id);
  // General logs go to #logs; high-signal mod decisions can use channels.decisionsChannelId.
  setRecruitSetting(db, 'channels.decisionsLogChannelId', logsChannel.id);
  setRecruitSetting(db, 'channels.onBreakChannelId', onBreakChannel.id);
  setRecruitSetting(db, 'channels.removalQueueChannelId', removalQueueChannel.id);

  // Optional member chat channel (baseline clan member chat).
  const configuredMemberChatId = String(recruitConfig?.channels?.memberChatChannelId ?? '');
  const memberChatChannel = configuredMemberChatId
    ? (guild.channels.cache.get(configuredMemberChatId) ?? null)
    : ((await resolveTextChannelById(guild, existing?.channels?.memberChatChannelId)) ?? findTextChannelByPrefix(guild, 'general') ?? null);
  if (memberChatChannel?.id) {
    setRecruitSetting(db, 'channels.memberChatChannelId', memberChatChannel.id);
  }
  setRecruitSetting(db, 'roles.leadersRoleId', roleLeaders.id);
  setRecruitSetting(db, 'roles.memberRoleId', roleMember.id);
  setRecruitSetting(db, 'roles.warcoreRoleId', roleWarcore.id);
  setRecruitSetting(db, 'roles.underwatchRoleId', roleUnderwatch.id);
  setRecruitSetting(db, 'roles.newArrivalRoleId', roleNewArrival.id);
  setRecruitSetting(db, 'roles.onBreakRoleId', roleOnBreak.id);
  setRecruitSetting(db, 'roles.probationRoleId', roleProbation.id);
  setRecruitSetting(db, 'roles.removeRoleId', roleRemove.id);

  // Post/pin the welcome embed so new arrivals see what to do.
  try {
    await ensureWelcomePost(interaction.client, recruitConfig, db);
  } catch {
    // ignore
  }
  try {
    await ensureBreakPost(interaction.client, recruitConfig, db);
  } catch {
    // ignore
  }

  // Order the kraken roles so the hoisted groups read top-down (leaders, then the tier ladder)
  // in the member sidebar — otherwise freshly created roles pile up in creation order. Only the
  // kraken roles the bot can manage (r.editable = below the bot + Manage Roles) are touched, and
  // they're reassigned strictly among the position slots they ALREADY occupy — so no other role
  // (e.g. a moderator role) is ever displaced downward, and positions can't collapse onto each
  // other. Purely cosmetic — never block setup.
  try {
    const orderedTopToBottom = [roleLeaders, roleWarcore, roleMember, roleUnderwatch, roleProbation, roleOnBreak, roleNewArrival, roleRemove]
      .filter(role => role?.editable);
    if (orderedTopToBottom.length > 1) {
      const slotsHighToLow = orderedTopToBottom.map(role => role.position).sort((a, b) => b - a);
      await guild.roles.setPositions(orderedTopToBottom.map((role, i) => ({ role: role.id, position: slotsHighToLow[i] })));
    }
  } catch {
    // ignore ordering failures — cosmetic only
  }

  // Verify the bot can actually assign every role it manages. Discord only lets a bot grant
  // roles positioned below its own highest role, and forbids it from moving its own role up —
  // so if a managed role sits above the bot (pre-existed higher, or an admin dragged it up),
  // onboarding's role grants silently fail. Surface it now with an exact fix rather than
  // letting /apply break later for a non-technical owner with no clue why.
  const botHighestPosition = guild.members.me?.roles?.highest?.position ?? 0;
  const botRoleName = guild.members.me?.roles?.botRole?.name ?? 'the bot';
  // roleLeaders is included: the bot auto-grants it to in-game co-leaders/leaders on /apply,
  // so it must sit below the bot too — otherwise that grant silently fails.
  const unassignableRoleNames = [roleNewArrival, roleMember, roleWarcore, roleUnderwatch, roleProbation, roleOnBreak, roleRemove, roleLeaders]
    .filter(r => r.position >= botHighestPosition)
    .map(r => r.name);

  const msg = [
    '✅ Recruit HQ setup complete.',
    '',
    `Channels:`,
    `- welcome: <#${welcomeChannel.id}>`,
    `- kraken-decisions-leaders: <#${decisionsChannel.id}>`,
    `- kraken-decisions: <#${publicDecisionsChannel.id}>`,
    `- on-a-break: <#${onBreakChannel.id}>`,
    `- kraken-ops: <#${opsChannel.id}>`,
    `- logs: <#${logsChannel.id}>`,
    `- removal-queue: <#${removalQueueChannel.id}>`,
    '',
    `Roles:`,
    `- probation: <@&${roleProbation.id}>`,
    `- new-arrival: <@&${roleNewArrival.id}>`,
    `- kraken-member: <@&${roleMember.id}>`,
    `- kraken-warcore: <@&${roleWarcore.id}>`,
    `- kraken-underwatch: <@&${roleUnderwatch.id}>`,
    `- on a break: <@&${roleOnBreak.id}>`,
    `- remove: <@&${roleRemove.id}>`,
    `- leaders: <@&${roleLeaders.id}>`,
    '',
    ...(unassignableRoleNames.length > 0
      ? [
          `⚠️ **Action needed:** the bot can't assign these roles because they sit above **${botRoleName}** in the role list: ${unassignableRoleNames.map(n => `\`${n}\``).join(', ')}.`,
          `Fix: open **Server Settings → Roles** and drag **${botRoleName}** above them (or drag those roles below it). Until then, onboarding can't grant them.`,
          '',
        ]
      : []),
    alreadyConfigured ? 'ℹ️ IDs were already configured; values were refreshed in SQLite.' : 'ℹ️ IDs stored in SQLite (kraken.db).',
    'Next: ensure `config/recruit.config.json` has `"enabled": true`, then run `npm run deploy` and restart the bot.'
  ].join('\n');

  return interaction.editReply({ content: msg });
}
