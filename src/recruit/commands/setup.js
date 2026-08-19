import { PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, setRecruitSetting } from '../db.js';
import { ensureWelcomePost } from '../onboarding.js';
import { ensureBreakPost } from '../breaks.js';
import { ensureAppealsPost } from './appeal.js';
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

// Every KRAKEN role is a pure tag — access is granted entirely through the per-channel
// overwrites elsewhere in this file, never through the role's own server-wide permissions.
// Discord defaults a newly-created role's permissions to a COPY of @everyone's current
// permissions (not zero), so without this, a role could silently pick up whatever baseline
// @everyone happens to have. Enforced on every run, same as hoist above, so drift (a manual
// permission toggle, or re-adopting a pre-existing role) self-heals on re-setup.
async function enforcePermissions(role) {
  if (role && role.permissions?.bitfield !== 0n) {
    try {
      await role.setPermissions([], 'KRAKEN Recruit setup: role carries no server-wide permissions of its own');
    } catch {
      // ignore permission update failures
    }
  }
  return role;
}

// Deliberately NOT a find-by-name-then-create — see the comment on
// findOrCreateRoleById below for why matching an existing role by name is unsafe
// on a real, already-populated server.
async function createRole(guild, name, hoist = false) {
  return guild.roles.create({ name, mentionable: false, hoist, permissions: [], reason: 'KRAKEN Recruit setup' });
}

function rolesWithModPowers(guild) {
  return guild.roles.cache
    .filter(r => r.permissions?.has(PermissionFlagsBits.Administrator) || r.permissions?.has(PermissionFlagsBits.ManageGuild))
    .map(r => r.id);
}

// Deliberately NOT a find-by-name-then-create — see findOrCreateTextChannelById below.
async function createTextChannel(guild, name, overwrites, parentId) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    reason: 'KRAKEN Recruit setup'
  });
}

async function createCategory(guild, name, overwrites) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: 'KRAKEN Recruit setup'
  });
}

// force: true on every fetch below is deliberate — discord.js's default fetch() checks its
// local cache first and only calls the API if the ID isn't cached, which would let a channel
// deleted moments ago (before the CHANNEL_DELETE gateway event has been processed) still
// resolve as "found" from a stale cache entry. That silently blocks re-creation: setup would
// think the old channel still exists and never make a new one. force: true always hits the
// API for a genuine answer.
async function resolveTextChannelById(guild, channelId) {
  const id = String(channelId ?? '');
  if (!isValidDiscordId(id)) return null;
  try {
    const fetched = await guild.channels.fetch(id, { force: true });
    return fetched?.type === ChannelType.GuildText ? fetched : null;
  } catch {
    return null;
  }
}

async function resolveCategoryById(guild, categoryId) {
  const id = String(categoryId ?? '');
  if (!isValidDiscordId(id)) return null;
  try {
    const fetched = await guild.channels.fetch(id, { force: true });
    return fetched?.type === ChannelType.GuildCategory ? fetched : null;
  } catch {
    return null;
  }
}

async function resolveRoleById(guild, roleId) {
  const id = String(roleId ?? '');
  if (!isValidDiscordId(id)) return null;
  try {
    return await guild.roles.fetch(id, { force: true });
  } catch {
    return null;
  }
}

// Resolve the role this server was provisioned with last time, looked up by the ID stored in
// SQLite — NEVER by name. This runs on real clan servers, not just empty test ones: matching
// an existing role by name (e.g. a clan that already has its own "leaders" role with real
// permissions on it) would silently adopt and zero out something that was never KRAKEN's to
// touch. If the stored ID doesn't resolve, always create fresh rather than guess. The only
// cost is a rare edge case — this server's own database got wiped while its Discord roles
// still exist — falling back to a duplicate-named role instead of self-healing by name; that
// trade is worth it to guarantee a pre-existing, unrelated role can never be silently touched.
async function findOrCreateRoleById(guild, storedId, name, hoist = false) {
  const byId = await resolveRoleById(guild, storedId);
  if (byId) {
    await enforceHoist(byId, hoist);
    return enforcePermissions(byId);
  }
  return createRole(guild, name, hoist);
}

// Same reasoning as findOrCreateRoleById — stored ID or create fresh, never a name match.
// A real clan's existing server very plausibly already has a channel called "general",
// "welcome", or "logs"; adopting one of those by name would silently rewrite its permissions
// (or, for #on-a-break specifically, purge its entire message history — see breaks.js) even
// though it was never a channel KRAKEN created.
async function findOrCreateTextChannelById(guild, storedId, name, overwrites, parentId) {
  return (await resolveTextChannelById(guild, storedId)) ?? createTextChannel(guild, name, overwrites, parentId);
}

// Resolve an optional-but-now-guaranteed channel by: configured ID > stored ID > create fresh.
// Then (re-)enforce its overwrites unconditionally, so drift self-heals on every re-run the
// same way the channels above it in this file do. No name-matching — see the comment on
// findOrCreateTextChannelById above for why.
async function findOrCreateManagedChannel(guild, { configuredId, storedId, createName, overwrites, parentId = null, enforceReason }) {
  const channel = await resolveTextChannelById(guild, configuredId)
    ?? await resolveTextChannelById(guild, storedId)
    ?? await createTextChannel(guild, createName, overwrites, parentId);

  try {
    if (channel.permissionOverwrites?.set) {
      await channel.permissionOverwrites.set(overwrites, enforceReason);
    }
  } catch {
    // ignore overwrite update failures
  }
  return channel;
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

  // guild.members.me is a cache-only getter — it can be null right when the bot has just
  // started, which is exactly when /recruit-setup is typically run for the first time on a
  // freshly-invited bot. Fetched explicitly instead, same as every other member lookup in
  // this codebase (permissions.js, evaluator.js, apply.js, etc.), so this and the role-
  // hierarchy check further down are never gated on whatever happens to already be cached.
  const botMember = await guild.members.fetch(interaction.client.user.id).catch(() => null);

  // The full set the invite link is supposed to grant (see docs/onboard-a-clan.md) — checked
  // here, not just the two most critical ones, so a partial/wrong invite fails clearly up
  // front instead of surfacing later as a silent per-channel permission gap. Uses the bot's
  // actual guild-wide permissions (not interaction.appPermissions, which only reflects the
  // channel the command happened to be run from) — a channel-specific overwrite denying e.g.
  // Send Messages there would otherwise cause a false "missing permissions" rejection even
  // when the invite grant is genuinely complete.
  const requiredBotPermissions = [
    ['Manage Roles', PermissionFlagsBits.ManageRoles],
    ['Manage Channels', PermissionFlagsBits.ManageChannels],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ];
  const missingBotPermissions = requiredBotPermissions.filter(([, flag]) => !botMember?.permissions?.has(flag));
  if (missingBotPermissions.length > 0) {
    return interaction.reply({
      content: `KRAKEN is missing these permissions in this server: ${missingBotPermissions.map(([label]) => `**${label}**`).join(', ')}. Re-invite the bot with the full permission set from the setup guide, then run this again.`,
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
  const roleProbation = await findOrCreateRoleById(guild, existing?.roles?.probationRoleId, 'probation', true);

  // War Hub core roles (chat + war standard + probation overlay)
  // Gate role: invite can grant this so new arrivals only see #welcome until they agree.
  const roleNewArrival = await findOrCreateRoleById(guild, existing?.roles?.newArrivalRoleId, 'new-arrival');
  const roleMember = await findOrCreateRoleById(guild, existing?.roles?.memberRoleId, 'kraken-member', true);
  const roleWarcore = await findOrCreateRoleById(guild, existing?.roles?.warcoreRoleId, 'kraken-warcore', true);
  const roleUnderwatch = await findOrCreateRoleById(guild, existing?.roles?.underwatchRoleId, 'kraken-underwatch', true);
  const roleOnBreak = await findOrCreateRoleById(guild, existing?.roles?.onBreakRoleId, 'on a break', true);
  const roleRemove = await findOrCreateRoleById(guild, existing?.roles?.removeRoleId, 'remove');
  // Queued for a spot once the clan is genuinely full — created here rather than left manual,
  // so a brand-new clan is fully working immediately with no post-setup steps.
  const roleWaitlist = await findOrCreateRoleById(guild, existing?.roles?.waitlistRoleId, 'waitlist');

  // Leaders role (permission gate for war hub controls)
  const roleLeaders = await findOrCreateRoleById(guild, existing?.roles?.leadersRoleId, 'leaders', true);

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
  const leadersCategory = (await resolveCategoryById(guild, existing?.channels?.leadersCategoryId))
    ?? await createCategory(guild, 'leaders', leadersOnlyOverwrites);
  setRecruitSetting(db, 'channels.leadersCategoryId', leadersCategory.id);

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
  const welcomeChannel = await findOrCreateTextChannelById(guild, existing?.channels?.welcomeChannelId, 'welcome', welcomeOverwrites);
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
  const decisionsChannel = configuredDecisionsChannel ?? await findOrCreateTextChannelById(guild, existing?.channels?.decisionsChannelId, 'kraken-decisions-leaders', decisionsOverwrites, leadersCategory.id);

  // Read-only channel for daily KRAKEN decisions (no pings). Visible to actual members
  // (kraken-member, granted the moment /apply succeeds) + leaders — not to new-arrival/
  // waitlist, who haven't joined the clan yet and have nothing here to read about them.
  const publicDecisionsConfiguredId = String(recruitConfig?.channels?.publicDecisionsChannelId ?? '');
  const publicDecisionsConfigured = await resolveTextChannelById(guild, publicDecisionsConfiguredId);
  const publicDecisionsOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  // Resolve the public channel by: configured ID > stored ID > create fresh. No name-matching
  // — see the comment on findOrCreateTextChannelById above for why guessing by name is unsafe
  // on a real, already-populated server.
  const publicDecisionsChannel = publicDecisionsConfigured
    ?? await resolveTextChannelById(guild, existing?.channels?.publicDecisionsChannelId)
    ?? await createTextChannel(guild, 'kraken-decisions', publicDecisionsOverwrites, null);
  try {
    // Safe to re-affirm overwrites + top-level placement now: publicDecisionsChannel is
    // always either our own channel (resolved by ID) or freshly created — never a channel
    // we adopted from elsewhere.
    if (publicDecisionsChannel?.permissionOverwrites?.set) {
      await publicDecisionsChannel.permissionOverwrites.set(publicDecisionsOverwrites, 'KRAKEN Recruit setup: enforce kraken-decisions (members-only) permissions');
    }
    if (!publicDecisionsConfigured && publicDecisionsChannel?.parentId !== null) {
      await publicDecisionsChannel.setParent(null, { lockPermissions: false, reason: 'KRAKEN Recruit setup: kraken-decisions is members-only, not a leaders-only channel' });
    }
  } catch {
    // ignore overwrite update failures
  }

  // Break request channel (read-only panel; breaks start immediately and leaders acknowledge in
  // decisions). Members-only, same reasoning as kraken-decisions above — a new-arrival who
  // hasn't applied yet has no break to manage.
  const breakOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const onBreakChannel = await findOrCreateTextChannelById(guild, existing?.channels?.onBreakChannelId, 'on-a-break', breakOverwrites);
  try {
    // Ensure overwrites are correct even if the channel already existed (fixes "Missing Access" after re-invite/role changes).
    if (onBreakChannel?.permissionOverwrites?.set) {
      await onBreakChannel.permissionOverwrites.set(breakOverwrites, 'KRAKEN Recruit setup: enforce on-a-break permissions');
    }
  } catch {
    // ignore overwrite update failures
  }

  // Leaders-only ops + logs channels (no pings; operators use these as control surface).
  // No name-matching — see the comment on findOrCreateTextChannelById above.
  const opsChannel =
    (await resolveTextChannelById(guild, existing?.channels?.opsChannelId)) ??
    await createTextChannel(guild, 'kraken-ops', leadersOnlyOverwrites, leadersCategory.id);
  const logsChannel = await findOrCreateTextChannelById(guild, existing?.channels?.logsChannelId, 'logs', leadersOnlyOverwrites, leadersCategory.id);
  const configuredRemovalQueueId = String(recruitConfig?.channels?.removalQueueChannelId ?? '');
  const configuredRemovalQueueChannel = await resolveTextChannelById(guild, configuredRemovalQueueId);
  const removalQueueChannel =
    configuredRemovalQueueChannel ??
    (await resolveTextChannelById(guild, existing?.channels?.removalQueueChannelId)) ??
    await createTextChannel(guild, 'removal-queue', leadersOnlyOverwrites, leadersCategory.id);
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

  // Member chat channel (baseline clan member chat). Created if missing — not left for a
  // leader to set up by hand — so a brand-new clan gets a fully working server immediately.
  // Gate to actual members only — kraken-member is granted the moment /apply succeeds,
  // regardless of tier, so this excludes new-arrival/waitlist without excluding anyone
  // who's actually onboarded.
  const memberOnlyOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  const memberChatChannel = await findOrCreateManagedChannel(guild, {
    configuredId: recruitConfig?.channels?.memberChatChannelId,
    storedId: existing?.channels?.memberChatChannelId,
    createName: 'general',
    overwrites: memberOnlyOverwrites,
    enforceReason: 'KRAKEN Recruit setup: enforce member-chat permissions',
  });
  setRecruitSetting(db, 'channels.memberChatChannelId', memberChatChannel.id);

  // Leaders-only chat channel — distinct from the leaders category above, which is all
  // bot-managed data/log surfaces (#kraken-decisions-leaders, #kraken-ops, #logs,
  // #removal-queue), not somewhere leaders would actually sit and talk. Also created if
  // missing, same reasoning as member chat above.
  const leadersChatChannel = await findOrCreateManagedChannel(guild, {
    configuredId: recruitConfig?.channels?.leadersChatChannelId,
    storedId: existing?.channels?.leadersChatChannelId,
    createName: 'leaders-chat',
    overwrites: leadersOnlyOverwrites,
    parentId: leadersCategory.id,
    enforceReason: 'KRAKEN Recruit setup: enforce leaders-chat permissions',
  });
  setRecruitSetting(db, 'channels.leadersChatChannelId', leadersChatChannel.id);
  try {
    // findOrCreateManagedChannel only parents on first creation, not when it resolves an
    // existing channel by ID — enforced here too so a manually-dragged channel self-heals
    // back into place. Positioned first in the category (leaders check this one most) —
    // re-set on every run since a freshly-created channel otherwise lands at the bottom.
    if (leadersChatChannel.parentId !== leadersCategory.id) {
      await leadersChatChannel.setParent(leadersCategory.id, { lockPermissions: false, reason: 'KRAKEN Recruit setup: group under leaders category' });
    }
    await leadersChatChannel.setPosition(0);
  } catch {
    // ignore — purely cosmetic ordering, never block setup
  }

  // Waitlist channel (queue for when the clan is genuinely full). roleWaitlist always exists
  // by this point (created above alongside the other roles). Also created if missing.
  const waitingListOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleWaitlist.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
  ];
  const waitingListChannel = await findOrCreateManagedChannel(guild, {
    configuredId: recruitConfig?.channels?.waitingListChannelId,
    storedId: existing?.channels?.waitingListChannelId,
    createName: 'waiting-list',
    overwrites: waitingListOverwrites,
    enforceReason: 'KRAKEN Recruit setup: enforce waiting-list permissions',
  });
  setRecruitSetting(db, 'channels.waitingListChannelId', waitingListChannel.id);

  // Appeals channel — read-only queue for members (they interact via the "Submit Appeal"
  // button/modal, never by typing), same access pattern as #kraken-decisions/#on-a-break.
  // Leaders' review cards (Overturn/Keep buttons) post into this same channel.
  const appealsOnlyOverwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    { id: roleMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: roleLeaders.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  const appealsChannel = await findOrCreateManagedChannel(guild, {
    configuredId: recruitConfig?.channels?.appealsChannelId,
    storedId: existing?.channels?.appealsChannelId,
    createName: 'appeals',
    overwrites: appealsOnlyOverwrites,
    enforceReason: 'KRAKEN Recruit setup: enforce appeals permissions',
  });
  setRecruitSetting(db, 'channels.appealsChannelId', appealsChannel.id);

  setRecruitSetting(db, 'roles.leadersRoleId', roleLeaders.id);
  setRecruitSetting(db, 'roles.memberRoleId', roleMember.id);
  setRecruitSetting(db, 'roles.warcoreRoleId', roleWarcore.id);
  setRecruitSetting(db, 'roles.underwatchRoleId', roleUnderwatch.id);
  setRecruitSetting(db, 'roles.newArrivalRoleId', roleNewArrival.id);
  setRecruitSetting(db, 'roles.onBreakRoleId', roleOnBreak.id);
  setRecruitSetting(db, 'roles.probationRoleId', roleProbation.id);
  setRecruitSetting(db, 'roles.removeRoleId', roleRemove.id);
  setRecruitSetting(db, 'roles.waitlistRoleId', roleWaitlist.id);

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
  try {
    await ensureAppealsPost(interaction.client, recruitConfig, db);
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
    const orderedTopToBottom = [roleLeaders, roleWarcore, roleMember, roleUnderwatch, roleProbation, roleOnBreak, roleNewArrival, roleWaitlist, roleRemove]
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
  const botHighestPosition = botMember?.roles?.highest?.position ?? 0;
  const botRoleName = botMember?.roles?.botRole?.name ?? 'the bot';
  // roleLeaders is included: the bot auto-grants it to in-game co-leaders/leaders on /apply,
  // so it must sit below the bot too — otherwise that grant silently fails.
  const unassignableRoleNames = [roleNewArrival, roleMember, roleWarcore, roleUnderwatch, roleProbation, roleOnBreak, roleRemove, roleWaitlist, roleLeaders]
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
    `- member chat: <#${memberChatChannel.id}>`,
    `- leaders chat: <#${leadersChatChannel.id}>`,
    `- waiting-list: <#${waitingListChannel.id}>`,
    `- appeals: <#${appealsChannel.id}>`,
    '',
    `Roles:`,
    `- probation: <@&${roleProbation.id}>`,
    `- new-arrival: <@&${roleNewArrival.id}>`,
    `- kraken-member: <@&${roleMember.id}>`,
    `- kraken-warcore: <@&${roleWarcore.id}>`,
    `- kraken-underwatch: <@&${roleUnderwatch.id}>`,
    `- on a break: <@&${roleOnBreak.id}>`,
    `- remove: <@&${roleRemove.id}>`,
    `- waitlist: <@&${roleWaitlist.id}>`,
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
