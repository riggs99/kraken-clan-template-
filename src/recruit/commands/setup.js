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

function findOrCreateRole(guild, name) {
  const existing = guild.roles.cache.find(r => r.name === name) ?? null;
  if (existing) return existing;
  return guild.roles.create({ name, mentionable: false, hoist: false, reason: 'KRAKEN Recruit setup' });
}

function rolesWithModPowers(guild) {
  return guild.roles.cache
    .filter(r => r.permissions?.has(PermissionFlagsBits.Administrator) || r.permissions?.has(PermissionFlagsBits.ManageGuild))
    .map(r => r.id);
}

async function findOrCreateTextChannel(guild, name, overwrites) {
  const existing = guild.channels.cache.find(c => c?.type === ChannelType.GuildText && c?.name === name) ?? null;
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
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

  const roleProbation = await findOrCreateRole(guild, 'probation');

  // War Hub core roles (chat + war standard + probation overlay)
  // Gate role: invite can grant this so new arrivals only see #welcome until they agree.
  const roleNewArrival = await findOrCreateRole(guild, 'new-arrival');
  const roleMember = await findOrCreateRole(guild, 'kraken-member');
  const roleWarcore = await findOrCreateRole(guild, 'kraken-warcore');
  const roleUnderwatch = await findOrCreateRole(guild, 'kraken-underwatch');
  const roleOnBreak = await findOrCreateRole(guild, 'on a break');
  const roleRemove = await findOrCreateRole(guild, 'remove');

  // Leaders role (permission gate for war hub controls)
  const roleLeaders = await findOrCreateRole(guild, 'leaders');

  const modRoleIds = rolesWithModPowers(guild);

  const everyoneId = guild.roles.everyone.id;
  const botId = interaction.client.user.id;

  const decisionsOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    ...modRoleIds.map(id => ({
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
  const welcomeChannel = await findOrCreateTextChannel(guild, 'welcome', welcomeOverwrites);
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
  const decisionsChannel = configuredDecisionsChannel ?? await findOrCreateTextChannel(guild, 'kraken-decisions', decisionsOverwrites);

  // Public read-only channel for daily KRAKEN decisions (no pings).
  const publicDecisionsConfiguredId = String(recruitConfig?.channels?.publicDecisionsChannelId ?? '');
  const publicDecisionsConfigured = await resolveTextChannelById(guild, publicDecisionsConfiguredId);
  const publicDecisionsOverwrites = [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const publicDecisionsChannel = publicDecisionsConfigured ?? await findOrCreateTextChannel(guild, 'kraken-decisions-public', publicDecisionsOverwrites);

  // Public break request channel (read-only panel; breaks start immediately and leaders acknowledge in decisions).
  const breakOverwrites = [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const onBreakChannel = await findOrCreateTextChannel(guild, 'on-a-break', breakOverwrites);
  try {
    // Ensure overwrites are correct even if the channel already existed (fixes "Missing Access" after re-invite/role changes).
    if (onBreakChannel?.permissionOverwrites?.set) {
      await onBreakChannel.permissionOverwrites.set(breakOverwrites, 'KRAKEN Recruit setup: enforce on-a-break permissions');
    }
  } catch {
    // ignore overwrite update failures
  }

  // Leaders-only ops + logs channels (no pings; operators use these as control surface)
  const leadersOnlyOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const opsExisting = findTextChannelByPrefix(guild, 'kraken-ops');
  const opsChannel = opsExisting ?? await findOrCreateTextChannel(guild, 'kraken-ops', leadersOnlyOverwrites);
  const logsChannel = await findOrCreateTextChannel(guild, 'logs', leadersOnlyOverwrites);
  const configuredRemovalQueueId = String(recruitConfig?.channels?.removalQueueChannelId ?? '');
  const configuredRemovalQueueChannel = await resolveTextChannelById(guild, configuredRemovalQueueId);
  const removalQueueChannel =
    configuredRemovalQueueChannel ??
    findTextChannelByPrefix(guild, 'remov') ??
    findTextChannelByPrefix(guild, 'kick') ??
    await findOrCreateTextChannel(guild, 'removal-queue', leadersOnlyOverwrites);
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
    : (findTextChannelByPrefix(guild, 'general') ?? null);
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

  const msg = [
    '✅ Recruit HQ setup complete.',
    '',
    `Channels:`,
    `- welcome: <#${welcomeChannel.id}>`,
    `- kraken-decisions: <#${decisionsChannel.id}>`,
    `- kraken-decisions-public: <#${publicDecisionsChannel.id}>`,
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
    alreadyConfigured ? 'ℹ️ IDs were already configured; values were refreshed in SQLite.' : 'ℹ️ IDs stored in SQLite (kraken.db).',
    'Next: ensure `config/recruit.config.json` has `"enabled": true`, then run `npm run deploy` and restart the bot.'
  ].join('\n');

  return interaction.editReply({ content: msg });
}
