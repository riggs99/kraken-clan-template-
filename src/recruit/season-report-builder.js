// Builds the end-of-season top-5 report container — shared between the
// /recruit-season-report slash command (a leader checking standings any time,
// no side effects) and scripts/season-reset.js (which posts the FINAL report
// for the outgoing season as part of rolling to a new one). One implementation
// so the two surfaces can never drift on formatting, tie-break rules, or
// record-holder decoration.
import { liveClanTagSet, filterToCurrentClan } from '../war-intel.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS, medalOrRank } from '../dashboard-components.js';
import { cleanTag, daysSinceLastSeen } from '../util.js';
import { rankSeason } from './policy.js';
import { loadAllClanRecordHolders } from './clan-records.js';
import { getRecruitSetting } from './db.js';

// Real CR seasons run ~28-35 days (calendar-based, first Monday of each month —
// see project memory on season architecture intent). Not a hard rule (nothing
// validates seasonStart against the real CR calendar), just a generous threshold
// for nudging a leader that a season report looks overdue for a rollover instead
// of silently letting rankSeason's unbounded-if-unset fallback (see policy.js)
// aggregate multiple real seasons into one report with no visible signal.
const SEASON_LENGTH_WARNING_DAYS = 40;

// Placeholder for future season-end rewards (battle passes, cash, etc.) for the
// top 3 finishers in each category. Nothing reads or writes this anywhere else
// yet — fill in the reward text per rank when ready and buildRewardsBlock below
// will pick it up automatically. Left as null (renders "TBD") until then.
const SEASON_REWARDS = {
  fame: { 1: null, 2: null, 3: null },
  donations: { 1: null, 2: null, 3: null },
  warsPlayed: { 1: null, 2: null, 3: null },
};

// Marks a player's displayed name with which clan record(s) they currently hold,
// so a name is never shown bare when the player behind it is a record holder.
// Kept as a plain trailing parenthetical (not another em-dash) since the caller
// wraps this in "**name** — value" — a second "—" inside that same bold span
// read as a garbled double-dash.
function decorateName(name, tag, recordHolders) {
  const records = recordHolders.get(cleanTag(tag));
  if (!records?.length) return name;
  const labels = records.map(r => r.label).join(', ');
  return `👑 ${name} (Record Holder: ${labels})`;
}

// fameTotal is used as the secondary sort key for every category (not just fame's
// own list) so ties don't fall back straight to an arbitrary tag sort — e.g. on
// "Wars Played," where many active players commonly tie at the season's max week
// count, whoever contributed more fame breaks the tie instead of whoever's tag
// happens to sort first.
function topN(rows, key, n = 5) {
  return rows
    .filter(r => Number(r[key] ?? 0) > 0)
    .slice()
    .sort((a, b) =>
      Number(b[key] ?? 0) - Number(a[key] ?? 0)
      || Number(b.fameTotal ?? 0) - Number(a.fameTotal ?? 0)
      || a.tag.localeCompare(b.tag)
    )
    .slice(0, n);
}

function buildLeaderboardBlock(title, rows, key, unit, recordHolders) {
  if (!rows.length) return `### ${title}\nNo data this season.`;
  const lines = rows.map((r, i) => {
    const name = decorateName(r.name, r.tag, recordHolders);
    return `${medalOrRank(i)} **${name}** — ${Number(r[key] ?? 0).toLocaleString()}${unit}`;
  });
  return `### ${title}\n${lines.join('\n')}`;
}

function buildRewardsBlock() {
  const rankLabel = (rank) => (rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd');
  const line = (label, rewards) => {
    const parts = [1, 2, 3].map(rank => `${rankLabel(rank)}: ${rewards[rank] ?? '_TBD_'}`);
    return `**${label}:** ${parts.join(' · ')}`;
  };
  return [
    '### 🎁 Season Rewards',
    'Placeholder — rewards not finalized yet.',
    line('Fame', SEASON_REWARDS.fame),
    line('Donations', SEASON_REWARDS.donations),
    line('Wars Played', SEASON_REWARDS.warsPlayed),
  ].join('\n');
}

// Surfaces exactly how long the current season has run, using history.seasonStart
// (stamped by scripts/season-reset.js on each rollover) — the explicit season
// boundary marker in the data model. Falls back to trackingEpoch (matching
// rankSeason's own fallback in policy.js and checkCanRollSeason's in
// season-rollover.js) when seasonStart isn't set yet, so this never disagrees
// with what the roll guard/rankSeason are actually using as the boundary. Only
// reports "no boundary recorded yet" for a history.json with neither field set.
function describeSeasonPeriod(history) {
  const seasonStart = String(history?.seasonStart ?? history?.trackingEpoch ?? '').trim();
  if (!seasonStart) return { seasonStart: null, daysTracked: null };
  const daysTracked = daysSinceLastSeen(seasonStart);
  if (daysTracked === null) return { seasonStart: null, daysTracked: null };
  return { seasonStart, daysTracked: Math.max(0, daysTracked) };
}

// Returns { ok: true, container, season, rows } or { ok: false, reason }.
// `clan` must already be a live getClan() result; `history` an already-loaded
// loadHistory() result; `db` a recruit DB handle.
export function buildSeasonReport({ clan, history, db, expectedDecksPerDay }) {
  const currentTags = liveClanTagSet(clan);
  // A truly empty roster from a functioning, previously-populated clan almost
  // certainly means an upstream API hiccup (a 200 OK with a thin/empty payload)
  // rather than a real clan wipe — see sendDailyReport's identical guard in
  // schedule.js. Proceeding would report "no season data" even when real season
  // data exists, misleading whoever's reading this into thinking tracking broke.
  if (currentTags.size === 0) {
    return { ok: false, reason: 'Live clan roster came back empty — this looks like a Clash Royale API hiccup, not a real empty clan. Try again in a moment rather than trusting this run.' };
  }

  const season = rankSeason(history, expectedDecksPerDay);
  // Never list a player who has since left the clan, even if they contributed
  // heavily earlier this season — the report reflects who's here NOW.
  const rows = filterToCurrentClan(Object.values(season.byTag), clan);

  if (!rows.length) {
    return { ok: false, reason: 'No season data to report yet (no completed war weeks tracked since the season began).' };
  }

  const { seasonStart, daysTracked } = describeSeasonPeriod(history);
  const recordHolders = loadAllClanRecordHolders(db, getRecruitSetting);

  const trackingLine = seasonStart
    ? `Season started **${seasonStart}** (${daysTracked} day${daysTracked === 1 ? '' : 's'} ago) · **${season.weeksCounted}** war week${season.weeksCounted === 1 ? '' : 's'} completed.`
      + (daysTracked > SEASON_LENGTH_WARNING_DAYS
        ? '\n⚠️ Running long for a single CR season (~28-35 days) — check whether a rollover was missed.'
        : '')
    : `**${season.weeksCounted}** war week${season.weeksCounted === 1 ? '' : 's'} tracked (no season boundary recorded yet — showing full history).`
      + (history?.trackingEpoch ? ' If this spans more than one real season, run `scripts/season-reset.js` to establish a boundary going forward.' : '');

  const blocks = [
    `### 📅 Season Period\n${trackingLine}`,
    buildLeaderboardBlock('🏆 Top 5 — Season Fame', topN(rows, 'fameTotal'), 'fameTotal', ' fame', recordHolders),
    buildLeaderboardBlock('⚔️ Top 5 — Wars Played', topN(rows, 'warsPlayed'), 'warsPlayed', ' wars', recordHolders),
    buildLeaderboardBlock('💝 Top 5 — Season Donations', topN(rows, 'donationsTotal'), 'donationsTotal', ' donated', recordHolders),
    buildRewardsBlock(),
  ];

  const container = buildDashboardContainer({
    accentColor: STATUS_COLORS.healthy,
    thumbnailUrl: CLAN_BADGE_URL,
    header: `## 🏁 Season Report — ${clan?.name ?? 'Clan'}`,
    blocks,
  });

  return { ok: true, container, season, rows };
}
