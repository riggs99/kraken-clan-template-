// --- CONTRACT GUARD ---
import * as crApi from './cr-api.js';
const REQ_FN = ['getClan', 'getPlayer', 'getCurrentRiverRace', 'getRiverRaceLog', 'getBreakerStatus', 'shouldWarnDegraded'];
const missing = REQ_FN.filter(fn => typeof crApi[fn] !== 'function');
if (missing.length > 0) {
  console.error('INTERFACE DRIFT: Missing ' + missing.join(', '));
  process.exit(1);
}
console.log('CR-API INTEGRITY OK');
// --- END GUARD ---

import { loadEnv } from './env.js';
loadEnv();

const { validateEnvironmentConfig } = await import('./validation.js');
const envValidation = validateEnvironmentConfig();
if (!envValidation.valid) {
  console.error('Environment configuration errors:');
  envValidation.errors.forEach(e => console.error(' - ' + e));
  process.exit(1);
}

import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { opsHandler } from './ops.js';
import { warHandler } from './war.js';
import { isAuthorized, isLeaderOrAdmin } from './permissions.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from './dashboard-components.js';
import { onCooldown } from './cooldown.js';
import { audit } from './audit.js';
import { startScheduler } from './schedule.js';
import { startWarScheduler } from './war-scheduler.js';
import { sanitizeErrorMessage } from './validation.js';
import { formatErrorForLog } from './security.js';
import { loadOpsConfig, loadRecruitConfig } from './config/loadConfig.js';
import { handleRecruitInteraction } from './recruit/index.js';
import { getRecruitDb } from './recruit/index.js';
import { getRecruitRuntimeIds, syncRecruitRuntimeFromConfig } from './recruit/db.js';
import { ensureWelcomePost } from './recruit/onboarding.js';
import { ensureBreakPost } from './recruit/breaks.js';
import { ensureAppealsPost } from './recruit/commands/appeal.js';
import { ensureWaitlistPost, handleWaitlistRoleChange, onMemberJoin, handleMemberReturn, handleMemberLeave } from './recruit/waitlist.js';
import { removeFromWaitlist } from './recruit/db.js';
import { startRecruitEvaluator } from './recruit/evaluator.js';
import { handleRecruitMemberUpdate } from './recruit/manual-role-sync.js';

const opsConfig = loadOpsConfig();
const recruitConfig = loadRecruitConfig();
const recruitDb = getRecruitDb();
syncRecruitRuntimeFromConfig(recruitDb, { recruitConfig, opsConfig });
console.log(`OPS config loaded (enabled=${Boolean(opsConfig?.enabled)})`);
console.log(`RECRUIT config loaded (enabled=${Boolean(recruitConfig?.enabled)})`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// discord.js's Client is a Node EventEmitter — an 'error' event with zero listeners is
// thrown by Node itself and crashes the whole process (a well-known discord.js gotcha,
// distinct from anything this codebase's own logic can cause). Every other failure path
// in this file logs and keeps running; without these, a transient websocket/REST error
// would take the bot fully offline instead.
client.on(Events.Error, e => console.error('[DISCORD CLIENT ERROR]', formatErrorForLog(e)));
client.on(Events.ShardError, e => console.error('[DISCORD SHARD ERROR]', formatErrorForLog(e)));

function isRecruitOpsAuthorized(interaction) {
  try {
    if (!recruitConfig?.enabled) return false;
    if (interaction.guildId !== String(recruitConfig.recruitGuildId)) return false;

    const db = getRecruitDb();
    const runtime = getRecruitRuntimeIds(db);
    const opsChannelId = String(runtime?.channels?.opsChannelId ?? '');
    if (opsChannelId && interaction.channelId !== opsChannelId) return false;

    return isLeaderOrAdmin(interaction, String(runtime?.roles?.leadersRoleId ?? ''));
  } catch {
    return false;
  }
}

client.once(Events.ClientReady, async c => {
  console.log('KRAKEN ONLINE as ' + c.user.tag);
  startScheduler(client, recruitConfig);
  startWarScheduler(client);

  // Post startup notification so leaders know the bot (re)started
  if (recruitConfig?.enabled) {
    try {
      const _db = getRecruitDb();
      const _rt = getRecruitRuntimeIds(_db);
      const _logsId = String(_rt?.channels?.logsChannelId ?? _rt?.channels?.decisionsLogChannelId ?? '');
      if (/^\d{17,20}$/.test(_logsId)) {
        const _ch = await c.channels.fetch(_logsId).catch(() => null);
        if (_ch?.send) {
          const container = buildDashboardContainer({
            accentColor: STATUS_COLORS.healthy,
            thumbnailUrl: CLAN_BADGE_URL,
            header: '## 🐙 KRAKEN Online',
            blocks: [`Bot started at <t:${Math.floor(Date.now() / 1000)}:F>.\nEvaluator watches for the war week to close and reviews roles automatically.`],
          });
          await _ch.send({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
            allowedMentions: { parse: [] },
          });
        }
      }
    } catch (e) {
      console.error('[STARTUP] Health ping failed:', formatErrorForLog(e));
    }
  }

  if (recruitConfig?.enabled) {
    try {
      await ensureWelcomePost(client, recruitConfig, getRecruitDb());
    } catch (e) {
      console.error('[RECRUIT] Welcome post failed:', formatErrorForLog(e));
    }
    try {
      await ensureBreakPost(client, recruitConfig, getRecruitDb());
    } catch (e) {
      console.error('[RECRUIT] Break panel failed:', formatErrorForLog(e));
    }
    try {
      await ensureAppealsPost(client, recruitConfig, getRecruitDb());
    } catch (e) {
      console.error('[RECRUIT] Appeals panel failed:', formatErrorForLog(e));
    }
    try {
      await ensureWaitlistPost(client, recruitConfig, getRecruitDb());
    } catch (e) {
      console.error('[RECRUIT] Waitlist panel failed:', formatErrorForLog(e));
    }
    try {
      startRecruitEvaluator(client, recruitConfig, getRecruitDb());
    } catch (e) {
      console.error('[RECRUIT] Evaluator failed to start:', formatErrorForLog(e));
    }
  }

});

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Recruit components (buttons/select menus/modals) and autocomplete requests must bypass
    // OPS auth and be handled only in Recruit HQ — none of these are chat-input commands,
    // so without this they'd fall straight through to the isChatInputCommand() guard
    // below and get silently dropped (Discord shows the user an empty/stuck response).
    if (recruitConfig?.enabled && interaction.guildId === String(recruitConfig.recruitGuildId)) {
      if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAutocomplete() || interaction.isStringSelectMenu()) {
        const handled = await handleRecruitInteraction(interaction, recruitConfig);
        if (handled) return;

        // This is Recruit HQ's territory exclusively — an interaction here that
        // handleRecruitInteraction doesn't recognize must never fall through to the OPS/WAR
        // "kraken" role gate below (a different guild's permission concept entirely, which
        // would show a confusing, wrong-sounding denial). Logged because otherwise there's
        // zero server-side trail if this ever fires — a leader reporting "the bot says I
        // don't have permission" would be undiagnosable without it.
        console.error(`[RECRUIT] Unhandled ${interaction.type} in recruit guild: customId=${interaction.customId ?? '(none)'} command=${interaction.commandName ?? '(none)'}`);
        if (interaction.isAutocomplete()) return interaction.respond([]).catch(() => {});
        return interaction.reply({ content: 'This interaction is no longer valid — try the command again.', flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      const isOpsComponent = typeof interaction.customId === 'string' && interaction.customId.startsWith('ops:');
      const isWarComponent = typeof interaction.customId === 'string' && interaction.customId.startsWith('war:');
      const allowed = isAuthorized(interaction) || ((isOpsComponent || isWarComponent) && isRecruitOpsAuthorized(interaction));
      if (!allowed) {
        return interaction.reply({
          content: 'You do not have the `kraken` role required to use this.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (isOpsComponent) {
        await opsHandler(interaction);
      } else if (isWarComponent) {
        await warHandler(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (recruitConfig?.enabled && interaction.guildId === String(recruitConfig.recruitGuildId)) {
      const handled = await handleRecruitInteraction(interaction, recruitConfig);
      if (handled) return;
    }

    const isOpsOrWarCommand = interaction.commandName === 'ops' || interaction.commandName === 'war';
    const allowed = isAuthorized(interaction) || (isOpsOrWarCommand && isRecruitOpsAuthorized(interaction));
    if (!allowed) {
      return interaction.reply({
        content: 'You do not have the `kraken` role required to use this.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (!isOpsOrWarCommand) {
      return interaction.reply({
        content: 'This bot is configured for `/ops`, `/war` (main clan) and recruit commands (Recruit HQ).',
        flags: MessageFlags.Ephemeral
      });
    }

    if (!process.env.CLAN_TAG) {
      return interaction.reply({
        content: 'CLAN_TAG is missing in .env',
        flags: MessageFlags.Ephemeral
      });
    }

    const cd = onCooldown(interaction.user.id, interaction.commandName);
    if (cd.on) {
      return interaction.reply({
        content: `Cooldown active for **${interaction.commandName}**. Try again in **${cd.retryAfter}s**.`,
        flags: MessageFlags.Ephemeral
      });
    }

    audit(interaction, interaction.commandName);
    if (interaction.commandName === 'war') {
      await warHandler(interaction);
    } else {
      await opsHandler(interaction);
    }
  } catch (e) {
    console.error('[ERROR]', interaction.commandName, formatErrorForLog(e));

    const sanitizedMsg = sanitizeErrorMessage(e);
    const payload = { content: `Something went wrong: ${sanitizedMsg}` };

    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
      }
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      console.error('[ERROR] Failed to send error reply:', formatErrorForLog(replyError));
      return;
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!recruitConfig?.enabled) return;
    if (String(member.guild?.id ?? '') !== String(recruitConfig.recruitGuildId)) return;
    const db = getRecruitDb();
    const discordId = String(member.id ?? '');
    if (!discordId) return;

    const profile = db.prepare('SELECT discord_id, player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);

    if (profile && String(profile.status ?? '') !== 'removed') {
      // Existing non-removed member rejoining — restore roles, handle any auto-break
      await handleMemberReturn(client, member, db, profile);
      return;
    }

    // New member or previously-removed member — go through waitlist flow
    await onMemberJoin(client, member, db);
  } catch (e) {
    console.error('[RECRUIT] member add handler failed:', formatErrorForLog(e));
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (!recruitConfig?.enabled) return;
    const db = getRecruitDb();
    await handleRecruitMemberUpdate(oldMember, newMember, { client, recruitConfig, db });
    if (String(oldMember.guild?.id ?? '') === String(recruitConfig.recruitGuildId)) {
      const rt = getRecruitRuntimeIds(db);
      handleWaitlistRoleChange(oldMember, newMember, db, String(rt?.roles?.waitlistRoleId ?? ''));
    }
  } catch (e) {
    console.error('[RECRUIT] member update handler failed:', formatErrorForLog(e));
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    if (!recruitConfig?.enabled) return;
    if (String(member.guild?.id ?? '') !== String(recruitConfig.recruitGuildId)) return;

    const db = getRecruitDb();
    const discordId = String(member.id ?? '');
    if (!discordId) return;

    // Always clean up waitlist
    removeFromWaitlist(db, discordId);

    const profile = db.prepare('SELECT discord_id, player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);
    if (!profile) return;

    // Already removed — nothing more to do
    if (String(profile.status ?? '') === 'removed') return;

    // Delegate to handleMemberLeave: checks clan membership, grants auto-break or marks removed
    await handleMemberLeave(client, member, db, profile);
  } catch (e) {
    console.error('[RECRUIT] member remove handler failed:', formatErrorForLog(e));
  }
});

client.login(process.env.DISCORD_TOKEN);
