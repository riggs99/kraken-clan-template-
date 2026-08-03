import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getRecruitRuntimeIds, getRecruitSetting, setRecruitSetting } from '../db.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS, ensurePersistentPanel } from '../../dashboard-components.js';

const APPEAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REASON_LEN = 800;

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function safeTruncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function buildPanelContainer() {
  return buildDashboardContainer({
    accentColor: STATUS_COLORS.warn,
    thumbnailUrl: CLAN_BADGE_URL,
    header: '## 🐙 KRAKEN — Appeal a Decision',
    blocks: [
      [
        'Think a KRAKEN tier decision was wrong? Submit an appeal here.',
        '',
        'A leader will review your case and respond to you directly via DM.',
        '',
        '**One appeal per 7 days.**',
      ].join('\n'),
    ],
  });
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('recruit:appeal:open')
        .setLabel('Submit Appeal')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

// Posts a pending appeal to #appeals so leaders can act on it with buttons.
async function postPendingAppeal(client, db, { discordId, displayName, tag, status, reason }) {
  const runtime = getRecruitRuntimeIds(db);
  const appealsChannelId = String(runtime?.channels?.appealsChannelId ?? '');
  if (!isValidDiscordId(appealsChannelId)) return null;

  const ch = await client.channels.fetch(appealsChannelId).catch(() => null);
  if (!ch?.send) return null;

  const tagDisplay = tag ? ` — #${tag}` : '';
  const container = buildDashboardContainer({
    accentColor: STATUS_COLORS.warn,
    thumbnailUrl: CLAN_BADGE_URL,
    header: '## Pending Appeal',
    blocks: [
      [
        `**Member:** ${displayName}${tagDisplay}`,
        `**Discord:** <@${discordId}>`,
        `**Status:** ${status}`,
        `**Filed:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      ].join('\n'),
      `**Reason:**\n${safeTruncate(reason, 1024)}`,
      'Resolve below — member will be notified via DM.',
    ],
  });

  // Encode discordId in customId so the button handler knows who the appeal is for
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`recruit:appeal:resolve:overturn:${discordId}`)
      .setLabel('Overturn Decision')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`recruit:appeal:resolve:keep:${discordId}`)
      .setLabel('Keep Decision')
      .setStyle(ButtonStyle.Danger),
  );

  const msg = await ch.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container, buttonRow],
    allowedMentions: { parse: [] },
  }).catch(() => null);
  if (!msg?.id) return null;

  // Persist full appeal data keyed by message ID so it survives a bot restart
  setRecruitSetting(db, `appeal.pending.${msg.id}`, JSON.stringify({ discordId, displayName, tag, status, reason }));
  return msg.id;
}

async function logResolution(client, db, { discordId, displayName, tag, outcome, leaderNote, leaderName }) {
  const runtime = getRecruitRuntimeIds(db);
  const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
  if (!isValidDiscordId(logsChannelId)) return;

  const ch = await client.channels.fetch(logsChannelId).catch(() => null);
  if (!ch?.send) return;

  const tagDisplay = tag ? ` — #${tag}` : '';
  const outcomeLabel = outcome === 'overturn' ? 'Decision Overturned' : 'Decision Upheld';

  const container = buildDashboardContainer({
    accentColor: outcome === 'overturn' ? STATUS_COLORS.healthy : STATUS_COLORS.neutral,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `## Appeal Resolved — ${outcomeLabel}`,
    blocks: [
      [
        `**Member:** ${displayName}${tagDisplay}`,
        `**Discord:** <@${discordId}>`,
        `**Outcome:** ${outcomeLabel}`,
        `**Reviewed by:** ${leaderName}`,
        `**When:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      ].join('\n'),
      `**Leader note:**\n${safeTruncate(leaderNote, 1024)}`,
    ],
  });

  await ch.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

async function dmMember(client, discordId, { outcome, leaderNote }) {
  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return;

    const heading = outcome === 'overturn'
      ? '✅ **Your appeal has been reviewed — the decision has been overturned.**'
      : '❌ **Your appeal has been reviewed — the original decision has been upheld.**';

    const container = buildDashboardContainer({
      accentColor: outcome === 'overturn' ? STATUS_COLORS.healthy : STATUS_COLORS.neutral,
      thumbnailUrl: CLAN_BADGE_URL,
      header: '## 🐙 KRAKEN — Appeal Decision',
      blocks: [
        heading,
        `**Leader note:**\n${safeTruncate(leaderNote, 1024)}`,
        'If you have further questions, reach out to a clan leader directly.',
      ],
    });

    await user.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } catch { /* member may have DMs disabled or left the server */ }
}

// Panel posted in #appeals on bot startup
export async function ensureAppealsPost(client, recruitConfig, db) {
  const runtime = getRecruitRuntimeIds(db);
  const appealsChannelId = String(runtime?.channels?.appealsChannelId ?? '');
  if (!isValidDiscordId(appealsChannelId)) return;

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const channel = await client.channels.fetch(appealsChannelId).catch(() => null);
  if (!channel?.send) return;
  if (recruitGuildId && channel.guildId && channel.guildId !== recruitGuildId) return;

  const existingPanelId = String(getRecruitSetting(db, 'messages.appealPanelId') ?? '');
  const panelPayload = {
    flags: MessageFlags.IsComponentsV2,
    components: [buildPanelContainer(), ...buildPanelComponents()],
    allowedMentions: { parse: [] },
  };

  const { message, changed } = await ensurePersistentPanel({
    channel,
    existingId: existingPanelId || null,
    payload: panelPayload,
    logPrefix: '[RECRUIT] Appeal panel',
  });
  if (changed && message?.id) setRecruitSetting(db, 'messages.appealPanelId', message.id);
}

export async function handleAppealsInteraction(interaction, { db, client }) {
  const runtime = getRecruitRuntimeIds(db);

  // --- Member: open appeal modal ---
  if (interaction.isButton() && interaction.customId === 'recruit:appeal:open') {
    const discordId = String(interaction.user.id);
    const lastRaw = Number(getRecruitSetting(db, `appeal.lastSubmit.${discordId}`) ?? 0);
    if (lastRaw && (Date.now() - lastRaw) < APPEAL_COOLDOWN_MS) {
      const nextMs = Math.floor((lastRaw + APPEAL_COOLDOWN_MS) / 1000);
      await interaction.reply({
        content: `You already submitted an appeal recently. You can appeal again <t:${nextMs}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId('recruit:appeal:modal')
      .setTitle('Submit an Appeal');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('What are you appealing and why?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(MAX_REASON_LEN)
          .setPlaceholder('Explain the decision and why you think it was wrong.'),
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  // --- Member: appeal modal submitted ---
  if (interaction.isModalSubmit() && interaction.customId === 'recruit:appeal:modal') {
    const reason = safeTruncate(String(interaction.fields.getTextInputValue('reason') ?? '').trim(), MAX_REASON_LEN);
    if (!reason) {
      await interaction.reply({ content: 'Reason is required.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const discordId = String(interaction.user.id);
    const cooldownKey = `appeal.lastSubmit.${discordId}`;
    const lastRaw = Number(getRecruitSetting(db, cooldownKey) ?? 0);
    if (lastRaw && (Date.now() - lastRaw) < APPEAL_COOLDOWN_MS) {
      const nextMs = Math.floor((lastRaw + APPEAL_COOLDOWN_MS) / 1000);
      await interaction.reply({
        content: `You already submitted an appeal recently. You can appeal again <t:${nextMs}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const profile = db.prepare('SELECT player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);
    const displayName = String(interaction.member?.displayName ?? interaction.user.username);
    const tag = String(profile?.player_tag ?? '').replace(/^#/, '');
    const status = String(profile?.status ?? 'unknown');

    const posted = await postPendingAppeal(client, db, { discordId, displayName, tag, status, reason });
    if (!posted) {
      await interaction.reply({
        content: 'Could not post your appeal — the appeals channel may be misconfigured. Contact a leader directly.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    setRecruitSetting(db, cooldownKey, String(Date.now()));

    await interaction.reply({
      content: '✅ Your appeal has been submitted. A leader will review it and respond to you directly via DM.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // --- Leader: resolve button (Overturn / Keep Decision) ---
  if (interaction.isButton() && interaction.customId.startsWith('recruit:appeal:resolve:')) {
    if (!isLeaderOrAdmin(interaction, String(runtime?.roles?.leadersRoleId ?? ''))) {
      await interaction.reply({ content: 'Leaders only.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // customId: recruit:appeal:resolve:{outcome}:{discordId}
    const parts = interaction.customId.split(':');
    const outcome = parts[3];   // 'overturn' | 'keep'
    const discordId = parts[4];
    const msgId = interaction.message.id;

    const outcomeLabel = outcome === 'overturn' ? 'Overturn Decision' : 'Keep Decision';

    // Encode msgId in modal customId so the submit handler can delete the right message.
    // recruit:appeal:resolveModal:{outcome}:{discordId}:{msgId} — max ~73 chars, well under 100.
    const modal = new ModalBuilder()
      .setCustomId(`recruit:appeal:resolveModal:${outcome}:${discordId}:${msgId}`)
      .setTitle(outcomeLabel);

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note for the member (sent via DM)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(800)
          .setPlaceholder('Explain the outcome. This is sent to the member directly.'),
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  // --- Leader: resolve modal submitted ---
  if (interaction.isModalSubmit() && interaction.customId.startsWith('recruit:appeal:resolveModal:')) {
    if (!isLeaderOrAdmin(interaction, String(runtime?.roles?.leadersRoleId ?? ''))) {
      await interaction.reply({ content: 'Leaders only.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // customId: recruit:appeal:resolveModal:{outcome}:{discordId}:{msgId}
    const parts = interaction.customId.split(':');
    const outcome = parts[3];
    const discordId = parts[4];
    const msgId = parts[5];

    const leaderNote = safeTruncate(String(interaction.fields.getTextInputValue('note') ?? '').trim(), 800);
    if (!leaderNote) {
      await interaction.reply({ content: 'A note is required.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Read pending data and atomically claim it before doing anything else.
    // If changes === 0 another leader already resolved this — stop here.
    const pendingRaw = getRecruitSetting(db, `appeal.pending.${msgId}`);
    const claimed = db.prepare('DELETE FROM recruit_settings WHERE key = ?').run(`appeal.pending.${msgId}`);
    if (claimed.changes === 0) {
      await interaction.editReply({ content: 'This appeal has already been resolved by another leader.' });
      return true;
    }

    const pending = { discordId, displayName: `<@${discordId}>`, tag: '', status: 'unknown', reason: '' };
    if (pendingRaw) {
      try { Object.assign(pending, JSON.parse(pendingRaw)); } catch { /* malformed */ }
    }

    const leaderName = String(interaction.member?.displayName ?? interaction.user.username);

    // Delete the appeal embed from #appeals
    const appealsChannelId = String(runtime?.channels?.appealsChannelId ?? '');
    if (isValidDiscordId(appealsChannelId)) {
      const ch = await client.channels.fetch(appealsChannelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(msgId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    }

    // Log resolution to decisions/logs channel
    await logResolution(client, db, {
      discordId,
      displayName: pending.displayName,
      tag: pending.tag,
      outcome,
      leaderNote,
      leaderName,
    });

    // DM the member with the outcome
    await dmMember(client, discordId, { outcome, leaderNote });

    const outcomeLabel = outcome === 'overturn' ? 'overturned' : 'upheld';
    await interaction.editReply({
      content: `✅ Appeal resolved — decision **${outcomeLabel}**. Member notified via DM. Result logged.`,
    });
    return true;
  }

  return false;
}

// Slash command — leader fallback for submitting appeals
export const command = {
  name: 'recruit-appeal',
  description: 'Submit an appeal if you think a KRAKEN decision was incorrect',
  options: [
    {
      type: 3,
      name: 'reason',
      description: 'Explain what you are appealing and why',
      required: true,
      max_length: 800,
    },
  ],
};

export async function handleAppeal(interaction, { db, client }) {
  const reason = safeTruncate(String(interaction.options.getString('reason') ?? '').trim(), 800);
  if (!reason) {
    return interaction.reply({ content: 'Please provide a reason for your appeal.', flags: MessageFlags.Ephemeral });
  }

  const discordId = String(interaction.user.id);
  const cooldownKey = `appeal.lastSubmit.${discordId}`;
  const lastRaw = Number(getRecruitSetting(db, cooldownKey) ?? 0);
  if (lastRaw && (Date.now() - lastRaw) < APPEAL_COOLDOWN_MS) {
    const nextMs = Math.floor((lastRaw + APPEAL_COOLDOWN_MS) / 1000);
    return interaction.reply({
      content: `You already submitted an appeal recently. You can appeal again <t:${nextMs}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const profile = db.prepare('SELECT player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);
  const displayName = String(interaction.member?.displayName ?? interaction.user.username);
  const tag = String(profile?.player_tag ?? '').replace(/^#/, '');
  const status = String(profile?.status ?? 'unknown');

  const posted = await postPendingAppeal(client, db, { discordId, displayName, tag, status, reason });
  if (!posted) {
    return interaction.reply({
      content: 'Could not post your appeal — the appeals channel may be misconfigured. Contact a leader directly.',
      flags: MessageFlags.Ephemeral,
    });
  }
  setRecruitSetting(db, cooldownKey, String(Date.now()));

  return interaction.reply({
    content: '✅ Your appeal has been submitted. A leader will review it and respond to you directly via DM.',
    flags: MessageFlags.Ephemeral,
  });
}
