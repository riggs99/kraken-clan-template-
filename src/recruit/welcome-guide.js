import { EmbedBuilder } from 'discord.js';
import { CLAN_BADGE_URL } from '../dashboard-components.js';
import { getRecruitSetting, setRecruitSetting } from './db.js';
import { loadRecruitConfig } from '../config/loadConfig.js';

const SEP = '────────────────────';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function channelRef(channelId, fallbackLabel) {
  return isValidDiscordId(channelId) ? `<#${channelId}>` : fallbackLabel;
}

export function getFeedbackChannelId(recruitConfig = null) {
  const fromConfig = String(recruitConfig?.channels?.feedbackChannelId ?? '').trim();
  if (isValidDiscordId(fromConfig)) return fromConfig;
  const fromEnv = String(process.env.RECRUIT_FEEDBACK_CHANNEL_ID ?? '').trim();
  if (isValidDiscordId(fromEnv)) return fromEnv;
  // No hardcoded fallback here on purpose — a real channel ID belonging to
  // one specific clan used to sit here as the "default," which would have
  // silently routed a *different* clan's bug reports into that original
  // clan's channel if this deployment never configured its own. channelRef's
  // fallbackLabel ('#feedback') already handles "not configured yet" cleanly.
  return '';
}

export function buildWelcomeGuideEmbeds(runtime, recruitConfig = null) {
  const breakRef = channelRef(runtime?.channels?.onBreakChannelId, '#on-a-break');
  const appealsRef = channelRef(runtime?.channels?.appealsChannelId ?? recruitConfig?.channels?.appealsChannelId, '#appeals');
  const feedbackRef = channelRef(getFeedbackChannelId(recruitConfig), '#feedback');
  const clanName = String(recruitConfig?.clanName ?? '').trim() || 'the clan';

  const embed1 = new EmbedBuilder()
    .setAuthor({ name: clanName, iconURL: CLAN_BADGE_URL })
    .setTitle('🐙 Welcome to KRAKEN (1/2)')
    .setColor(0x5865f2)
    .setThumbnail(CLAN_BADGE_URL)
    .setDescription([
      '> *As a clan grows, it gets harder to see who\'s really carrying war — and who\'s quietly fading out.*',
      '',
      'War decks · donations · activity · silence. At **50 members**, that\'s a lot to keep straight.',
      '',
      'That\'s why **KRAKEN** is here — not to nag you on Discord, but to keep **honest clan records** that actually last:',
      '```',
      'your tier  ·  your war history  ·  your breaks  ·  your standing',
      '```',
      '**Thank you** for being here and for backing the clan in war. 🤝',
    ].join('\n'))
    .addFields(
      {
        name: '📌 What this server is',
        value: [
          'Chat is welcome — but **nobody has to live here**.',
          '',
          'You\'re already linked. That\'s your ticket in. 🎟️',
          'From here, KRAKEN watches war + donations in the background while you just… play.',
          '',
          '✅ **Show up in war** → you\'ll barely notice it exists',
          '⚠️ **Coast or disappear** → it absolutely will notice',
          '',
          '_Your record persists season to season. Leaders see the full picture when it counts._',
          '',
          SEP,
        ].join('\n'),
      },
      {
        name: '🏅 How roles work (short)',
        value: [
          '🔎 **Probation** — starting out · proving yourself in war',
          '🛡️ **Warcore** — earned your spot · consistent contributor',
          '⚠️ **Underwatch** — slipping · time to step up again',
          '⛔ **Boot review** — flagged for removal · leaders act',
          '🏖️ **On a break** — legit time off · no stat penalty',
          '',
          '_Play your wars → move up · coast → move down. Roles update automatically after each war week._',
          '',
          SEP,
        ].join('\n'),
      },
      {
        name: '🏛️ Clan Hall of Fame',
        value: [
          '**One name per record.** The clan\'s ledger — not your private stats.',
          '',
          'Each record needs a **minimum bar** before it counts. When someone sets a record for the first time, or beats the current holder, KRAKEN posts a celebration in the Celebrations & Records thread (under #kraken-decisions). **Nothing repeats unless the record actually moves.**',
          '',
          '💝 **Top Donor** — longest run as #1 clan donor *(min. 4 consecutive war weeks)*',
          '⚔️ **War Champion** — longest run as #1 war performer *(min. 4 consecutive war weeks)*',
          '🛡️ **Iron Attendance** — longest run with zero war days missed *(min. 4 consecutive war weeks)*',
          '',
          'If a holder leaves, the record reverts to the previous holder still in clan — or shows **none** until someone sets it again.',
          '',
          SEP,
        ].join('\n'),
      },
    );

  const embed2 = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🐙 Welcome to KRAKEN (2/2)')
    .addFields(
      {
        name: '⚔️ Members — the deal',
        value: [
          '**Do:** play all wars · donate · stay in clan',
          '**Skip:** daily Discord grind · command spam · "checking in"',
          '',
          'Play consistently and you\'ll **never land on KRAKEN\'s radar.** 🎯',
          '',
          `Need a break? ${breakRef} — legit time off, **no hit** to role or stats. 🏖️`,
          '',
          SEP,
        ].join('\n'),
      },
      {
        name: '🛠️ Your tools',
        value: [
          '`/status` — tier, flags, break timer *(private)*',
          `${breakRef} — request time off · tap **I'm Back** when you return`,
          `${appealsRef} — dispute a tier call *(1 per 7 days)*`,
          '',
          SEP,
        ].join('\n'),
      },
      {
        name: '👑 Leaders — why KRAKEN exists',
        value: [
          'So every war-week call is based on **real records** across all 50 members — not memory, not guesswork.',
          '',
          '`/war` → live pulse · who\'s playing **today**, week totals',
          '`/standings` → full roster · sorted by tier action',
          '`/ops` → health · donations · promote/demote signals',
          '',
          '_KRAKEN tracks. We confirm the hard calls._ ⚖️',
          '',
          SEP,
        ].join('\n'),
      },
      {
        name: '🐛 Feedback',
        value: [
          `Wrong number, wrong role, something broken? Let us know in ${feedbackRef}.`,
          '',
          '_Appreciate any feedback — it keeps records accurate for everyone._',
          '',
          SEP,
        ].join('\n'),
      },
    )
    .setFooter({ text: `${clanName} · fair records · play your war · earn your spot`, iconURL: CLAN_BADGE_URL })
    .setTimestamp(new Date());

  return [embed1, embed2];
}

export function buildWelcomeGuideAllowedMentions(runtime, recruitConfig = null) {
  const channels = [
    getFeedbackChannelId(recruitConfig),
    runtime?.channels?.onBreakChannelId,
    runtime?.channels?.appealsChannelId ?? recruitConfig?.channels?.appealsChannelId,
  ].filter(id => isValidDiscordId(String(id ?? '')));
  return { parse: [], users: [], roles: [], channels };
}

export function welcomeGuideAlreadySent(db, discordId) {
  return getRecruitSetting(db, `welcome.guideDmSent.${discordId}`) === '1';
}

export function markWelcomeGuideSent(db, discordId) {
  setRecruitSetting(db, `welcome.guideDmSent.${discordId}`, '1');
}

/**
 * DM the full KRAKEN welcome guide (2 embeds).
 *
 * Returns { sent, alreadySent }: `sent` is true only when this call actually
 * delivered the DM just now. `alreadySent` distinguishes "skipped because the
 * guide already went out before" from a genuine send failure — callers that
 * show a DM-failure fallback message need this distinction, otherwise a
 * returning member (already marked welcome.guideDmSent from an earlier stint)
 * gets wrongly told their DM just failed when none was even attempted.
 */
export async function sendWelcomeGuideDm(user, runtime, recruitConfig, db, {
  displayName = null,
  force = false,
} = {}) {
  if (!user || user.bot) return { sent: false, alreadySent: false };
  const discordId = String(user.id);
  if (db && !force && welcomeGuideAlreadySent(db, discordId)) return { sent: false, alreadySent: true };

  const name = String(displayName ?? user.globalName ?? user.username ?? 'there').trim() || 'there';
  const embeds = buildWelcomeGuideEmbeds(runtime, recruitConfig ?? loadRecruitConfig());

  try {
    await user.send({
      content: [
        `Hey **${name}** — welcome to **KRAKEN**.`,
        '',
        'You\'re enrolled and being tracked. Roles: **kraken-member** + **probation**.',
        'Keep this message — it\'s your full guide to how the server works.',
      ].join('\n'),
      embeds,
      allowedMentions: buildWelcomeGuideAllowedMentions(runtime, recruitConfig),
    });
    if (db) markWelcomeGuideSent(db, discordId);
    return { sent: true, alreadySent: false };
  } catch {
    return { sent: false, alreadySent: false };
  }
}
