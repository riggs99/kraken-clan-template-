import { MessageFlags } from 'discord.js';
import { getRecruitRuntimeIds, getRecruitSetting, setRecruitSetting, clearPostBreakEnforcement, clearProbationState, clearUnderwatchState, upsertProbationState, upsertUnderwatchState } from './db.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../dashboard-components.js';

function isValidDiscordId(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function getTierRoleIds(runtime) {
  return {
    probation: String(runtime?.roles?.probationRoleId ?? ''),
    underwatch: String(runtime?.roles?.underwatchRoleId ?? ''),
    warcore: String(runtime?.roles?.warcoreRoleId ?? ''),
    remove: String(runtime?.roles?.removeRoleId ?? ''),
  };
}

function detectManagedTier(member, runtime) {
  const roles = member?.roles?.cache;
  if (!roles) return 'none';
  const ids = getTierRoleIds(runtime);
  if (isValidDiscordId(ids.remove) && roles.has(ids.remove)) return 'removed';
  if (isValidDiscordId(ids.underwatch) && roles.has(ids.underwatch)) return 'underwatch';
  if (isValidDiscordId(ids.probation) && roles.has(ids.probation)) return 'probation';
  if (isValidDiscordId(ids.warcore) && roles.has(ids.warcore)) return 'approved';
  return 'none';
}

function profileStatusFromManualTier(tier) {
  if (tier === 'warcore' || tier === 'approved') return 'approved';
  if (tier === 'probation') return 'probation';
  if (tier === 'underwatch') return 'underwatch';
  if (tier === 'removed') return 'removed';
  return 'probation';
}

function getSuppressKey(discordId) {
  return `manualTierSync.suppress.${String(discordId)}`;
}

export function suppressManualTierSync(db, discordId, ttlMs = 15000) {
  setRecruitSetting(db, getSuppressKey(discordId), String(Date.now() + Math.max(1000, Number(ttlMs) || 15000)));
}

function isSuppressed(db, discordId) {
  const raw = Number(getRecruitSetting(db, getSuppressKey(discordId)) ?? 0);
  return Number.isFinite(raw) && raw > Date.now();
}

async function safeSend(client, channelId, content, fallbackChannelId = null, context = 'Manual role sync decision') {
  if (!isValidDiscordId(channelId)) {
    if (!isValidDiscordId(fallbackChannelId)) return false;
    channelId = fallbackChannelId;
    fallbackChannelId = null;
  }
  const buildStringPayload = (text, accentColor) => ({
    flags: MessageFlags.IsComponentsV2,
    components: [buildDashboardContainer({
      accentColor,
      thumbnailUrl: CLAN_BADGE_URL,
      header: '## 🐙 KRAKEN Recruit Decision',
      blocks: [text],
    })],
  });

  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || typeof ch.send !== 'function') return false;
    const payload = typeof content === 'string' ? buildStringPayload(content, STATUS_COLORS.neutral) : (content ?? {});
    await ch.send({ ...payload, allowedMentions: { parse: [] } });
    return true;
  } catch {
    console.error(`[RECRUIT] ${context} failed: primaryChannel=${String(channelId)}`);
    if (!isValidDiscordId(fallbackChannelId) || String(fallbackChannelId) === String(channelId)) return false;
    try {
      const ch = await client.channels.fetch(fallbackChannelId);
      if (!ch || typeof ch.send !== 'function') return false;
      const payload = typeof content === 'string' ? buildStringPayload(content, STATUS_COLORS.critical) : (content ?? {});
      await ch.send({ ...payload, allowedMentions: { parse: [] } });
      console.error(`[RECRUIT] ${context} fallback sent to logs channel ${String(fallbackChannelId)}`);
      return true;
    } catch {
      console.error(`[RECRUIT] ${context} fallback failed: logsChannel=${String(fallbackChannelId)}`);
      return false;
    }
  }
}

export async function handleRecruitMemberUpdate(oldMember, newMember, { client, recruitConfig, db }) {
  try {
    const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
    if (!recruitGuildId || String(newMember?.guild?.id ?? '') !== recruitGuildId) return;

    const runtime = getRecruitRuntimeIds(db);
    const beforeTier = detectManagedTier(oldMember, runtime);
    const afterTier = detectManagedTier(newMember, runtime);
    if (beforeTier === afterTier) return;

    const discordId = String(newMember?.id ?? '');
    if (!isValidDiscordId(discordId)) return;
    if (isSuppressed(db, discordId)) return;

    const profile = db.prepare('SELECT discord_id, player_tag, status FROM profiles WHERE discord_id = ?').get(discordId);
    if (!profile) return;

    const nextStatus = profileStatusFromManualTier(afterTier);
    db.prepare(`
      UPDATE profiles
      SET status = ?, last_score = NULL, last_verdict = ?, last_reasons = ?, cooldown_until = 0, probation_until = NULL, updated_at = ?
      WHERE discord_id = ?
    `).run(nextStatus, 'manual_override', JSON.stringify([`MANUAL_ROLE_SYNC ${beforeTier}->${afterTier}`]), Date.now(), discordId);

    clearUnderwatchState(db, discordId);
    clearProbationState(db, discordId);
    clearPostBreakEnforcement(db, discordId);

    if (nextStatus === 'underwatch') {
      upsertUnderwatchState(db, {
        discordId,
        startedAt: Date.now(),
        pauseAccumMs: 0,
        pauseStartedAt: null,
        lastNotifiedAt: null,
      });
    }

    if (nextStatus === 'probation') {
      upsertProbationState(db, {
        discordId,
        cleanStreakDays: 0,
        lastEvalDay: null,
        paused: false,
      });
    }

    const decisionsChannelId = String(runtime?.channels?.decisionsChannelId ?? '');
    const logsChannelId = String(runtime?.channels?.logsChannelId ?? runtime?.channels?.decisionsLogChannelId ?? '');
    const name = String(newMember?.displayName ?? newMember?.user?.username ?? profile?.player_tag ?? discordId);
    const playerTag = String(profile?.player_tag ?? '').trim();
    const who = playerTag ? `${name} (#${playerTag.replace(/^#/, '')})` : name;
    await safeSend(client, decisionsChannelId, `[RECRUIT] Manual role sync: **${who}** ${beforeTier} -> ${afterTier}. KRAKEN will now evaluate from the manually assigned tier.`, logsChannelId, 'Manual role sync decision');
  } catch (e) {
    console.error('[RECRUIT] manual role sync failed:', String(e?.message ?? e));
  }
}
