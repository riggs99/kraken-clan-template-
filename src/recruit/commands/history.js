import { MessageFlags } from 'discord.js';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { cleanTag } from '../../util.js';
import { isWarActivityPresent, periodKeyForDay } from '../../war-cycle.js';
import { getRecruitRuntimeIds, getExpectedDecksPerDay } from '../db.js';
import { isLeaderOrAdmin } from '../../permissions.js';
import { renderTable, buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../../dashboard-components.js';
import { HISTORY_PATH } from '../../history.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ARCHIVES = 3;
const DEFAULT_DECKS_PER_WAR_DAY = 4;

// Module-level cache — keyed by file list so renames/additions invalidate it.
const archiveCache = { data: null, expiresAt: 0, fileNames: [] };

function isWarDay(dayEntry) {
  // Prefer the stored flag written by upsertTodaySnapshot since bot launch.
  if (typeof dayEntry?.warDay === 'boolean') return dayEntry.warDay;
  // Fallback for archives predating the warDay field.
  return isWarActivityPresent(dayEntry?.members ?? {});
}

async function loadArchivesCached() {
  let allFiles;
  try {
    allFiles = await fsPromises.readdir(DATA_DIR);
  } catch {
    return { archives: [], fileNames: [] };
  }

  const archiveFiles = allFiles
    // scripts/full-clan-reset.js now suffixes archives with a millisecond
    // timestamp too (history.archive-YYYY-MM-DD-<ms>.json), to stop a same-day
    // re-run from silently overwriting the prior archive — the (-\d+)? here
    // keeps matching both that new format and any pre-existing date-only ones.
    .filter(f => /^history\.archive-\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f))
    .sort()
    .reverse()
    .slice(0, MAX_ARCHIVES);

  const cacheValid =
    archiveCache.data !== null &&
    Date.now() < archiveCache.expiresAt &&
    archiveCache.fileNames.length === archiveFiles.length &&
    archiveFiles.every((f, i) => f === archiveCache.fileNames[i]);

  if (cacheValid) return { archives: archiveCache.data, fileNames: archiveFiles };

  const loaded = await Promise.all(
    archiveFiles.map(async (f) => {
      try {
        const raw = await fsPromises.readFile(path.join(DATA_DIR, f), 'utf8');
        return { file: f, data: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
  );

  archiveCache.data = loaded.filter(Boolean);
  archiveCache.expiresAt = Date.now() + CACHE_TTL_MS;
  archiveCache.fileNames = archiveFiles;
  return { archives: archiveCache.data, fileNames: archiveFiles };
}

function aggregateSeason(h, tag, decksPerWarDay = DEFAULT_DECKS_PER_WAR_DAY) {
  const days = Object.keys(h?.days ?? {}).sort();
  let found = false;

  // Group war-flagged buckets by real Supercell day — one real day can straddle
  // two calendar buckets (~09:40 UTC rollover), which both over-counted war days
  // and double-counted decksUsedToday (the same day's counter repeats in each
  // straddling bucket, so MAX within a period is the day's true total, not SUM).
  const warPeriods = new Map(); // key -> max decksUsedToday seen for that real day
  for (const day of days) {
    const dayEntry = h.days[day];
    const memberEntry = dayEntry?.members?.[tag];
    if (memberEntry !== undefined) found = true;
    if (!isWarDay(dayEntry)) continue;
    const key = periodKeyForDay(h, day);
    const decks = Number(memberEntry?.decksUsedToday ?? 0);
    warPeriods.set(key, Math.max(warPeriods.get(key) ?? 0, decks));
  }

  if (!found) return null;

  const warDaysTotal = warPeriods.size;
  const perDay = [...warPeriods.values()];
  const warDaysParticipated = perDay.filter(d => d > 0).length;
  const totalDecks = perDay.reduce((a, b) => a + b, 0);

  return {
    warDaysTotal,
    totalDecks,
    expectedDecks: warDaysTotal * decksPerWarDay,
    missedWarDays: warDaysTotal - warDaysParticipated,
    participationPct: warDaysTotal > 0
      ? Math.round((warDaysParticipated / warDaysTotal) * 100)
      : 0,
  };
}

function seasonLabel(filename) {
  const match = filename.match(/(\d{4})-(\d{2})-\d{2}/);
  if (!match) return filename;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(match[2], 10) - 1] ?? '?'} ${match[1]}`;
}

function buildTable(rows) {
  const columns = [
    { key: 'season', label: 'Season', width: 10 },
    { key: 'wars', label: 'Wars', width: 5, align: 'right' },
    { key: 'decks', label: 'Decks', width: 9, align: 'right' },
    { key: 'missed', label: 'Missed', width: 7, align: 'right' },
    { key: 'pct', label: 'Pct%', width: 5, align: 'right' },
  ];
  const tableRows = rows.map(({ label, stats }) => {
    if (!stats) return { season: label, wars: '—', decks: '—', missed: '—', pct: '—' };
    const { warDaysTotal, totalDecks, expectedDecks, missedWarDays, participationPct } = stats;
    return {
      season: label,
      wars: warDaysTotal,
      decks: `${totalDecks}/${expectedDecks}`,
      missed: missedWarDays,
      pct: `${participationPct}%`,
    };
  });
  return renderTable(columns, tableRows);
}

export const command = {
  name: 'recruit-history',
  description: 'Season-by-season war performance for a tracked member',
  options: [
    {
      type: 3, // STRING
      name: 'tag',
      description: 'Player tag (with or without #)',
      required: true,
    },
  ],
};

export async function handleHistory(interaction, { db }) {
  const runtime = getRecruitRuntimeIds(db);
  if (!isLeaderOrAdmin(interaction, String(runtime?.roles?.leadersRoleId ?? ''))) {
    return interaction.reply({ content: 'Leaders only.', flags: MessageFlags.Ephemeral });
  }
  const decksPerWarDay = getExpectedDecksPerDay(db) || DEFAULT_DECKS_PER_WAR_DAY;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawTag = String(interaction.options.getString('tag') ?? '').trim();
  const tag = cleanTag(rawTag);
  if (!tag) {
    return interaction.editReply({ content: 'Invalid player tag.' });
  }

  // Load current history
  let current = { firstSeen: {}, days: {} };
  try {
    current = JSON.parse(await fsPromises.readFile(HISTORY_PATH, 'utf8'));
  } catch { /* not yet written */ }

  // Load archives (cached)
  const { archives, fileNames } = await loadArchivesCached();

  // Ordered season list: current first, archives newest-first
  const seasons = [
    { label: 'Current', h: current },
    ...archives.map((a, i) => ({ label: seasonLabel(fileNames[i]), h: a.data })),
  ];

  const rows = seasons.map(({ label, h }) => ({ label, stats: aggregateSeason(h, tag, decksPerWarDay) }));

  if (rows.every(r => !r.stats)) {
    return interaction.editReply({ content: `No history found for **#${tag}**.` });
  }

  // Find player name from newest day that has it
  let playerName = `#${tag}`;
  outer: for (const { h } of seasons) {
    for (const dayKey of Object.keys(h?.days ?? {}).sort().reverse()) {
      const m = h.days[dayKey]?.members?.[tag];
      if (m?.name) { playerName = m.name; break outer; }
    }
  }

  // profiles.player_tag is stored without a leading '#' everywhere else in the
  // codebase (normalizePlayerTag strips it) — querying with one meant this lookup
  // never matched, so status always showed "unlinked" even for tracked members.
  const profile = db.prepare('SELECT status FROM profiles WHERE player_tag = ?').get(tag);
  const status = String(profile?.status ?? 'unlinked');

  const table = buildTable(rows);
  const archiveCount = archives.length;

  const container = buildDashboardContainer({
    accentColor: STATUS_COLORS.neutral,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `## ${playerName} — Season History`,
    blocks: [
      `**#${tag}** · Status: **${status}**\n${table}`,
      `Current + ${archiveCount} archive${archiveCount !== 1 ? 's' : ''} · cache 10 min`,
    ],
  });

  return interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  });
}
