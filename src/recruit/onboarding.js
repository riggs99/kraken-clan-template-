import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getRecruitSetting, setRecruitSetting, getRecruitRuntimeIds } from './db.js';
import { buildWelcomeMarkdown } from './messages.js';
import { buildDashboardContainer, STATUS_COLORS, ensurePersistentPanel } from '../dashboard-components.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// No image ships with the template — each deployment supplies its own via
// `welcomeImagePath` in config/recruit.config.json (relative to the project
// root), or leaves it unset for a text-only welcome post. Never hardcode a
// specific clan's logo filename here again.

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

// ensureWelcomePost has two independent callers (index.js's ClientReady handler and
// setup.js's /recruit-setup command) — without this, both could race on the same
// stored message ID at once (e.g. a leader runs /recruit-setup right as the bot
// restarts), each delete-and-resend independently, and orphan a duplicate. Callers
// in the same process now just await the one in-flight run instead of racing it.
let inFlight = null;
export async function ensureWelcomePost(client, recruitConfig, db) {
  if (inFlight) return inFlight;
  inFlight = ensureWelcomePostInner(client, recruitConfig, db).finally(() => { inFlight = null; });
  return inFlight;
}

async function ensureWelcomePostInner(client, recruitConfig, db) {
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  const runtime = getRecruitRuntimeIds(db);

  const welcomeChannelId = String(runtime?.channels?.welcomeChannelId ?? '');
  if (!isValidDiscordId(welcomeChannelId)) return;

  const channel = await client.channels.fetch(welcomeChannelId).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return;
  if (recruitGuildId && channel.guildId && channel.guildId !== recruitGuildId) return;

  // Optional — a deployment that hasn't configured a logo just gets a
  // text-only welcome post, rather than the template shipping any specific
  // clan's image by default.
  const configuredImagePath = String(recruitConfig?.welcomeImagePath ?? '').trim();
  const imageName = configuredImagePath ? path.basename(configuredImagePath) : null;
  const imageAbsPath = configuredImagePath ? path.resolve(__dirname, '../../', configuredImagePath) : null;
  const imageExists = Boolean(imageAbsPath && fs.existsSync(imageAbsPath));

  const container = buildDashboardContainer({
    accentColor: STATUS_COLORS.neutral,
    thumbnailUrl: client.user?.displayAvatarURL?.() ?? null,
    heroImageUrl: imageExists ? `attachment://${imageName}` : null,
    header: '## 🐙 KRAKEN — Welcome to the War Hub',
    blocks: [buildWelcomeMarkdown(recruitConfig?.clanName), 'War Hub • Agree & Join to start'],
  });
  const files = imageExists ? [new AttachmentBuilder(imageAbsPath, { name: imageName })] : [];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('recruit:agree')
      .setLabel('Agree & Join')
      .setStyle(ButtonStyle.Primary),
  );

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
    files,
    allowedMentions: { parse: [] },
  };

  const existingId = getRecruitSetting(db, 'messages.welcomeMessageId');
  const { message, changed } = await ensurePersistentPanel({
    channel,
    existingId,
    payload,
    pin: true,
    logPrefix: '[RECRUIT] Welcome post',
  });
  if (changed && message?.id) setRecruitSetting(db, 'messages.welcomeMessageId', message.id);
}
