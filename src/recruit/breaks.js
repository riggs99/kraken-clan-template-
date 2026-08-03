import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  getRecruitRuntimeIds,
  getActiveBreak,
  getProbationState,
  getRecruitSetting,
  getUnderwatchState,
  clearPostBreakEnforcement,
  setRecruitSetting,
  upsertActiveBreak,
  upsertProbationState,
  upsertUnderwatchState,
} from './db.js';
import { isLeaderOrAdmin, applyRolesVerified } from '../permissions.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function addDays(ms, days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return ms;
  return ms + Math.floor(d * 24 * 60 * 60 * 1000);
}

function ts(ms) {
  const seconds = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return `<t:${seconds}:F>`;
}

function safeTruncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

async function fetchMessageSafe(channel, messageId) {
  try {
    if (!channel || typeof channel.messages?.fetch !== 'function') return null;
    const msg = await channel.messages.fetch(messageId);
    return msg ?? null;
  } catch {
    return null;
  }
}

function missingChannelPerms(channel, userId) {
  try {
    if (!channel || typeof channel.permissionsFor !== 'function') return ['UNKNOWN_CHANNEL'];
    const perms = channel.permissionsFor(String(userId));
    if (!perms) return ['NO_PERMISSION_DATA'];

    const required = [
      ['ViewChannel', PermissionFlagsBits.ViewChannel],
      ['SendMessages', PermissionFlagsBits.SendMessages],
      ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
      ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
    ];

    const missing = required.filter(([, bit]) => !perms.has(bit)).map(([name]) => name);
    return missing;
  } catch {
    return ['PERMS_CHECK_FAILED'];
  }
}

function buildBreakInfoEmbed() {
  return new EmbedBuilder()
    .setTitle('🏖️ Taking a Break — How This Channel Works')
    .setColor(0x5865f2)
    .setDescription(
      'Need time away from war? KRAKEN covers you — but do it properly.\n' +
      'Breaks **pause your tracking** and protect your tier while you\'re away.'
    )
    .addFields(
      {
        name: '▶  Starting a break',
        value: [
          '1. Click **Request 7 days**, **Request 14 days**, or **Request 30 days** below',
          '2. Enter a short reason — leaders are notified immediately',
          '3. Your break starts instantly, the `on a break` role is added',
          '4. A notice appears here with an **I\'m Back** button for when you return',
        ].join('\n'),
        inline: false,
      },
      {
        name: '◀  Ending your break',
        value: [
          '• Click **I\'m Back** on your break notice in this channel',
          '• Your break ends immediately and KRAKEN resumes tracking',
          '• Your notice is removed — the channel stays clean',
        ].join('\n'),
        inline: false,
      },
      {
        name: '⚠️  After your break ends',
        value: [
          '• **The day before your break ends** — KRAKEN sends you a friendly reminder DM',
          '• **On the day your break ends** — KRAKEN sends a warning DM if you haven\'t clicked I\'m Back',
          '• If you still haven\'t returned, you will be placed in **Underwatch** for leader review',
          '• If the clan is full while you are in Underwatch, you may be removed to make room',
        ].join('\n'),
        inline: false,
      },
      {
        name: '⏱️  Maximum break length',
        value: [
          '30 days is the maximum break length.',
          'If you do not return by the end of your break, you will be moved to **Underwatch** for review.',
          'If the clan is full at that point, leaders may remove you to make room for active members.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '📋  Logging',
        value: 'All break starts and returns are permanently recorded in the admin log. Leaders can always check the full history.',
        inline: false,
      },
    )
    .setFooter({ text: 'KRAKEN • breaks do not count against your tier' });
}

function buildBreakPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('On a Break')
    .setColor(0x2b2d31)
    .setDescription(
      [
        'If life pulls you under, do it properly.',
        '',
        'Request a **7‑day**, **14‑day**, or **30‑day** break.',
        'KRAKEN starts the break immediately and notifies leaders.',
        '',
        'While your break is active, you are temporarily excluded from KRAKEN\'s watch window.',
        '',
        '**30 days is the maximum.** If you do not return, you will be placed in Underwatch for review. If the clan is full, leaders may remove you to make room for active members.',
      ].join('\n')
    )
    .setFooter({ text: 'KRAKEN • Self-service break start, leader acknowledgement' });
}

function buildBreakPanelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('recruit:break:req:7')
      .setLabel('Request 7 days')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('recruit:break:req:14')
      .setLabel('Request 14 days')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('recruit:break:req:30')
      .setLabel('Request 30 days')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

async function purgeChannel(channel) {
  const cutoffMs = 14 * 24 * 60 * 60 * 1000 - 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100 });
    if (batch.size === 0) break;
    const now = Date.now();
    const bulk = batch.filter(m => now - m.createdTimestamp < cutoffMs);
    const old = batch.filter(m => now - m.createdTimestamp >= cutoffMs);
    if (bulk.size >= 2) await channel.bulkDelete(bulk);
    else for (const m of bulk.values()) await m.delete().catch(() => {});
    for (const m of old.values()) await m.delete().catch(() => {});
    if (batch.size < 100) break;
  }
}

async function deleteUserBreakMessages(channel, targetUserId, db, botId) {
  try {
    const panelId = String(getRecruitSetting(db, 'messages.breakPanelId') ?? '');
    const infoId = String(getRecruitSetting(db, 'messages.breakInfoEmbedId') ?? '');
    let before;
    for (let i = 0; i < 3; i++) {
      const opts = { limit: 100 };
      if (before) opts.before = before;
      const batch = await channel.messages.fetch(opts);
      if (!batch.size) break;
      for (const [id, msg] of batch) {
        before = id;
        if (id === panelId || id === infoId) continue;
        if (msg.author?.id !== String(botId)) continue;
        const mentionsUser = (msg.embeds ?? []).some(e =>
          (e.description ?? '').includes(`<@${targetUserId}>`) ||
          (e.fields ?? []).some(f => (f.value ?? '').includes(`<@${targetUserId}>`))
        );
        if (mentionsUser) await msg.delete().catch(() => {});
      }
      if (batch.size < 100) break;
    }
  } catch {
    // ignore
  }
}

export async function ensureBreakPost(client, recruitConfig, db) {
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const runtime = getRecruitRuntimeIds(db);

  const onBreakChannelId = String(runtime?.channels?.onBreakChannelId ?? '');
  if (!isValidDiscordId(onBreakChannelId)) return;

  const channel = await client.channels.fetch(onBreakChannelId).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return;
  if (recruitGuildId && channel.guildId && channel.guildId !== recruitGuildId) return;

  const existingInfoId = String(getRecruitSetting(db, 'messages.breakInfoEmbedId') ?? '');
  const existingPanelId = String(getRecruitSetting(db, 'messages.breakPanelId') ?? '');
  // No info embed stored means first setup or post-reset — purge and re-post cleanly
  const shouldPurge = !existingInfoId;

  if (shouldPurge) {
    try { await purgeChannel(channel); } catch { /* ignore */ }
  }

  // Post or update the info embed (always first, pinned)
  const infoEmbed = buildBreakInfoEmbed();
  const existingInfo = (!shouldPurge && existingInfoId) ? await fetchMessageSafe(channel, existingInfoId) : null;
  let infoMsg = null;
  if (existingInfo) {
    try {
      await existingInfo.edit({ embeds: [infoEmbed], allowedMentions: { parse: [] } });
      infoMsg = existingInfo;
    } catch {
      // fall through to re-send
    }
  }
  if (!infoMsg) {
    infoMsg = await channel.send({ embeds: [infoEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    if (infoMsg?.id) {
      setRecruitSetting(db, 'messages.breakInfoEmbedId', infoMsg.id);
      await infoMsg.pin().catch(() => {});
    }
  }

  // Post or update the panel (below the info embed)
  const panelEmbed = buildBreakPanelEmbed();
  const panelComponents = buildBreakPanelComponents();
  const existingPanel = (!shouldPurge && existingPanelId) ? await fetchMessageSafe(channel, existingPanelId) : null;
  let panelMsg = null;
  if (existingPanel) {
    try {
      await existingPanel.edit({ embeds: [panelEmbed], components: panelComponents, allowedMentions: { parse: [] } });
      panelMsg = existingPanel;
    } catch {
      // fall through to re-send
    }
  }
  if (!panelMsg) {
    try {
      panelMsg = await channel.send({ embeds: [panelEmbed], components: panelComponents, allowedMentions: { parse: [] } });
    } catch (e) {
      const botId = client?.user?.id ?? 'unknown-bot';
      const missing = missingChannelPerms(channel, botId);
      console.error(
        `[RECRUIT] Break panel send failed (channel=${String(onBreakChannelId)} guild=${String(channel?.guildId ?? '')}) missingPerms=${missing.join(',')}:`,
        e
      );
      return;
    }
    if (panelMsg?.id) {
      setRecruitSetting(db, 'messages.breakPanelId', panelMsg.id);
      await panelMsg.pin().catch(() => {});
    }
  }
}

function insertBreakRequest(db, { discordId, days, reason }) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO break_requests (discord_id, days, reason, status, requested_at)
    VALUES (?, ?, ?, 'started', ?);
  `);
  const info = stmt.run(String(discordId), Number(days), String(reason), now);
  return { id: Number(info.lastInsertRowid), requestedAt: now };
}

function getBreakRequest(db, id) {
  return db.prepare('SELECT * FROM break_requests WHERE id = ?').get(Number(id));
}

function decideBreakRequest(db, { id, status, decidedBy }) {
  const now = Date.now();
  db.prepare(`
    UPDATE break_requests
    SET status = ?, decided_at = ?, decided_by = ?
    WHERE id = ?;
  `).run(String(status), now, decidedBy ? String(decidedBy) : null, Number(id));
  return now;
}

function buildDecisionEmbed({ request, statusLine }) {
  const userId = String(request.discord_id);
  const days = Number(request.days);
  const reason = safeTruncate(request.reason, 800);
  const when = ts(Number(request.requested_at));
  const decidedAt = request.decided_at ? ts(Number(request.decided_at)) : '';
  const decidedBy = request.decided_by ? `<@${String(request.decided_by)}>` : '';

  const embed = new EmbedBuilder()
    .setTitle('Break Request')
    .setColor(0x5865f2)
    .addFields(
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Duration', value: `${days} days`, inline: true },
      { name: 'Requested', value: when || 'Unknown', inline: true },
      { name: 'Reason', value: reason || '(none)', inline: false },
    );

  if (statusLine) {
    embed.addFields({ name: 'Status', value: statusLine, inline: false });
  } else if (request.status && request.status !== 'pending') {
    embed.addFields({
      name: 'Status',
      value: `${String(request.status)} ${decidedAt ? `• ${decidedAt}` : ''} ${decidedBy ? `• by ${decidedBy}` : ''}`.trim(),
      inline: false
    });
  }
  return embed;
}

function buildDecisionComponents(requestId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`recruit:break:ack:${requestId}`)
      .setLabel('Acknowledge')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

async function safeDm(user, content) {
  if (!user) return false;
  try {
    await user.send({ content });
    return true;
  } catch {
    return false;
  }
}

async function safeSend(client, channelId, payload) {
  if (!isValidDiscordId(channelId)) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') return null;
    return await channel.send(payload);
  } catch {
    return null;
  }
}

async function sendAuditMessage(client, runtime, primaryChannelId, payload, context) {
  const primaryId = String(primaryChannelId ?? '');
  const logsId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');

  const primarySent = await safeSend(client, primaryId, payload);
  if (primarySent) return { ok: true, channelId: primaryId, fallbackUsed: false };

  console.error(`[RECRUIT] ${context} failed: primaryChannel=${primaryId || 'missing'} fallbackChannel=${logsId || 'missing'}`);

  if (!isValidDiscordId(logsId) || logsId === primaryId) {
    return { ok: false, channelId: null, fallbackUsed: false };
  }

  const fallbackSent = await safeSend(client, logsId, payload);
  if (fallbackSent) {
    console.error(`[RECRUIT] ${context} fallback sent to logs channel ${logsId}`);
    return { ok: true, channelId: logsId, fallbackUsed: true };
  }

  console.error(`[RECRUIT] ${context} fallback failed: logsChannel=${logsId}`);
  return { ok: false, channelId: null, fallbackUsed: true };
}

async function getUser(client, userId) {
  try {
    return client.users.cache.get(String(userId)) ?? await client.users.fetch(String(userId));
  } catch {
    return null;
  }
}

export async function handleBreakInteraction(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return false;

  // Request buttons -> modal
  if (
    interaction.isButton() &&
    typeof interaction.customId === 'string' &&
    interaction.customId.startsWith('recruit:break:req:')
  ) {
    const days = Number(interaction.customId.split(':').pop());
    if (![7, 14, 30].includes(days)) {
      await interaction.reply({ content: 'Invalid break length.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const onBreakChannelId = String(runtime?.channels?.onBreakChannelId ?? '');
    if (isValidDiscordId(onBreakChannelId) && interaction.channelId !== onBreakChannelId) {
      await interaction.reply({ content: 'Use the break panel in #on-a-break.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`recruit:break:modal:${days}`)
      .setTitle(`Request ${days} day break`);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason (required)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(400)
      .setPlaceholder('Short and clear. Leaders are notified.');

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
    return true;
  }

  // Modal submit -> start break immediately + notify leaders
  if (
    interaction.isModalSubmit() &&
    typeof interaction.customId === 'string' &&
    interaction.customId.startsWith('recruit:break:modal:')
  ) {
    const days = Number(interaction.customId.split(':').pop());
    if (![7, 14, 30].includes(days)) {
      await interaction.reply({ content: 'Invalid break length.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const reason = String(interaction.fields.getTextInputValue('reason') ?? '').trim();
    if (!reason) {
      await interaction.reply({ content: 'Reason is required.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Block if already on an active break
    const existingBreak = getActiveBreak(db, interaction.user.id);
    if (existingBreak) {
      const endsTs = Math.floor(Number(existingBreak.breakUntil) / 1000);
      await interaction.reply({
        content: `You already have an active break ending <t:${endsTs}:R>. Click **I'm Back** in this channel when you return.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // 21-day cooldown between breaks, counted from when the previous break actually
    // ended: the I'm Back click if the member returned early, otherwise the
    // scheduled end. Early returners don't wait longer than they need to.
    const lastBreak = db.prepare(
      "SELECT requested_at, days FROM break_requests WHERE discord_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1"
    ).get(String(interaction.user.id));
    if (lastBreak) {
      const COOLDOWN_DAYS = 21;
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      const requestedAt = Number(lastBreak.requested_at);
      const scheduledEnd = requestedAt + Number(lastBreak.days) * 24 * 60 * 60 * 1000;
      const lastReturn = Number(getRecruitSetting(db, `break.lastReturn.${interaction.user.id}`) ?? 0);
      const actualEnd = (lastReturn >= requestedAt && lastReturn < scheduledEnd) ? lastReturn : scheduledEnd;
      const availableAt = actualEnd + cooldownMs;
      if (Date.now() < availableAt) {
        const availTs = Math.floor(availableAt / 1000);
        await interaction.reply({
          content: `There is a ${COOLDOWN_DAYS}-day cooldown after each break ends. You can request your next break <t:${availTs}:R> (on <t:${availTs}:D>).`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
    }

    const { id: requestId } = insertBreakRequest(db, {
      discordId: interaction.user.id,
      days,
      reason,
    });

    const breakUntil = addDays(Date.now(), Number(days));
    upsertActiveBreak(db, {
      discordId: String(interaction.user.id),
      breakUntil,
      reason,
      grantedBy: 'KRAKEN-AUTO',
    });

    // Assign role immediately. The DB row above is the real authority for
    // break timing/expiry — this role is a visual indicator — but still
    // verify against the actual role cache rather than assuming success,
    // so a failed grant is at least logged instead of silently swallowed.
    const onBreakRoleId = String(runtime?.roles?.onBreakRoleId ?? '');
    if (isValidDiscordId(onBreakRoleId)) {
      const member = await interaction.guild.members.fetch(String(interaction.user.id)).catch(() => null);
      if (member) {
        const { ok } = await applyRolesVerified(member, { add: onBreakRoleId, reason: 'Break started (self-service)' });
        if (!ok) console.error(`[RECRUIT] On-break role grant incomplete for <@${interaction.user.id}>.`);
      }
    }

    await interaction.reply({ content: `Break started (**${days} days**). Leaders have been notified.`, flags: MessageFlags.Ephemeral });

    const rel = `<t:${Math.floor(Number(breakUntil) / 1000)}:R>`;

    // DM the user with the timer
    const targetUser = await getUser(interaction.client, interaction.user.id);
    await safeDm(targetUser, [
      'Your break has started.',
      `Duration: **${Number(days)} days**`,
      `Ends: ${rel} (${ts(breakUntil) || new Date(breakUntil).toISOString()})`,
    ].join('\n'));

    // Post countdown notice in #on-a-break
    const onBreakChannelId = String(runtime?.channels?.onBreakChannelId ?? '');
    const onBreakNotice = {
      embeds: [
        new EmbedBuilder()
          .setTitle('🐙 Break Logged')
          .setColor(0x2b2d31)
          .setDescription(
            [
              `<@${interaction.user.id}> sinks beneath the waves.`,
              '',
              '**KRAKEN marks the time.**',
            ].join('\n')
          )
          .addFields(
            { name: 'Duration', value: `**${Number(days)} days**`, inline: true },
            {
              name: 'Ends',
              value: `${ts(breakUntil) || new Date(breakUntil).toISOString()}\n${rel}`,
              inline: true,
            },
            { name: 'Reason', value: safeTruncate(reason, 200) || '(none)', inline: false },
          )
          .setFooter({ text: 'KRAKEN • Click I\'m Back when you return' }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`recruit:break:return:${interaction.user.id}`)
            .setLabel("I'm Back")
            .setStyle(ButtonStyle.Success),
        ),
      ],
      allowedMentions: { parse: [] },
    };
    await sendAuditMessage(
      interaction.client,
      runtime,
      onBreakChannelId,
      onBreakNotice,
      `Break start notice for user=${interaction.user.id}`
    );

    // Post decision embed to decisions channel (leaders)
    const decisionsChannelId = String(runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
    const request = getBreakRequest(db, requestId);
    if (request) {
      const decisionNotice = {
        embeds: [buildDecisionEmbed({ request, statusLine: `started • ends ${rel}` })],
        components: buildDecisionComponents(requestId),
        allowedMentions: { parse: [] },
      };
      await sendAuditMessage(
        interaction.client,
        runtime,
        decisionsChannelId,
        decisionNotice,
        `Break decision notice for user=${interaction.user.id} request=${requestId}`
      );
    }

    // Always log permanently to logsChannelId
    const logsChannelId = String(runtime?.channels?.logsChannelId ?? '');
    if (request && isValidDiscordId(logsChannelId) && logsChannelId !== decisionsChannelId) {
      await safeSend(interaction.client, logsChannelId, {
        embeds: [buildDecisionEmbed({ request, statusLine: `started • ends ${rel}` })],
        allowedMentions: { parse: [] },
      });
    }

    return true;
  }

  // Leaders acknowledge the already-started break for audit visibility.
  if (
    interaction.isButton() &&
    typeof interaction.customId === 'string' &&
    interaction.customId.startsWith('recruit:break:ack:')
  ) {
    const parts = interaction.customId.split(':');
    const requestId = Number(parts[3]);
    if (!Number.isFinite(requestId) || requestId <= 0) {
      await interaction.reply({ content: 'Invalid request id.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
    if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
      await interaction.reply({ content: 'Only leaders can acknowledge break notices.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const request = getBreakRequest(db, requestId);
    if (!request) {
      await interaction.reply({ content: 'Request not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    try {
      await interaction.deferUpdate();
    } catch {
      // If defer fails (already acknowledged), keep going and best-effort edit later.
    }

    if (String(request.status) === 'acknowledged') return true;

    const decidedAt = decideBreakRequest(db, {
      id: requestId,
      status: 'acknowledged',
      decidedBy: interaction.user.id
    });

    const statusLine = `acknowledged • ${ts(decidedAt)} • by <@${interaction.user.id}>`;

    const updated = {
      ...request,
      status: 'acknowledged',
      decided_at: decidedAt,
      decided_by: interaction.user.id
    };
    try {
      await interaction.editReply({
        embeds: [buildDecisionEmbed({ request: updated, statusLine })],
        components: [],
        allowedMentions: { parse: [] }
      });
    } catch {
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: 'Acknowledged.', flags: MessageFlags.Ephemeral });
        }
      } catch {
        // ignore
      }
    }

    // Notify the user that a leader acknowledged the notice.
    try {
      const targetUser = await getUser(interaction.client, request.discord_id);
      const endsRow = db.prepare('SELECT break_until FROM breaks WHERE discord_id = ?').get(String(request.discord_id));
      const ends = Number(endsRow?.break_until ?? 0) || addDays(Number(request.requested_at ?? Date.now()), Number(request.days));
      await safeDm(targetUser, [
        'A leader acknowledged your break notice.',
        `By: <@${interaction.user.id}>`,
        `Break length: **${Number(request.days)} days**`,
        `Ends: ${ts(ends) || new Date(ends).toISOString()}`,
      ].join('\n'));
    } catch {
      // ignore
    }
    return true;
  }

  // Member ends break early (manual return)
  if (
    interaction.isButton() &&
    typeof interaction.customId === 'string' &&
    interaction.customId.startsWith('recruit:break:return:')
  ) {
    const parts = interaction.customId.split(':');
    const targetId = String(parts[3] ?? '');
    if (!isValidDiscordId(targetId)) {
      await interaction.reply({ content: 'Invalid return button.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (String(interaction.user.id) !== targetId) {
      await interaction.reply({ content: 'This button is not for you.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const active = getActiveBreak(db, interaction.user.id);
    if (!active) {
      await interaction.reply({ content: 'You do not have an active break.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // DB cleanup
    try {
      db.prepare('DELETE FROM breaks WHERE discord_id = ?').run(String(interaction.user.id));
      clearPostBreakEnforcement(db, interaction.user.id);

      // Record the actual return so the between-breaks cooldown counts from when
      // they really came back, not the scheduled end of the break.
      setRecruitSetting(db, `break.lastReturn.${interaction.user.id}`, String(Date.now()));

      const underwatch = getUnderwatchState(db, interaction.user.id);
      if (underwatch && underwatch.pauseStartedAt != null) {
        const now = Date.now();
        upsertUnderwatchState(db, {
          discordId: interaction.user.id,
          startedAt: underwatch.startedAt,
          pauseAccumMs: (underwatch.pauseAccumMs ?? 0) + Math.max(0, now - underwatch.pauseStartedAt),
          pauseStartedAt: null,
          lastNotifiedAt: underwatch.lastNotifiedAt ?? null,
        });
      }

      const probation = getProbationState(db, interaction.user.id);
      if (probation?.paused) {
        upsertProbationState(db, {
          discordId: interaction.user.id,
          cleanStreakDays: probation.cleanStreakDays,
          lastEvalDay: probation.lastEvalDay,
          paused: false,
        });
      }
    } catch {
      // ignore DB failures; still try to remove role and confirm
    }

    // Remove on-break role
    const onBreakRoleId = String(runtime?.roles?.onBreakRoleId ?? '');
    if (isValidDiscordId(onBreakRoleId)) {
      try {
        const member = await interaction.guild.members.fetch(String(interaction.user.id));
        if (member && member.roles.cache.has(onBreakRoleId)) {
          await member.roles.remove(onBreakRoleId, 'Break ended (manual return)');
        }
      } catch {
        // ignore
      }
    }

    // Delete all break-related messages for this user from the channel
    try {
      if (interaction.channel) {
        await deleteUserBreakMessages(interaction.channel, targetId, db, interaction.client.user.id);
      }
    } catch {
      // ignore
    }

    // Build return log embed
    const endedAt = Date.now();
    const returnEmbed = new EmbedBuilder()
      .setTitle('Break Return')
      .setColor(0x57f287)
      .setDescription(`<@${targetId}> is back. KRAKEN tracking resumes immediately.`)
      .addFields({ name: 'Returned', value: ts(endedAt) || new Date(endedAt).toISOString(), inline: true });

    // Log to decisions channel (leaders)
    const decisionsChannelId = String(runtime?.channels?.decisionsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
    const returnNotice = { embeds: [returnEmbed], allowedMentions: { parse: [] } };
    await safeSend(interaction.client, decisionsChannelId, returnNotice);

    // Always also log permanently to logsChannelId
    const logsChannelId = String(runtime?.channels?.logsChannelId ?? '');
    if (isValidDiscordId(logsChannelId) && logsChannelId !== decisionsChannelId) {
      await safeSend(interaction.client, logsChannelId, returnNotice);
    }

    // DM user
    const targetUser = await getUser(interaction.client, interaction.user.id);
    await safeDm(targetUser, 'Your break has ended. KRAKEN is watching again.');

    await interaction.editReply({ content: '👋 Welcome back. KRAKEN tracking has resumed.' });

    return true;
  }

  return false;
}
