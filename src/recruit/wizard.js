// First-boot setup wizard — DMs a newly-invited server's owner an interactive select-menu
// wizard the very first time KRAKEN starts, instead of requiring them to know /recruit-setup
// exists at all. See docs/first-boot-wizard-plan.md for the full design reasoning.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, getRecruitSetting, setRecruitSetting } from './db.js';
import { runRecruitSetupCore, formatSetupCompletionMessage, trySetupLock, releaseSetupLock } from './commands/setup.js';
import { safeDm } from './commands/apply.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

// Staging keys, distinct from the live channels.*/roles.* settings — a pick is never written
// to a live key until Confirm is actually clicked. This matters most for
// PENDING_KEYS.leadersRole: roles.leadersRoleId is read LIVE, on every interaction, by
// isRecruitOpsAuthorized/isLeaderOrAdmin — pre-seeding it the instant someone merely picks a
// role (before any permission enforcement has run) would instantly grant ops/recruit-leader
// command access to anyone already holding that role, mid-wizard, before the owner confirms
// anything. The chat-channel pick doesn't carry that specific risk (channel IDs aren't read
// for permission checks anywhere), but it goes through the same staging pattern regardless,
// for one consistent rule: nothing is real until Confirm, full stop, no exceptions.
const PENDING_KEYS = {
  chatChannel: 'wizard.pendingChatChannelId',
  leadersChat: 'wizard.pendingLeadersChatChannelId',
  leadersRole: 'wizard.pendingLeadersRoleId',
};

const WARNING_TEXT = [
  '👋 I\'m KRAKEN — let\'s get your clan set up.',
  '',
  '⚠️ **Adopting your existing chat channel below makes it members-only immediately** — every current member loses access to it until they relink via the account-linking channel this creates. Leave it blank to keep a separate KRAKEN-only chat channel instead, and adopt your real one later once people have actually relinked.',
  '',
  '⚠️ **Adopting an existing leaders/officer role strips its current server-wide permissions.** KRAKEN manages every role it uses through channel-specific access only, never the role\'s own permissions — if the role you pick already has real permissions attached (Kick Members, Manage Messages, etc.), those will be removed.',
].join('\n');

function readStaged(db) {
  return {
    chatChannelId: getRecruitSetting(db, PENDING_KEYS.chatChannel) || null,
    leadersChatChannelId: getRecruitSetting(db, PENDING_KEYS.leadersChat) || null,
    leadersRoleId: getRecruitSetting(db, PENDING_KEYS.leadersRole) || null,
  };
}

function clearStaged(db) {
  for (const key of Object.values(PENDING_KEYS)) {
    db.prepare('DELETE FROM recruit_settings WHERE key = ?').run(key);
  }
}

// Only called from the Confirm path, never Start Fresh — promotes whatever was staged into
// the real settings the existing setup logic already reads (channels.memberChatChannelId,
// channels.leadersChatChannelId, roles.leadersRoleId), immediately before running setup. No
// changes needed to that logic at all: it already resolves configured ID -> stored ID ->
// create fresh, and a value written here just becomes today's "stored ID".
function promoteStaged(db) {
  const staged = readStaged(db);
  if (isValidDiscordId(staged.chatChannelId)) setRecruitSetting(db, 'channels.memberChatChannelId', staged.chatChannelId);
  if (isValidDiscordId(staged.leadersChatChannelId)) setRecruitSetting(db, 'channels.leadersChatChannelId', staged.leadersChatChannelId);
  if (isValidDiscordId(staged.leadersRoleId)) setRecruitSetting(db, 'roles.leadersRoleId', staged.leadersRoleId);
}

function buildWizardComponents(staged = {}) {
  const chatChannelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('wizard:pick:chatChannel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Existing clan chat channel? (leave blank to create a separate one)');
  if (isValidDiscordId(staged.chatChannelId)) chatChannelSelect.setDefaultChannels(staged.chatChannelId);

  const leadersChatSelect = new ChannelSelectMenuBuilder()
    .setCustomId('wizard:pick:leadersChat')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Existing leaders/officer chat channel? (leave blank to create fresh)');
  if (isValidDiscordId(staged.leadersChatChannelId)) leadersChatSelect.setDefaultChannels(staged.leadersChatChannelId);

  const leadersRoleSelect = new RoleSelectMenuBuilder()
    .setCustomId('wizard:pick:leadersRole')
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Existing leaders/officer role? (leave blank to create fresh)');
  if (isValidDiscordId(staged.leadersRoleId)) leadersRoleSelect.setDefaultRoles(staged.leadersRoleId);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wizard:confirm').setLabel('Confirm & Set Up').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wizard:startFresh').setLabel('Start Fresh').setStyle(ButtonStyle.Secondary),
  );

  return [
    new ActionRowBuilder().addComponents(chatChannelSelect),
    new ActionRowBuilder().addComponents(leadersChatSelect),
    new ActionRowBuilder().addComponents(leadersRoleSelect),
    buttonRow,
  ];
}

function buildWizardPayload(staged) {
  return { content: WARNING_TEXT, components: buildWizardComponents(staged) };
}

// Same "never configured yet" signal handleSetupInner/runRecruitSetupCore already use.
function isAlreadyConfigured(db) {
  return isValidDiscordId(getRecruitRuntimeIds(db)?.channels?.welcomeChannelId ?? '');
}

// Called from index.js's ClientReady handler on every boot. Only actually sends anything on a
// genuinely first-ever boot (never configured) that hasn't already been DM'd successfully —
// NOT Discord's GuildCreate event, which this bot's own onboarding paths (SETUP.md,
// scripts/provision-clan.mjs) never have a live process connected to receive: the bot is
// always invited into the guild before it's ever started running for the first time.
export async function maybeSendFirstBootWizard(client, recruitConfig, db) {
  if (isAlreadyConfigured(db)) return;
  if (getRecruitSetting(db, 'wizard.dmSentAt')) return;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (!isValidDiscordId(recruitGuildId)) return;

  const guild = await client.guilds.fetch(recruitGuildId).catch(() => null);
  if (!guild) return;
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner?.user) return;

  const sent = await safeDm(owner.user, buildWizardPayload(readStaged(db)));
  // If this failed (DMs from non-friends disabled), leave the marker unset — this makes the
  // wizard automatically retry on the next restart, with zero extra retry/backoff machinery,
  // and without ever spamming an owner who received it fine the first time. /recruit-setup
  // remains the documented manual fallback regardless.
  if (sent) setRecruitSetting(db, 'wizard.dmSentAt', String(Date.now()));
}

// Called from index.js's dedicated `wizard:` dispatch branch (guild-independent — this fires
// from a DM, where interaction.guildId is always null). Returns true/false (handled or not),
// matching handleRecruitInteraction's contract.
export async function handleWizardInteraction(interaction, { recruitConfig, db, client }) {
  const customId = String(interaction.customId ?? '');
  if (!customId.startsWith('wizard:')) return false;

  const pickMatch = customId.match(/^wizard:pick:(chatChannel|leadersChat|leadersRole)$/);
  if (pickMatch) {
    const which = pickMatch[1];
    const pickedId = interaction.values?.[0] ?? null;
    if (isValidDiscordId(pickedId)) {
      setRecruitSetting(db, PENDING_KEYS[which], pickedId);
    } else {
      db.prepare('DELETE FROM recruit_settings WHERE key = ?').run(PENDING_KEYS[which]);
    }
    await interaction.update(buildWizardPayload(readStaged(db))).catch(() => {});
    return true;
  }

  if (customId === 'wizard:confirm' || customId === 'wizard:startFresh') {
    const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
    const guild = isValidDiscordId(recruitGuildId) ? await client.guilds.fetch(recruitGuildId).catch(() => null) : null;
    if (!guild) {
      await interaction.update({ content: 'Could not reach the server anymore — this wizard link is no longer valid.', components: [] }).catch(() => {});
      return true;
    }

    // Defensive re-check, cheap: a DM is 1:1 between the bot and whoever it was sent to, but
    // ownership could theoretically change between send and click.
    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner || owner.id !== interaction.user.id) {
      await interaction.reply({ content: 'Only the server owner can confirm this.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    // Re-check before touching anything — if /recruit-setup was run manually in the time
    // between this DM being sent and a button being clicked, the clan is already set up, and
    // promoting stale staged picks now would silently overwrite whatever that manual run just
    // created.
    if (isAlreadyConfigured(db)) {
      clearStaged(db);
      await interaction.update({ content: 'This clan was already set up — this wizard link is no longer needed.', components: [] }).catch(() => {});
      return true;
    }

    if (customId === 'wizard:confirm') promoteStaged(db);
    clearStaged(db);

    if (!trySetupLock()) {
      await interaction.update({
        content: '⏳ Recruit HQ setup is already running from another request. Wait for it to finish, then try again.',
        components: buildWizardComponents(readStaged(db)),
      }).catch(() => {});
      return true;
    }

    let result;
    try {
      result = await runRecruitSetupCore(guild, { db, recruitConfig, client });
    } finally {
      releaseSetupLock();
    }

    const message = formatSetupCompletionMessage(result);
    // On failure, leave the buttons clickable for a retry (setup is safe to re-run) rather
    // than disabling them — a missing-permissions failure is fixable by the owner without
    // needing a fresh wizard DM.
    await interaction.update({
      content: message,
      components: result.ok ? [] : buildWizardComponents(readStaged(db)),
    }).catch(() => {});
    return true;
  }

  return false;
}
