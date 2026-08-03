import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getClan } from '../../cr-api.js';
import { loadHistory, saveHistory, backupHistoryFile, acquireHistoryLock, releaseHistoryLock } from '../../history.js';
import { resolveReportsChannel } from '../../schedule.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import { buildConfirmCancelRow } from '../../dashboard-components.js';
import { buildSeasonReport } from '../season-report-builder.js';
import {
  checkCanRollSeason,
  rollSeasonBoundary,
  SEASON_ROLLOVER_SCOPE_NOTE,
} from '../season-rollover.js';
import { getExpectedDecksPerDay, getRecruitRuntimeIds } from '../db.js';

export const command = {
  name: 'recruit-season-reset',
  description: '⚠️ Posts the final season report and rolls to a new season (confirm required, leaders/admin only)',
};

// Recomputes everything a rollover needs from scratch: guard check, live clan
// fetch, season report, and leader channel resolution. Called fresh by BOTH the
// initial preview AND the confirm step below — never passing state between the
// two interactions, since a leader could sit on the confirm prompt for a while
// and the source of truth (live roster, history.json) could change in that
// window. Sharing this IMPLEMENTATION (not just the intent) means a future
// change to the sequence only has to happen once.
async function prepareSeasonRollover({ interaction, db }) {
  const CLAN_TAG = process.env.CLAN_TAG;
  if (!CLAN_TAG) return { ok: false, reason: 'CLAN_TAG not configured.' };

  const history = loadHistory();
  const guard = checkCanRollSeason(history);
  if (!guard.ok) {
    return {
      ok: false,
      reason: `⚠️ ${guard.reason}\n\nIf you're sure this is right, ask whoever manages the bot to run \`FORCE=1 node scripts/season-reset.js\` from the terminal instead — there's no override for this from Discord.`,
    };
  }

  const clan = await getClan(CLAN_TAG);
  const expectedDecksPerDay = getExpectedDecksPerDay(db);
  const result = buildSeasonReport({ clan, history, db, expectedDecksPerDay });
  if (!result.ok) return { ok: false, reason: result.reason };

  const resolved = await resolveReportsChannel(interaction.client, db);
  if (!resolved.channel) {
    return { ok: false, reason: `Could not resolve leader channel to post to: ${resolved.reason}` };
  }

  return { ok: true, result, resolved };
}

export async function handleSeasonReset(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);

  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return;

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({
      content: 'Only leaders/admin can run this.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const prep = await prepareSeasonRollover({ interaction, db });
    if (!prep.ok) return interaction.editReply({ content: prep.reason });

    const { result, resolved } = prep;
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Confirm: Roll to a New Season')
      .setColor(0xed4245)
      .setDescription([
        `This will post the season's final top-5 report (**${result.rows.length}** player(s), **${result.season.weeksCounted}** war week(s)) to <#${resolved.channelId}>, then start a new season counting from today.`,
        '',
        SEASON_ROLLOVER_SCOPE_NOTE,
        '',
        'Click Confirm to do this now, or Cancel to back out.',
      ].join('\n'));

    const row = buildConfirmCancelRow({
      confirmCustomId: 'recruit:seasonResetConfirm',
      confirmLabel: 'Confirm — post report & roll season',
      cancelCustomId: 'recruit:seasonResetCancel',
    });

    return interaction.editReply({ embeds: [embed], components: [row] });
  } catch (e) {
    return interaction.editReply({ content: `Season reset preview failed: ${String(e?.message ?? e)}` });
  }
}

export async function handleSeasonResetConfirm(interaction, ctx) {
  const recruitConfig = ctx?.recruitConfig;
  const db = ctx?.db;
  const runtime = ctx?.runtime ?? getRecruitRuntimeIds(db);
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');

  if (interaction.guildId !== recruitGuildId) return;

  const leadersRoleId = String(runtime?.roles?.leadersRoleId ?? '');
  if (!isLeaderOrAdmin(interaction, leadersRoleId)) {
    return interaction.reply({ content: 'Only leaders/admin can run this.', flags: MessageFlags.Ephemeral });
  }

  await interaction.update({ content: 'Rolling the season…', embeds: [], components: [] });

  // Acquired BEFORE prepareSeasonRollover (not just before the write) — a
  // second Confirm click's guard-check-and-report-build must not run
  // concurrently with a first click's still-in-flight roll, only to acquire
  // the freed lock afterward and post an already-stale report against an
  // already-rolled boundary. Only one confirm's ENTIRE prepare-through-post
  // sequence runs at a time; a second one blocks here until the first fully
  // finishes and releases, then its own FRESH checkCanRollSeason call (inside
  // prepareSeasonRollover, called below) correctly refuses since the season
  // was just rolled this month. This is also the same lock the bot's own
  // routine snapshot writer respects (src/history.js), so a rollover can't
  // race that either.
  const lock = acquireHistoryLock();
  if (!lock.acquired) {
    return interaction.editReply({ content: lock.reason });
  }

  try {
    const prep = await prepareSeasonRollover({ interaction, db });
    if (!prep.ok) return interaction.editReply({ content: prep.reason });

    const { result, resolved } = prep;

    // Roll the boundary FIRST, then post — a failure writing history.json
    // aborts before anything's posted to Discord, instead of risking a
    // "final" report posted for a season that never rolled.
    const backupPath = backupHistoryFile();
    if (!backupPath) {
      return interaction.editReply({ content: 'history.json not found — aborting before any post.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    // Reloaded fresh (not reusing the `history` object the report was built
    // from) in case something else wrote a newer snapshot in the meantime —
    // saveHistory() is a full overwrite, not a merge. rollSeasonBoundary
    // derives outgoingStart from THIS fresh reload itself, not a value read
    // earlier before the lock, so it can't disagree with what's saved.
    const h = loadHistory();
    const { outgoingStart } = rollSeasonBoundary(h, { today });
    saveHistory(h);

    try {
      await resolved.channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [result.container],
        allowedMentions: { parse: [] },
      });
    } catch (postError) {
      // The boundary is ALREADY rolled and saved above by this point — this is
      // a different, worse situation than a prep/roll failure, since a plain
      // "failed" message would wrongly suggest nothing happened. checkCanRollSeason
      // now blocks a re-roll this month, so the outgoing report has to be
      // posted manually from here (the pre-roll backupHistoryFile() snapshot
      // has the data if it's needed).
      return interaction.editReply({
        content: [
          `⚠️ The season boundary WAS rolled to **${today}**${outgoingStart ? ` (previous season: ${outgoingStart} to ${today})` : ''}, but posting the report to <#${resolved.channelId}> failed: ${String(postError?.message ?? postError)}`,
          'This will not undo itself and won\'t roll again this month — post the outgoing season\'s standings manually (the pre-roll snapshot is in the newest data/history.json.bak-* file).',
        ].join('\n'),
      });
    }

    return interaction.editReply({
      content: [
        `Season report posted to <#${resolved.channelId}>.`,
        `New season started **${today}**${outgoingStart ? ` (previous season: ${outgoingStart} to ${today})` : ''}.`,
      ].join('\n'),
    });
  } catch (e) {
    return interaction.editReply({ content: `Season reset failed: ${String(e?.message ?? e)}` });
  } finally {
    releaseHistoryLock();
  }
}

export async function handleSeasonResetCancel(interaction) {
  return interaction.update({ content: 'Cancelled — nothing was changed.', embeds: [], components: [] });
}
