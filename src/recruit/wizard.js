// First-boot setup wizard — DMs a newly-invited server's owner an interactive select-menu
// wizard the very first time KRAKEN starts, instead of requiring them to know /recruit-setup
// exists at all. See docs/first-boot-wizard-plan.md for the full design reasoning.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType } from 'discord.js';
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
// anything.
const PENDING_KEYS = {
  leadersChat: 'wizard.pendingLeadersChatChannelId',
  leadersRole: 'wizard.pendingLeadersRoleId',
};

const WARNING_TEXT = [
  '👋 I\'m KRAKEN — I handle recruiting, member tiers, and war tracking for your clan.',
  '',
  'Before I can do that, I need to set up some channels and roles in this server. I can create everything brand new, or — if you already have some of these — I can use what you\'ve got instead. For anything you leave blank below, I\'ll just create a fresh one automatically. **Not sure? Leaving everything blank is the safe default.**',
  '',
  '**1️⃣ Your leaders/officers chat channel** (first dropdown below)',
  'If you already have a private channel for your leadership team, pick it here. Leave it blank and I\'ll create a new private one.',
  '',
  '**2️⃣ Your leaders/officers role** (second dropdown below)',
  'If your leadership team already has a Discord role, pick it here.',
  '⚠️ I control access channel-by-channel, not through role permissions — if this role currently has server-wide permissions like Kick Members or Manage Messages, those will be removed when I take it over.',
  '',
  'Once you\'ve made your picks (or left them blank), tap one of the buttons below:',
  '✅ **Confirm & Set Up** — creates everything now, using whatever you picked above (and fresh ones for anything left blank).',
  '🔄 **Start Fresh** — skips all of the above and creates everything brand new, exactly like a first-time setup.',
].join('\n');

function readStaged(db) {
  return {
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
// the real settings the existing setup logic already reads (channels.leadersChatChannelId,
// roles.leadersRoleId), immediately before running setup. No changes needed to that logic at
// all: it already resolves configured ID -> stored ID -> create fresh, and a value written
// here just becomes today's "stored ID".
function promoteStaged(db) {
  const staged = readStaged(db);
  if (isValidDiscordId(staged.leadersChatChannelId)) setRecruitSetting(db, 'channels.leadersChatChannelId', staged.leadersChatChannelId);
  if (isValidDiscordId(staged.leadersRoleId)) setRecruitSetting(db, 'roles.leadersRoleId', staged.leadersRoleId);
}

function buildWizardComponents(staged = {}) {
  const leadersChatSelect = new ChannelSelectMenuBuilder()
    .setCustomId('wizard:pick:leadersChat')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('1️⃣ Your existing leaders chat? (optional)');
  if (isValidDiscordId(staged.leadersChatChannelId)) leadersChatSelect.setDefaultChannels(staged.leadersChatChannelId);

  const leadersRoleSelect = new RoleSelectMenuBuilder()
    .setCustomId('wizard:pick:leadersRole')
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('2️⃣ Your existing leaders role? (optional)');
  if (isValidDiscordId(staged.leadersRoleId)) leadersRoleSelect.setDefaultRoles(staged.leadersRoleId);

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wizard:confirm').setLabel('✅ Confirm & Set Up').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wizard:startFresh').setLabel('🔄 Start Fresh').setStyle(ButtonStyle.Secondary),
  );

  return [
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

  const pickMatch = customId.match(/^wizard:pick:(leadersChat|leadersRole)$/);
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
    // Ack immediately, before any slow work. runRecruitSetupCore alone (creating ~11 channels,
    // ~9 roles, applying every permission overwrite) routinely takes well over Discord's 3-second
    // interaction-ack window — without this, the interaction token dies before the final
    // interaction.update() below ever runs, that call throws silently (caught by .catch(() => {})),
    // and the owner sees Discord's native "This interaction failed" with no completion message at
    // all, even though setup actually succeeded server-side. Every reply below this point uses
    // editReply, which edits the same deferred message, matching the immediate-ack-then-edit
    // pattern already used everywhere else in this codebase for slow actions (ban-member.js,
    // remove-member.js, break-reset.js, etc.).
    await interaction.deferUpdate().catch(() => {});

    const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
    const guild = isValidDiscordId(recruitGuildId) ? await client.guilds.fetch(recruitGuildId).catch(() => null) : null;
    if (!guild) {
      await interaction.editReply({ content: 'Could not reach the server anymore — this wizard link is no longer valid.', components: [] }).catch(() => {});
      return true;
    }

    // Defensive re-check, cheap: a DM is 1:1 between the bot and whoever it was sent to, but
    // ownership could theoretically change between send and click.
    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner || owner.id !== interaction.user.id) {
      await interaction.editReply({ content: 'Only the server owner can confirm this.', components: [] }).catch(() => {});
      return true;
    }

    // Re-check before touching anything — if /recruit-setup was run manually in the time
    // between this DM being sent and a button being clicked, the clan is already set up, and
    // promoting stale staged picks now would silently overwrite whatever that manual run just
    // created.
    if (isAlreadyConfigured(db)) {
      clearStaged(db);
      await interaction.editReply({ content: 'This clan was already set up — this wizard link is no longer needed.', components: [] }).catch(() => {});
      return true;
    }

    if (customId === 'wizard:confirm') promoteStaged(db);
    clearStaged(db);

    if (!trySetupLock()) {
      await interaction.editReply({
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
    await interaction.editReply({
      content: message,
      components: result.ok ? [] : buildWizardComponents(readStaged(db)),
    }).catch(() => {});
    return true;
  }

  return false;
}
