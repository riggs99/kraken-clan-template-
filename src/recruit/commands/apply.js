import { getClan } from '../../cr-api.js';
import { normalizePlayerTag } from '../../util.js';
import { applyPublicAck, dmCooldown } from '../messages.js';
import { getActiveBreak, getRecruitRuntimeIds, getRecruitSetting, setRecruitSetting, removeFromWaitlist, addToWaitlist } from '../db.js';
import { suppressManualTierSync } from '../manual-role-sync.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { formatErrorForLog } from '../../security.js';
import { applyRolesVerified } from '../../permissions.js';
import { sendWelcomeGuideDm } from '../welcome-guide.js';
import { loadRecruitConfig } from '../../config/loadConfig.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS, ensurePersistentPanel } from '../../dashboard-components.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function safeJson(value, fallback) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function nowMs() {
  return Date.now();
}

async function safeDm(user, content) {
  try {
    await user.send({ content });
    return true;
  } catch {
    return false;
  }
}

async function safeSendToChannel(client, channelId, content, fallbackChannelId = null, context = 'Recruit decision') {
  if (!isValidDiscordId(channelId)) {
    if (!isValidDiscordId(fallbackChannelId)) return false;
    channelId = fallbackChannelId;
    fallbackChannelId = null;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') return false;
    const payload = typeof content === 'string'
      ? {
          embeds: [
            new EmbedBuilder()
              .setTitle('🐙 KRAKEN Recruit Decision')
              .setColor(0x5865f2)
              .setDescription(content),
          ],
        }
      : (content ?? {});
    await channel.send({ ...payload, allowedMentions: { parse: [] } });
    return true;
  } catch {
    console.error(`[RECRUIT] ${context} failed: primaryChannel=${String(channelId)}`);
    if (!isValidDiscordId(fallbackChannelId) || String(fallbackChannelId) === String(channelId)) {
      return false;
    }
    try {
      const fallback = await client.channels.fetch(fallbackChannelId);
      if (!fallback || typeof fallback.send !== 'function') return false;
      const payload = typeof content === 'string'
        ? {
            embeds: [
              new EmbedBuilder()
                .setTitle('🐙 KRAKEN Recruit Decision')
                .setColor(0xed4245)
                .setDescription(content),
            ],
          }
        : (content ?? {});
      await fallback.send({ ...payload, allowedMentions: { parse: [] } });
      console.error(`[RECRUIT] ${context} fallback sent to logs channel ${String(fallbackChannelId)}`);
      return true;
    } catch {
      console.error(`[RECRUIT] ${context} fallback failed: logsChannel=${String(fallbackChannelId)}`);
      return false;
    }
  }
}

export async function verifyTagInCurrentClan(tag) {
  const clanTag = String(process.env.CLAN_TAG ?? '').trim();
  if (!clanTag) {
    return { ok: false, code: 'CLAN_TAG_MISSING' };
  }

  try {
    const clan = await getClan(clanTag);
    const members = Array.isArray(clan?.memberList) ? clan.memberList : [];
    const match = members.find(m => normalizePlayerTag(m?.tag) === tag);
    if (!match) {
      // A tag genuinely can't be in the roster while the real in-game clan sits at
      // Supercell's own 50-member cap — surfaced here so the caller can tell "wrong tag"
      // apart from "clan's actually full, you physically can't have joined yet".
      return { ok: false, code: 'TAG_NOT_IN_CLAN', clanFull: members.length >= 50 };
    }
    return {
      ok: true,
      memberName: String(match?.name ?? '').trim() || null,
      // CR API clan roles: 'member' | 'elder' | 'coLeader' | 'leader'. Lowercased for comparison.
      clanRole: String(match?.role ?? '').trim().toLowerCase() || null,
    };
  } catch {
    return { ok: false, code: 'CLAN_LOOKUP_FAILED' };
  }
}

function formatDecisionLog({ userId, tag, score, verdict, reasons, reviewer, whenISO }) {
  const reasonTxt = Array.isArray(reasons) && reasons.length ? reasons.join(', ') : '(none)';
  return [
    `🧾 **Recruit Decision**`,
    `User: <@${userId}>`,
    `Tag: #${tag}`,
    `Score: ${score}`,
    `Verdict: ${verdict}`,
    `Reasons: ${reasonTxt}`,
    `Timestamp: ${whenISO}`,
    `Reviewer: ${reviewer}`
  ].join('\n');
}

export function upsertProfile(db, profile) {
  const stmt = db.prepare(`
    INSERT INTO profiles (
      discord_id,
      player_tag,
      region,
      timezone,
      status,
      last_score,
      last_verdict,
      last_reasons,
      cooldown_until,
      probation_until,
      created_at,
      updated_at
    ) VALUES (
      @discord_id,
      @player_tag,
      @region,
      @timezone,
      @status,
      @last_score,
      @last_verdict,
      @last_reasons,
      @cooldown_until,
      @probation_until,
      @created_at,
      @updated_at
    )
    ON CONFLICT(discord_id) DO UPDATE SET
      player_tag = excluded.player_tag,
      region = excluded.region,
      timezone = excluded.timezone,
      status = excluded.status,
      last_score = excluded.last_score,
      last_verdict = excluded.last_verdict,
      last_reasons = excluded.last_reasons,
      cooldown_until = excluded.cooldown_until,
      probation_until = excluded.probation_until,
      updated_at = excluded.updated_at;
  `);
  stmt.run(profile);
}

function insertTrialLedger(db, entry) {
  const stmt = db.prepare(`
    INSERT INTO trial_ledger (
      discord_id,
      player_tag,
      score,
      verdict,
      reasons,
      stats_snapshot,
      created_at
    ) VALUES (
      @discord_id,
      @player_tag,
      @score,
      @verdict,
      @reasons,
      @stats_snapshot,
      @created_at
    );
  `);
  stmt.run(entry);
}

function statusFromCurrentRoles(member, runtime) {
  const roles = member?.roles?.cache;
  if (!roles) return 'probation';
  const warcore = String(runtime?.roles?.warcoreRoleId ?? '');
  const underwatch = String(runtime?.roles?.underwatchRoleId ?? '');
  const probation = String(runtime?.roles?.probationRoleId ?? '');
  if (underwatch && roles.has(underwatch)) return 'underwatch';
  if (probation && roles.has(probation)) return 'probation';
  if (warcore && roles.has(warcore)) return 'approved';
  return 'probation';
}

function parseCompletedRelinks(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(v => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function resetRelinkTrackingState(db, discordId, { preserveBreaks = false } = {}) {
  const id = String(discordId);
  db.prepare('DELETE FROM trial_ledger WHERE discord_id = ?').run(id);
  if (!preserveBreaks) {
    db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(id);
    db.prepare('DELETE FROM break_requests WHERE discord_id = ?').run(id);
  }
  db.prepare('DELETE FROM underwatch_state WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM probation_state WHERE discord_id = ?').run(id);
  db.prepare('DELETE FROM post_break_enforcement WHERE discord_id = ?').run(id);
}

export async function applyCore(interaction, ctx, input) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = getRecruitRuntimeIds(db);
  const disableCooldowns = String(process.env.RECRUIT_DISABLE_COOLDOWNS ?? '').toLowerCase() === '1'
    || String(process.env.RECRUIT_DISABLE_COOLDOWNS ?? '').toLowerCase() === 'true';

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const welcomeChannelId = String(runtime?.channels?.welcomeChannelId ?? '');
  if (!isValidDiscordId(welcomeChannelId)) {
    return interaction.reply({ content: 'Recruit is not set up yet. Ask an admin to run `/recruit-setup`.', flags: MessageFlags.Ephemeral });
  }

  const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');
  const probationRoleId = String(runtime?.roles?.probationRoleId ?? '');
  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isValidDiscordId(memberRoleId) || !isValidDiscordId(probationRoleId)) {
    return interaction.reply({
      content: 'Recruit is not set up yet (missing role IDs). Ask an admin to run `/recruit-setup`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rawTag = String(input?.tag ?? '');
  const tag = normalizePlayerTag(rawTag);
  if (!tag || tag.length < 3) {
    return interaction.reply({ content: 'Invalid tag. Provide a real player tag.', flags: MessageFlags.Ephemeral });
  }

  const clanVerification = await verifyTagInCurrentClan(tag);
  if (!clanVerification.ok) {
    // A missing tag while the real clan is genuinely full (Supercell's own 50-member cap)
    // isn't a wrong-tag mistake — they physically can't have joined yet. Route them onto
    // the same waitlist path a fresh Discord join would, instead of a confusing rejection.
    if (clanVerification.code === 'TAG_NOT_IN_CLAN' && clanVerification.clanFull) {
      const clanName = String(recruitConfig?.clanName ?? '').trim() || 'the clan';
      const requiresApproval = Boolean(loadRecruitConfig()?.waitlistRequiresApproval);

      if (requiresApproval) {
        return interaction.reply({
          content: `The **${clanName}** clan is currently full. Reach out to a leader if you'd like to be considered — they'll add you to the waitlist once approved.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
      const waitingListChannelId = String(runtime?.channels?.waitingListChannelId ?? '');
      const channelMention = isValidDiscordId(waitingListChannelId) ? `<#${waitingListChannelId}>` : '#waiting-list';

      addToWaitlist(db, String(interaction.user.id));
      if (isValidDiscordId(waitlistRoleId)) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) await member.roles.add(waitlistRoleId, 'Auto-assigned — applied while the clan was full').catch(() => {});
      }

      return interaction.reply({
        content: `The **${clanName}** clan is currently full, but you've been added to the waitlist. When a spot opens, KRAKEN will DM you — check ${channelMention} for updates.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const message = clanVerification.code === 'TAG_NOT_IN_CLAN'
      ? `That player tag is not in the current ${String(recruitConfig?.clanName ?? '').trim() || 'clan'} roster. Use your real current clan tag.`
      : 'KRAKEN could not verify your player tag against the current clan roster. Try again shortly.';
    return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: applyPublicAck, flags: MessageFlags.Ephemeral });

  const now = nowMs();
  const whenISO = new Date(now).toISOString();
  const reviewer = 'KRAKEN-AUTO';

  const profile = db.prepare('SELECT * FROM profiles WHERE discord_id = ?').get(String(interaction.user.id));
  const cooldownUntil = Number(profile?.cooldown_until ?? 0) || 0;
  if (!disableCooldowns && cooldownUntil > now) {
    await safeDm(interaction.user, dmCooldown);

    insertTrialLedger(db, {
      discord_id: String(interaction.user.id),
      player_tag: tag,
      score: 0,
      verdict: 'rejected',
      reasons: safeJson(['COOLDOWN_ACTIVE'], []),
      stats_snapshot: safeJson({ cooldown_until: cooldownUntil }, {}),
      created_at: now
    });

    upsertProfile(db, {
      discord_id: String(interaction.user.id),
      player_tag: tag,
      region: null,
      timezone: profile?.timezone ?? null,
      status: String(profile?.status ?? 'new'),
      last_score: profile?.last_score ?? null,
      last_verdict: 'cooldown',
      last_reasons: safeJson(['COOLDOWN_ACTIVE'], []),
      cooldown_until: cooldownUntil,
      probation_until: profile?.probation_until ?? null,
      created_at: Number(profile?.created_at ?? now) || now,
      updated_at: now
    });

    await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, formatDecisionLog({
      userId: interaction.user.id,
      tag,
      score: 0,
      verdict: 'cooldown',
      reasons: ['COOLDOWN_ACTIVE'],
      reviewer,
      whenISO
    }), runtime?.channels?.decisionsLogChannelId, 'Recruit cooldown decision');
    return;
  }

  const blacklistedRow = db.prepare('SELECT 1 FROM blacklist WHERE player_tag = ?').get(tag);
  if (blacklistedRow) {
    await safeDm(interaction.user, 'KRAKEN has already marked you. You are not welcome here.');
    insertTrialLedger(db, {
      discord_id: String(interaction.user.id),
      player_tag: tag,
      score: 0,
      verdict: 'rejected',
      reasons: safeJson(['BLACKLISTED'], []),
      stats_snapshot: safeJson({ blacklisted: true }, {}),
      created_at: now
    });
    await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, formatDecisionLog({
      userId: interaction.user.id,
      tag,
      score: 0,
      verdict: 'rejected',
      reasons: ['BLACKLISTED'],
      reviewer,
      whenISO
    }), runtime?.channels?.decisionsLogChannelId, 'Recruit blacklist decision');
    return;
  }

  // New flow: accept first, judge later once we have real tracked war data.
  // /apply (and the welcome Agree & Join button) records the player and opts them into tracking.
  const score = null;
  const reasons = [];

  // Prevent spam re-applying: fixed 24h cooldown from applying.
  const cooldown_until = disableCooldowns ? 0 : (now + 24 * 60 * 60 * 1000);
  const probation_until = null;

  const created_at = Number(profile?.created_at ?? now) || now;

  upsertProfile(db, {
    discord_id: String(interaction.user.id),
    player_tag: tag,
    region: null,
    timezone: profile?.timezone ?? null,
    status: 'probation',
    last_score: score,
    last_verdict: 'probation',
    last_reasons: safeJson(reasons, []),
    cooldown_until,
    probation_until,
    created_at,
    updated_at: now
  });

  // Do not write trial_ledger yet; the trial hasn't been judged.

  // In-game co-leaders/leaders get the Discord leaders role automatically. This is best-effort
  // and separate from the baseline grant below: the leaders role sits high in the hierarchy, so
  // if it's positioned above the bot the grant fails — but that must never block a member's core
  // onboarding, so it's attempted on its own and the outcome is just reported to leaders.
  const isClanLeader = ['leader', 'coleader'].includes(String(clanVerification.clanRole ?? '').toLowerCase());
  let leadersGranted = false;
  let leadersGrantAttempted = false;

  let rolesGranted = false;
  let roleError = null;
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    // Baseline War Hub roles: kraken-member + probation (no warcore/underwatch on entry).
    // applyRolesVerified checks the mutation against the actual resulting role
    // cache instead of assuming success — this used to unconditionally follow
    // up with a "Roles granted" DM even after already telling the user the
    // grant had failed, a contradictory pair of back-to-back messages.
    const warcoreRoleId = String(runtime?.roles?.warcoreRoleId ?? '');
    const underwatchRoleId = String(runtime?.roles?.underwatchRoleId ?? '');
    const newArrivalRoleId = String(runtime?.roles?.newArrivalRoleId ?? '');
    const removeRoleId = String(runtime?.roles?.removeRoleId ?? '');
    const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');

    const remove = [warcoreRoleId, underwatchRoleId, newArrivalRoleId, removeRoleId, waitlistRoleId];
    const add = [memberRoleId, probationRoleId];
    if (remove.some(id => isValidDiscordId(id) && member.roles.cache.has(id)) || add.some(id => isValidDiscordId(id) && !member.roles.cache.has(id))) {
      suppressManualTierSync(db, interaction.user.id);
    }

    const result = await applyRolesVerified(member, { add, remove, reason: 'KRAKEN onboarding: baseline access' });
    rolesGranted = result.ok;

    if (isClanLeader && isValidDiscordId(leadersRoleId) && !member.roles.cache.has(leadersRoleId)) {
      leadersGrantAttempted = true;
      const leadersResult = await applyRolesVerified(member, { add: leadersRoleId, reason: 'KRAKEN onboarding: in-game co-leader/leader' });
      leadersGranted = leadersResult.ok;
    }

    // Remove waitlist DB entry now that they've applied through the clan.
    removeFromWaitlist(db, String(interaction.user.id));
  } catch (e) {
    roleError = e;
  }

  // Report the leaders auto-grant outcome so a leader/owner has visibility — especially the
  // failure case, which almost always means the leaders role sits above the bot in the role list.
  if (leadersGrantAttempted) {
    const who = clanVerification.memberName ?? interaction.user.username;
    const note = leadersGranted
      ? `🛡️ **${who}** (#${tag}) is a co-leader/leader in-game — **leaders** role granted automatically.`
      : `🛡️ **${who}** (#${tag}) is a co-leader/leader in-game, but KRAKEN could not auto-grant the **leaders** role. Drag the leaders role **below** the bot's role in Server Settings → Roles, or grant it manually.`;
    await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, note, runtime?.channels?.decisionsLogChannelId, 'Recruit leaders auto-grant');
  }

  if (!rolesGranted) {
    const msg = `[RECRUIT] Role grant failed for <@${interaction.user.id}> (#${tag}). Check bot role hierarchy + Manage Roles.${roleError ? ` Error: ${formatErrorForLog(roleError)}` : ''}`;
    await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, msg, runtime?.channels?.decisionsLogChannelId, 'Recruit role grant failure');
    await safeDm(interaction.user, [
      'KRAKEN could not grant your roles.',
      'A leader has been notified to fix permissions/role order.',
    ].join('\n')).catch(() => {});
  } else {
    const displayName = clanVerification.memberName ?? interaction.member?.displayName ?? interaction.user.username;
    const { sent, alreadySent } = await sendWelcomeGuideDm(interaction.user, runtime, recruitConfig, db, { displayName });
    // alreadySent means nothing was attempted this call (e.g. a returning member who
    // got the guide during an earlier stint) — not a DM failure, so no fallback claiming
    // one is warranted.
    if (!sent && !alreadySent) {
      await safeDm(interaction.user, [
        'You are now enrolled and being tracked.',
        'Roles granted: **kraken-member** + **probation**.',
        'You stay on **probation** through your first full war week.',
        'KRAKEN reviews roles automatically as soon as the current war week closes.',
        'WARCORE requires a perfect **32/32** across **2 complete wars**.',
        '',
        '_I couldn\'t DM you the full welcome guide — check your privacy settings or open the pinned post in the server._',
      ].join('\n'));
    }
  }

  await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, formatDecisionLog({
    userId: interaction.user.id,
    tag,
    score: 0,
    verdict: 'probation (tracking started)',
    reasons,
    reviewer,
    whenISO
  }), runtime?.channels?.decisionsLogChannelId, 'Recruit onboarding decision');
}

function buildRelinkPanelContainer() {
  return buildDashboardContainer({
    accentColor: STATUS_COLORS.neutral,
    thumbnailUrl: CLAN_BADGE_URL,
    header: '## 🐙 KRAKEN — Already in the Clan?',
    blocks: [
      [
        'If you\'re already a member of this clan and this is your first time linking to KRAKEN, use this instead of the welcome panel — this keeps your current standing instead of starting you over on probation.',
        '',
        'New to the clan? Use **#welcome** instead.',
      ].join('\n'),
    ],
  });
}

function buildRelinkPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('recruit:relink:open')
        .setLabel('Link My Account')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

// Panel posted in #relink on bot startup and /recruit-setup — same self-healing pattern as
// the welcome/break/appeals/waitlist panels.
export async function ensureRelinkPost(client, recruitConfig, db) {
  const runtime = getRecruitRuntimeIds(db);
  const relinkChannelId = String(runtime?.channels?.relinkChannelId ?? '');
  if (!isValidDiscordId(relinkChannelId)) return;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const channel = await client.channels.fetch(relinkChannelId).catch(() => null);
  if (!channel?.send) return;
  if (recruitGuildId && channel.guildId && channel.guildId !== recruitGuildId) return;

  const existingPanelId = String(getRecruitSetting(db, 'messages.relinkPanelId') ?? '');
  const panelPayload = {
    flags: MessageFlags.IsComponentsV2,
    components: [buildRelinkPanelContainer(), ...buildRelinkPanelComponents()],
    allowedMentions: { parse: [] },
  };

  const { message, changed } = await ensurePersistentPanel({
    channel,
    existingId: existingPanelId || null,
    payload: panelPayload,
    pin: true,
    logPrefix: '[RECRUIT] Relink panel',
  });
  if (changed && message?.id) setRecruitSetting(db, 'messages.relinkPanelId', message.id);
}

// --- Member: open relink modal ---
export async function handleRelinkButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('recruit:relinkModal')
    .setTitle('Link Your Account');

  const tagInput = new TextInputBuilder()
    .setCustomId('tag')
    .setLabel('Player tag (with or without #)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20)
    .setPlaceholder('#ABC2YGV');

  modal.addComponents(new ActionRowBuilder().addComponents(tagInput));
  await interaction.showModal(modal);
}

export async function relinkCore(interaction, ctx, input) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const memberRoleId = String(runtime?.roles?.memberRoleId ?? '');
  const probationRoleId = String(runtime?.roles?.probationRoleId ?? '');
  if (!isValidDiscordId(memberRoleId) || !isValidDiscordId(probationRoleId)) {
    return interaction.reply({
      content: 'Recruit is not set up yet (missing role IDs). Ask an admin to run `/recruit-setup`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rawTag = String(input?.tag ?? '');
  const tag = normalizePlayerTag(rawTag);
  if (!tag || tag.length < 3) {
    return interaction.reply({ content: 'Invalid tag. Provide a real player tag.', flags: MessageFlags.Ephemeral });
  }

  const clanVerification = await verifyTagInCurrentClan(tag);
  if (!clanVerification.ok) {
    const message = clanVerification.code === 'TAG_NOT_IN_CLAN'
      ? `That player tag is not in the current ${String(recruitConfig?.clanName ?? '').trim() || 'clan'} roster. Use your real current clan tag.`
      : 'KRAKEN could not verify your player tag against the current clan roster. Try again shortly.';
    return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  const clashConflict = db.prepare('SELECT discord_id FROM profiles WHERE player_tag = ? AND discord_id != ?').get(tag, String(interaction.user.id));
  if (clashConflict?.discord_id) {
    return interaction.reply({
      content: 'That player tag is already linked to another Discord account. Ask a leader to clean up the old link first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const now = nowMs();
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const existing = db.prepare('SELECT * FROM profiles WHERE discord_id = ?').get(String(interaction.user.id));
  const previousTag = normalizePlayerTag(existing?.player_tag);
  const timezone = String(existing?.timezone ?? '').trim() || null;
  const status = existing?.status ? String(existing.status) : statusFromCurrentRoles(member, runtime);

  const activeBreak = getActiveBreak(db, interaction.user.id);
  resetRelinkTrackingState(db, interaction.user.id, { preserveBreaks: Boolean(activeBreak) });

  upsertProfile(db, {
    discord_id: String(interaction.user.id),
    player_tag: tag,
    region: existing?.region ?? null,
    timezone,
    status,
    last_score: null,
    last_verdict: 'relinked',
    last_reasons: safeJson(['RELINK_RESET'], []),
    cooldown_until: 0,
    probation_until: null,
    created_at: Number(existing?.created_at ?? now) || now,
    updated_at: now,
  });

  if (member && isValidDiscordId(memberRoleId) && !member.roles.cache.has(memberRoleId)) {
    suppressManualTierSync(db, interaction.user.id);
    const { ok } = await applyRolesVerified(member, { add: memberRoleId, reason: 'KRAKEN relink: restore baseline clan member role' });
    if (!ok) console.error(`[RECRUIT] Relink role restore incomplete for <@${interaction.user.id}> — audit log below still records the relink.`);
  }

  // Remove from waitlist — relinked members are back in the clan.
  if (member) {
    const waitlistRoleId = String(runtime?.roles?.waitlistRoleId ?? '');
    if (isValidDiscordId(waitlistRoleId) && member.roles.cache.has(waitlistRoleId)) {
      await member.roles.remove(waitlistRoleId, 'KRAKEN relink: back in clan').catch(() => {});
    }
  }
  removeFromWaitlist(db, String(interaction.user.id));

  const sessionOwnerUserId = String(getRecruitSetting(db, 'relink.session.ownerUserId') ?? '');
  const expectedCount = Math.max(1, Number(getRecruitSetting(db, 'relink.session.expectedCount') ?? 8) || 8);
  const completed = new Set(parseCompletedRelinks(getRecruitSetting(db, 'relink.session.completedUserIds')));
  completed.add(String(interaction.user.id));
  setRecruitSetting(db, 'relink.session.completedUserIds', JSON.stringify([...completed]));

  await interaction.reply({
    content: previousTag && previousTag !== tag
      ? `Link updated. Stored tag changed from **#${previousTag}** to **#${tag}**. Relink progress: **${completed.size}/${expectedCount}**.`
      : `Link stored. Your Clash Royale tag is now **#${tag}**. Relink progress: **${completed.size}/${expectedCount}**.`,
    flags: MessageFlags.Ephemeral,
  });

  const logLine = [
    '[RECRUIT] Player link updated.',
    `User: ${interaction.user.tag} (${interaction.user.id})`,
    `Previous tag: ${previousTag ? `#${previousTag}` : '(none)'}`,
    `New tag: #${tag}`,
    `Status kept: ${status}`,
    'Tracking reset: yes (trial/break/probation/underwatch state cleared)',
    `Relink progress: ${completed.size}/${expectedCount}`,
  ].join('\n');
  await safeSendToChannel(interaction.client, runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId, logLine, runtime?.channels?.decisionsLogChannelId, 'Recruit relink decision');

  const alreadyNotified = String(getRecruitSetting(db, 'relink.session.notified') ?? '') === '1';
  if (!alreadyNotified && completed.size >= expectedCount && isValidDiscordId(sessionOwnerUserId)) {
    try {
      const owner = await interaction.client.users.fetch(sessionOwnerUserId);
      await owner.send([
        'KRAKEN relink session complete.',
        `Completed: ${completed.size}/${expectedCount}`,
        `Latest relink: ${interaction.user.tag} -> #${tag}`,
        'Current clan members who used the panel should now be relinked and reset to a clean recruit-tracking baseline.',
      ].join('\n'));
      setRecruitSetting(db, 'relink.session.notified', '1');
    } catch {
      // ignore DM failures
    }
  }
}
