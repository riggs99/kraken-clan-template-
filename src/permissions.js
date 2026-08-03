import { PermissionFlagsBits } from 'discord.js';

function parseRoleIds() {
  const raw = process.env.ALLOWED_ROLE_IDS ?? '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Stricter than leader/admin — used to gate the handful of genuinely irreversible
// commands (emergency member removal, channel purges) down to the one person who
// can't be added or removed by anyone else. Fetches fresh guild data since a stale
// cached ownerId could under- or over-grant; falls back to the cache only if the
// fetch itself fails, since a stale bound is still safer than failing open.
export async function isServerOwner(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;
  try {
    const fresh = await guild.fetch();
    return Boolean(fresh?.ownerId) && interaction.user?.id === fresh.ownerId;
  } catch {
    return Boolean(guild.ownerId) && interaction.user?.id === guild.ownerId;
  }
}

// Shared leader-or-admin check — Administrator permission, or a configured leaders
// role. Recruit-side commands each redefined this locally before this export
// existed; new recruit code should import this instead of adding another copy.
export function isLeaderOrAdmin(interaction, leadersRoleId) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const id = String(leadersRoleId ?? '');
  return id ? Boolean(interaction.member?.roles?.cache?.has(id)) : false;
}

// Three-state Discord membership check (mirrors waitlist.js's clan-check 'in'/'out'/
// 'unknown' pattern): state is 'present' | 'gone' | 'unknown', with `member` set
// whenever state is 'present' (so callers needing the GuildMember don't have to
// fetch it a second time). Only Discord's own "Unknown Member" error (10007) counts
// as a confirmed departure — any other fetch failure (rate limit, network blip, a
// check running right as the bot reconnects) is inconclusive, not evidence someone
// left. Treating an inconclusive failure as a departure is exactly how a
// still-present member ends up wrongly marked 'removed' (confirmed live in
// production) — every call site here should branch on 'unknown' as "skip this
// cycle," not as "gone."
export async function confirmMemberGone(guild, discordId) {
  try {
    const member = await guild.members.fetch(discordId);
    return member ? { state: 'present', member } : { state: 'gone', member: null };
  } catch (e) {
    return { state: e?.code === 10007 ? 'gone' : 'unknown', member: null };
  }
}

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

// Adds/removes Discord roles on a member and verifies the result against the
// role cache the mutation itself returns (or a re-fetch, if the mutation
// threw) — never just assumes success because the API call didn't throw.
// This exact "assume success" shape has caused confirmed live incidents in
// this codebase more than once: a role add/remove silently doesn't stick, and
// code downstream persists/announces the intended outcome instead of the real
// one (two members ended up with a DB tier their Discord roles never actually
// reflected). Every Discord role mutation in this project should go through
// this instead of hand-rolling `try { await member.roles.add(...) } catch {}`
// followed by an unconditional "it worked" assumption.
//
// Returns { member, ok, missingAdds, missingRemoves } — `member` is the
// freshest GuildMember available; `ok` is true only if every requested add is
// verifiably present and every requested remove is verifiably gone afterward.
export async function applyRolesVerified(member, { add = [], remove = [], reason } = {}) {
  const toAdd = (Array.isArray(add) ? add : [add]).filter(isValidDiscordId).filter(id => !member.roles.cache.has(id));
  const toRemove = (Array.isArray(remove) ? remove : [remove]).filter(isValidDiscordId).filter(id => member.roles.cache.has(id));

  let updated = member;
  let mutationError = null;
  try {
    if (toAdd.length) updated = await updated.roles.add(toAdd, reason);
    if (toRemove.length) updated = await updated.roles.remove(toRemove, reason);
  } catch (e) {
    mutationError = e;
  }

  if (mutationError) {
    // The mutation itself threw — re-fetch to see what's actually true rather
    // than trusting the pre-mutation cache or assuming total failure (a
    // multi-role change can partially apply before failing on Discord's side).
    updated = await member.fetch().catch(() => updated);
    console.error(`[ROLES] mutation failed for <@${member.id}>:`, String(mutationError?.message ?? mutationError));
  }

  const missingAdds = toAdd.filter(id => !updated.roles.cache.has(id));
  const missingRemoves = toRemove.filter(id => updated.roles.cache.has(id));

  return { member: updated, ok: missingAdds.length === 0 && missingRemoves.length === 0, missingAdds, missingRemoves };
}

export function isAuthorized(interaction) {
  const allowedGuildId = process.env.DISCORD_GUILD_ID;
  if (allowedGuildId && interaction.guildId !== allowedGuildId) return false;

  const leaderChannelId = process.env.LEADER_CHANNEL_ID;
  if (leaderChannelId && interaction.channelId !== leaderChannelId) return false;

  const allowedRoles = parseRoleIds();
  if (allowedRoles.length === 0) return false; // fail closed

  const memberRoles = interaction.member?.roles?.cache;
  if (!memberRoles) return false;

  return allowedRoles.some(roleId => memberRoles.has(roleId));
}

