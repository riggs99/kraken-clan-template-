import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import Database from 'better-sqlite3';
import { getClan, getCurrentRiverRace, getRiverRaceLog, shouldWarnDegraded } from './cr-api.js';
import { buildMemberIntel, filterToCurrentClan } from './war-intel.js';
import { upsertTodaySnapshot } from './history.js';
import { computeHistoryWeightedRisk, HIGH_RISK_THRESHOLD } from './risk-score.js';
import { calculateClanHealth } from './analytics.js';
import { cleanTag, daysSinceLastSeen, formatDaysAgo } from './util.js';
import { formatErrorForLog } from './security.js';
import { confirmMemberGone } from './permissions.js';
import { getWarDayDecision, isWarActivityPresent, parseWarAnchorMsFromEnv, warDayFromPeriodType, isHistoricalWarDay } from './war-cycle.js';
import { categorizeTierDecisions, evaluateWarTierPolicy, explainPolicyReason, summarizeWindow, tierFromProfileStatus } from './recruit/policy.js';
import { renderTable, renderSpotlight, buildDashboardContainer, CLAN_BADGE_URL } from './dashboard-components.js';
import { deltaSeries } from './window-delta.js';

// Keep the public surface minimal: one slash command (`/ops`) with a few focused tabs.
const TABS = ['overview', 'donations', 'actions'];
export const WINDOW_OPTIONS = [1, 7, 14];
export const PAGE_SIZE = 8;
const PICKER_PAGE_SIZE = 25;
const OPS_PANEL_BY_USER = new Map();
const OPS_DB_PATH = String(process.env.KRAKEN_DB_PATH || path.join(process.cwd(), 'data', 'kraken.db'));
export function getExpectedDecksPerDay() {
  try {
    const _db = new Database(OPS_DB_PATH);
    const _row = _db.prepare("SELECT value FROM recruit_settings WHERE key = ?").get('policy.expectedDecksPerDay');
    _db.close();
    if (_row?.value != null) { const n = Number(_row.value); if (Number.isFinite(n) && n > 0) return n; }
  } catch { /* ignore */ }
  return Number(process.env.EXPECTED_DECKS_PER_DAY ?? 4);
}
const OPS_MAX_LINE_CHARS = Number(process.env.OPS_MAX_LINE_CHARS ?? 118);

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function toWindowDays(v) {
  const n = Number(v);
  return WINDOW_OPTIONS.includes(n) ? n : 7;
}

export function toPage(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function validTab(tab) {
  return TABS.includes(tab) ? tab : 'overview';
}

export function pageSlice(list, page, pageSize = PAGE_SIZE) {
  const items = Array.isArray(list) ? list : [];
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = clamp(page, 0, totalPages - 1);
  const start = safePage * pageSize;
  return {
    pageItems: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    totalItems: items.length,
  };
}

function shortText(value, max = 18) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 3))}...`;
}

function clipLine(value, max = OPS_MAX_LINE_CHARS) {
  const s = String(value ?? '');
  if (!Number.isFinite(max) || max < 16) return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

export function displayNameWithRoles(m, roleCtx) {
  const tag = cleanTag(m?.tag);
  const clanRole = String(m?.role ?? roleCtx?.clanRoleByTag?.get?.(tag) ?? 'member');
  const discordRole = String(roleCtx?.discordRoleByTag?.get?.(tag) ?? 'unlinked');
  const name = shortText(m?.name ?? 'unknown', 16);
  const cRole = shortText(clanRole, 10);
  const dRole = shortText(discordRole, 10);
  return `**${name}**\nClan: ${cRole} | Discord: ${dRole}`;
}

export function bulletList(lines, empty = 'Nothing to show.') {
  const items = Array.isArray(lines)
    ? lines.map(line => String(line ?? '').trim()).filter(Boolean)
    : [];
  if (items.length === 0) return empty;
  return items.map(line => `• ${clipLine(line)}`).join('\n');
}

function sectionValue(summaryLines = [], detailLines = [], empty = 'Nothing to show.') {
  const summary = Array.isArray(summaryLines)
    ? summaryLines.map(line => String(line ?? '').trim()).filter(Boolean)
    : [];
  const details = Array.isArray(detailLines)
    ? detailLines.map(line => String(line ?? '').trim()).filter(Boolean)
    : [];
  if (summary.length === 0 && details.length === 0) return empty;
  if (details.length === 0) return summary.join('\n');
  if (summary.length === 0) return bulletList(details, empty);
  return `${summary.join('\n')}\n\n${bulletList(details, empty)}`;
}

function getTagToDiscordMapFromDb() {
  try {
    const db = new Database(OPS_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT player_tag, discord_id FROM profiles WHERE player_tag IS NOT NULL AND player_tag != '' AND discord_id IS NOT NULL AND discord_id != '' AND status != 'removed'").all();
    db.close();
    return new Map(rows.map(r => [cleanTag(r.player_tag), String(r.discord_id)]));
  } catch {
    return new Map();
  }
}

function getRecruitProfilesFromDb() {
  try {
    const db = new Database(OPS_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT player_tag, discord_id, status FROM profiles WHERE player_tag IS NOT NULL AND player_tag != '' AND status != 'removed'").all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// One query for every currently-on-break tag, rather than a per-member getActiveBreak
// lookup — used to give ops.js/war.js the same "Hold — on break" exemption war-board.js's
// independent policy pass already applies.
function getActiveBreakTagsFromDb() {
  try {
    const db = new Database(OPS_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT p.player_tag AS player_tag
      FROM breaks b
      JOIN profiles p ON p.discord_id = b.discord_id
      WHERE b.break_until > ? AND p.player_tag IS NOT NULL AND p.player_tag != ''
    `).all(Date.now());
    db.close();
    return new Set(rows.map(r => cleanTag(r.player_tag)));
  } catch {
    return new Set();
  }
}

// Warnings/notes used to live in a separate data/metadata.json file, disconnected from
// every other player-state table. Moved into kraken.db's player_warnings/player_notes
// tables (recruit/db.js's initDb — guaranteed to have run by the time /ops is ever used,
// since index.js calls getRecruitDb() unconditionally at startup regardless of whether
// Recruit HQ itself is enabled). Read/written via ops.js's own direct connections, same
// pattern as every other DB access in this file — never through recruit/db.js's shared
// handle, which this command doesn't otherwise touch.
//
// Shape matches the old metadata.json exactly ({ tag: [{date, reason/note, issuedBy}, ...] })
// so toTagCountMap and every existing caller below needed zero changes — only the source did.
function loadWarningsNotesFromDb() {
  const empty = { warnings: {}, notes: {} };
  try {
    const db = new Database(OPS_DB_PATH, { readonly: true, fileMustExist: true });
    const warningRows = db.prepare('SELECT player_tag, reason, issued_by, created_at FROM player_warnings ORDER BY created_at').all();
    const noteRows = db.prepare('SELECT player_tag, note, issued_by, created_at FROM player_notes ORDER BY created_at').all();
    db.close();

    const warnings = {};
    for (const r of warningRows) {
      const list = warnings[r.player_tag] ?? (warnings[r.player_tag] = []);
      list.push({ date: new Date(r.created_at).toISOString(), reason: r.reason, issuedBy: r.issued_by });
    }
    const notes = {};
    for (const r of noteRows) {
      const list = notes[r.player_tag] ?? (notes[r.player_tag] = []);
      list.push({ date: new Date(r.created_at).toISOString(), note: r.note, issuedBy: r.issued_by });
    }
    return { warnings, notes };
  } catch {
    return empty;
  }
}

function addPlayerWarningToDb(playerTag, reason, issuedBy) {
  const db = new Database(OPS_DB_PATH, { fileMustExist: true });
  try {
    db.prepare('INSERT INTO player_warnings (player_tag, reason, issued_by, created_at) VALUES (?, ?, ?, ?)')
      .run(String(playerTag), String(reason), issuedBy ? String(issuedBy) : null, Date.now());
  } finally {
    db.close();
  }
}

function addPlayerNoteToDb(playerTag, note, issuedBy) {
  const db = new Database(OPS_DB_PATH, { fileMustExist: true });
  try {
    db.prepare('INSERT INTO player_notes (player_tag, note, issued_by, created_at) VALUES (?, ?, ?, ?)')
      .run(String(playerTag), String(note), issuedBy ? String(issuedBy) : null, Date.now());
  } finally {
    db.close();
  }
}

export async function buildRoleContext(guild, members) {
  const clanRoleByTag = new Map((Array.isArray(members) ? members : []).map(m => [cleanTag(m.tag), String(m.role ?? 'member')]));
  const discordRoleByTag = new Map();
  const tagToDiscord = getTagToDiscordMapFromDb();
  if (!guild || !tagToDiscord.size) return { clanRoleByTag, discordRoleByTag };

  const tasks = [];
  for (const member of (Array.isArray(members) ? members : [])) {
    const tag = cleanTag(member?.tag);
    const discordId = tagToDiscord.get(tag);
    if (!tag || !discordId) continue;
    tasks.push(
      confirmMemberGone(guild, discordId).then((result) => {
        if (result.state === 'present') {
          const highest = result.member?.roles?.highest?.name;
          const roleName = highest && highest !== '@everyone' ? highest : 'member';
          discordRoleByTag.set(tag, roleName);
        } else if (result.state === 'gone') {
          discordRoleByTag.set(tag, 'not-in-server');
        }
        // 'unknown' (rate limit, network blip, mid-reconnect — inconclusive, not evidence
        // they left): leave unset so displayNameWithRoles falls back to 'unlinked' rather
        // than wrongly implying a still-present member has left the server.
      }),
    );
  }
  await Promise.all(tasks);
  return { clanRoleByTag, discordRoleByTag };
}

export function formatList(lines, empty = 'No data') {
  if (!lines || lines.length === 0) return empty;
  return lines.map(line => clipLine(line)).join('\n');
}

function degradeText() {
  return shouldWarnDegraded() ? 'API DEGRADED (cached or stale data possible)' : 'API OK';
}

function encodeTagToken(tag) {
  const clean = cleanTag(tag);
  return clean || '0';
}

function decodeTagToken(token) {
  const clean = cleanTag(token);
  return clean || null;
}

export function decodeOwnerIdToken(token) {
  const s = String(token ?? '').trim();
  if (!/^\d{17,20}$/.test(s)) return null;
  return s;
}

export function isWarActiveToday(m) {
  return (
    Number(m.fame ?? 0) > 0 ||
    Number(m.decksUsedToday ?? 0) > 0 ||
    Number(m.repairPoints ?? 0) > 0 ||
    Number(m.boatAttacks ?? 0) > 0
  );
}

function toNum(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function sum(nums) {
  return (nums ?? []).reduce((acc, v) => acc + toNum(v), 0);
}

// Window sums only. The per-day rate stats this used to also compute
// (participationPct/deckCompletionPct/avgDecksPerDay) counted calendar buckets —
// subject to the same one-real-day-straddles-two-buckets inflation fixed across
// policy.js/risk-score.js/promotions.js — while risk-score.js already provides the
// period-corrected equivalents (warParticipationRate, deckMissRate) on the same
// scored object. Display sites now read those instead of a second, worse copy.
function computeWindowAgg(member) {
  const rows = Array.isArray(member?.series) ? member.series : [];

  const fameCum = rows.map(r => toNum(r?.fame));
  const decksUsedCum = rows.map(r => toNum(r?.decksUsed));
  const decksToday = rows.map(r => toNum(r?.decksUsedToday));
  const repairs = rows.map(r => toNum(r?.repairPoints));
  const boats = rows.map(r => toNum(r?.boatAttacks));

  const fameDelta = deltaSeries(fameCum);
  const decksDelta = deltaSeries(decksUsedCum, decksToday, getExpectedDecksPerDay());

  return {
    fameDeltaSum: sum(fameDelta),
    decksDeltaSum: sum(decksDelta),
    repairsSum: sum(repairs),
    boatSum: sum(boats),
  };
}

function normalizeRaceLogItems(raceLog) {
  if (Array.isArray(raceLog)) return raceLog;
  if (raceLog && Array.isArray(raceLog.items)) return raceLog.items;
  return [];
}

function summarizeRaceLog(raceLog, clanTag) {
  const items = normalizeRaceLogItems(raceLog);
  const clanTagClean = cleanTag(clanTag);
  const ranks = [];

  for (const item of items) {
    const standings = Array.isArray(item?.standings) ? item.standings : [];
    const ours = standings.find(s => cleanTag(s?.clan?.tag) === clanTagClean);
    const rank = Number(ours?.rank);
    if (Number.isFinite(rank) && rank > 0) ranks.push(rank);
  }

  if (ranks.length === 0) {
    return { count: 0, avgRank: null, firsts: 0, top2: 0, lastRank: null };
  }

  const firsts = ranks.filter(r => r === 1).length;
  const top2 = ranks.filter(r => r <= 2).length;
  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const lastRank = ranks[0] ?? null;

  return {
    count: ranks.length,
    avgRank: Math.round(avgRank * 10) / 10,
    firsts,
    top2,
    lastRank,
  };
}

function toTagCountMap(rawObj) {
  const result = new Map();
  if (!rawObj || typeof rawObj !== 'object') return result;
  for (const [rawTag, entries] of Object.entries(rawObj)) {
    const key = cleanTag(rawTag);
    const count = Array.isArray(entries) ? entries.length : 0;
    result.set(key, count);
  }
  return result;
}

function warDelta(series) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length < 4) return 0;

  // `fame` in River Race snapshots is typically cumulative. Use the shared deltaSeries
  // (already used by computeWindowAgg above) instead of hand-rolling day-over-day diffs —
  // the hand-rolled version forced day-zero's diff to `cur - cur = 0`, the exact bug
  // deltaSeries was built to fix (see window-delta.js's header comment: this was written
  // independently three times before, and this was a fourth, unmigrated copy).
  const fameDeltas = deltaSeries(rows.map(r => Number(r?.fame ?? 0)));

  const score = (row, i) => (
    fameDeltas[i] +
    Number(row?.repairPoints ?? 0) +
    (Number(row?.boatAttacks ?? 0) * 25)
  );

  const recent = rows.slice(-3);
  const prev = rows.slice(-6, -3);

  const recentAvg = recent.length
    ? recent.reduce((sum, row, idx) => sum + score(row, rows.length - recent.length + idx), 0) / recent.length
    : 0;

  const prevAvg = prev.length
    ? prev.reduce((sum, row, idx) => {
        const base = rows.length - recent.length - prev.length;
        return sum + score(row, base + idx);
      }, 0) / prev.length
    : 0;

  return Math.round(recentAvg - prevAvg);
}

function opsTabsRow(state) {
  const row = new ActionRowBuilder();
  const tagToken = encodeTagToken(state.playerTag);

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ops:refresh:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
  );

  for (const tab of TABS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ops:tab:${tab}:${state.windowDays}:0:${tagToken}:${state.ownerId}`)
        .setLabel(tab.toUpperCase())
        .setStyle(tab === state.tab ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }

  return row;
}

function opsSubRow(state) {
  const row = new ActionRowBuilder();
  const tagToken = encodeTagToken(state.playerTag);

  for (const w of WINDOW_OPTIONS) {
    const label = w === 1 ? 'TODAY' : `${w}D`;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ops:win:${w}:${state.tab}:0:${tagToken}:${state.ownerId}`)
        .setLabel(label)
        .setStyle(w === state.windowDays ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }

  return row;
}

// Its own dedicated row — Prev/Next used to share a row with the TODAY/7D/14D
// buttons (5 buttons crammed together, Next buried at the far right, same
// Secondary style as the window buttons it had nothing to do with). Page
// navigation now gets a clearly separate, clearly-labelled row every time.
function opsPagingRow(state, paging) {
  const row = new ActionRowBuilder();
  const tagToken = encodeTagToken(state.playerTag);

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`ops:page:prev:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!paging.canPrev),
    new ButtonBuilder()
      .setCustomId(`ops:page:info:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel(`Page ${paging.page + 1}/${paging.totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`ops:page:next:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!paging.canNext),
  );

  return row;
}

export function parseOpsAction(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== 'ops') return null;

  if (parts[1] === 'refresh') {
    return {
      tab: validTab(parts[2]),
      windowDays: toWindowDays(parts[3]),
      page: toPage(parts[4]),
      playerTag: decodeTagToken(parts[5]),
      ownerId: decodeOwnerIdToken(parts[6]),
    };
  }

  if (parts[1] === 'tab') {
    return {
      tab: validTab(parts[2]),
      windowDays: toWindowDays(parts[3]),
      page: toPage(parts[4]),
      playerTag: decodeTagToken(parts[5]),
      ownerId: decodeOwnerIdToken(parts[6]),
    };
  }

  if (parts[1] === 'win') {
    return {
      tab: validTab(parts[3]),
      windowDays: toWindowDays(parts[2]),
      page: toPage(parts[4]),
      playerTag: decodeTagToken(parts[5]),
      ownerId: decodeOwnerIdToken(parts[6]),
    };
  }

  if (parts[1] === 'page') {
    const dir = parts[2] === 'prev' ? 'prev' : 'next';
    const currentPage = toPage(parts[5]);
    return {
      tab: validTab(parts[3]),
      windowDays: toWindowDays(parts[4]),
      page: dir === 'prev' ? currentPage - 1 : currentPage + 1,
      playerTag: decodeTagToken(parts[6]),
      ownerId: decodeOwnerIdToken(parts[7]),
    };
  }

  if (parts[1] === 'pick') {
    return {
      tab: validTab(parts[2]),
      windowDays: toWindowDays(parts[3]),
      page: toPage(parts[4]),
      playerTag: null,
      ownerId: decodeOwnerIdToken(parts[5]),
    };
  }

  // warnOpen/noteOpen (button) and warnSubmit/noteSubmit (modal) all share this same
  // tab/windowDays/page/tag/ownerId shape so the drilldown view can be rebuilt exactly
  // as it was once the modal round-trip completes.
  if (parts[1] === 'warnOpen' || parts[1] === 'noteOpen' || parts[1] === 'warnSubmit' || parts[1] === 'noteSubmit') {
    return {
      tab: validTab(parts[2]),
      windowDays: toWindowDays(parts[3]),
      page: toPage(parts[4]),
      playerTag: decodeTagToken(parts[5]),
      ownerId: decodeOwnerIdToken(parts[6]),
    };
  }

  return { tab: 'overview', windowDays: 7, page: 0, playerTag: null, ownerId: null };
}

let opsFetchCache = null; // { expiresAt, promise }
const OPS_FETCH_CACHE_TTL_MS = 20_000;

// The CR API fetch and upsertTodaySnapshot's synchronous full-file history.json rewrite
// used to re-run on every single /ops interaction, including pure pagination clicks that
// need no new data — a leader paging through a long queue could trigger several full API
// round-trips and disk writes in quick succession for zero new information. Short-TTL
// cache on just this I/O-heavy step; scoring/policy evaluation below still runs fresh on
// every call against whatever `members`/`history` this returns.
async function fetchOpsBaseData() {
  const now = Date.now();
  if (opsFetchCache && opsFetchCache.expiresAt > now) return opsFetchCache.promise;

  const promise = (async () => {
    const clanTag = process.env.CLAN_TAG;
    const [clan, race, raceLog] = await Promise.all([
      getClan(clanTag),
      getCurrentRiverRace(clanTag),
      getRiverRaceLog(clanTag),
    ]);
    const members = buildMemberIntel({ clan, race, clanTag });
    // raceLog/clanTag let upsertTodaySnapshot run its own self-healing reconciliation
    // against the CR API's permanent race log internally — see reconcileFinalWarDayFromLog
    // for why our own on-demand snapshots can miss a member's final burst of war-day play.
    const snapshot = upsertTodaySnapshot(members, {
      periodType: race?.periodType,
      warDay: warDayFromPeriodType(race),
      periodIndex: race?.periodIndex,
      raceLog,
      clanTag,
    });
    // members (above) deliberately still includes anyone who fought this race and has
    // since left the clan — buildMemberIntel keeps them so the day they actually played
    // isn't undercounted in the snapshot just written. Everything display/scoring-facing
    // downstream (/ops, /war — war.js reuses this via loadOpsData) should reflect who's
    // ACTUALLY in the clan right now, so filter to the live roster here, once, for both.
    const currentMembers = filterToCurrentClan(members, clan);
    return { clan, race, raceLog, members: currentMembers, history: snapshot.history, day: snapshot.day };
  })();

  opsFetchCache = { expiresAt: now + OPS_FETCH_CACHE_TTL_MS, promise };
  // Don't keep serving a rejected promise from cache once it settles.
  promise.catch(() => { if (opsFetchCache?.promise === promise) opsFetchCache = null; });
  return promise;
}

export async function loadOpsData(windowDays) {
  const { clan, race, raceLog, members, history, day } = await fetchOpsBaseData();

  const graceDays = Number(process.env.GRACE_DAYS ?? 1);

  // Authoritative war-day classifier — prefers the stored warDay flag (captured live from
  // periodType) over raw activity presence. Computed once, up front, so both the risk-score
  // pipeline (Overview/War tabs) and the policy pipeline (Actions tab) agree on which days
  // count as war days for the same clan on the same day, instead of each independently
  // guessing from activity presence and potentially disagreeing.
  const anchorMs = parseWarAnchorMsFromEnv();
  const isWarDayForKey = (dayKey) => isHistoricalWarDay(history, dayKey, anchorMs);
  const warActiveToday = getWarDayDecision({
    race,
    snapshotWarDay: isWarActivityPresent(members),
    nowMs: Date.now(),
  }).shouldJudgeToday;

  const edpd = getExpectedDecksPerDay();
  const scoredRaw = computeHistoryWeightedRisk(history, members, {
    daysWindow: windowDays,
    // A 1-day (TODAY) window can never reach 3 tracked periods, so a fixed minHistoryDays:3
    // made risk-score.js's "not enough evidence yet" safety cap fire for every member the
    // moment TODAY was selected — collapsing risk to <=30% clan-wide from the window choice
    // itself, not from real data scarcity. Scale the requirement down to what the selected
    // window can actually provide.
    minHistoryDays: Math.min(3, windowDays),
    graceDays,
    repeatWindowDays: 14,
    repeatThreshold: 2,
    expectedDecksPerDay: edpd,
    isWarDayForKey,
    warActiveToday,
  });
  // members is already filtered to the live clan roster (see fetchOpsBaseData), so
  // scoredRaw — computed from members — needs no further roster filtering here.
  const scored = scoredRaw.map(m => ({ ...m, windowAgg: computeWindowAgg(m) }));
  const scoredByTag = new Map(scored.map(m => [cleanTag(m.tag), m]));
  const onBreakTags = getActiveBreakTagsFromDb();
  const recruitProfiles = getRecruitProfilesFromDb();
  const profileByTag = new Map(recruitProfiles.map(row => [cleanTag(row.player_tag), row]));
  const last7 = Object.keys(history?.days ?? {}).sort().slice(-7);
  const last14 = Object.keys(history?.days ?? {}).sort().slice(-14);
  const policyRows = members.map((member) => {
    const tag = cleanTag(member.tag);
    const profile = profileByTag.get(tag) ?? null;
    const currentTier = tierFromProfileStatus(profile?.status);
    const sum7 = summarizeWindow(history, tag, last7, edpd, isWarDayForKey);
    const sum14 = summarizeWindow(history, tag, last14, edpd, isWarDayForKey);
    return {
      ...member,
      linked: Boolean(profile?.discord_id),
      currentTier,
      sum7,
      sum14,
      policy: evaluateWarTierPolicy({ currentTier, sum7, sum14 }),
    };
  });

  const health = calculateClanHealth(members, history, scored);
  const metadata = loadWarningsNotesFromDb();

  return {
    clan,
    race,
    raceLog,
    members,
    history,
    graceDays,
    scored,
    scoredByTag,
    onBreakTags,
    policyRows,
    health,
    metadata,
    day,
  };
}

function buildOverviewTab(data, page, roleCtx) {
  const clanTag = process.env.CLAN_TAG;
  const edpd = getExpectedDecksPerDay();
  const warningMap = toTagCountMap(data.metadata?.warnings);
  const noteMap = toTagCountMap(data.metadata?.notes);
  const scoredByTag = new Map(data.scored.map(s => [cleanTag(s.tag), s]));
  const merged = data.members.map(m => ({ ...m, ...(scoredByTag.get(cleanTag(m.tag)) ?? {}) }));

  const cycleDecision = getWarDayDecision({
    race: data.race,
    snapshotWarDay: isWarActivityPresent(data.members),
    nowMs: Date.now(),
  });
  const enforceWarToday = Boolean(cycleDecision.shouldJudgeToday);

  const activeToday = merged.filter(isWarActiveToday).length;
  const missingToday = merged.filter(m => !isWarActiveToday(m)).length;
  const missingTodayNoGrace = merged.filter(m => !m.inGrace && !isWarActiveToday(m)).length;
  const zeroDonors = merged.filter(m => Number(m.donations ?? 0) === 0).length;

  const highRisk = merged.filter(m => !m.inGrace && Number(m.risk ?? 0) >= HIGH_RISK_THRESHOLD).length;
  const repeatOffenders = merged.filter(m => !m.inGrace && Boolean(m.repeatOffender)).length;
  // historyDays gate: without it, the first day or two of a fresh war/colosseum week reads
  // as 0% participation for the whole clan (no data yet, not genuine inactivity) — matches
  // the same fix applied to analytics.js's calculateClanHealth and schedule.js's weak-link
  // detection, both of which had the same false-alarm pattern confirmed live.
  const warInactiveWindow = merged.filter(m => !m.inGrace && Number(m.historyDays ?? 0) >= 3 && Number(m.warParticipationRate ?? 0) === 0).length;
  const inGraceCount = merged.filter(m => m.inGrace).length;

  const newJoiners = merged
    .filter(m => m.inGrace)
    .slice()
    .sort((a, b) => Number(a.ageDays ?? 0) - Number(b.ageDays ?? 0))
    .slice(0, 10)
    .map((m, i) => {
      const tag = cleanTag(m.tag);
      const joined = data.history?.firstSeen?.[tag] ?? 'Unknown';
      const age = Number(m.ageDays ?? 0);
      const grace = Number(data.graceDays ?? 1);
      return `${i + 1}) ${displayNameWithRoles(m, roleCtx)} | joined ${joined} | grace ${age}/${grace}d`;
    });

  const logSummary = summarizeRaceLog(data.raceLog, clanTag);

  const attention = merged
    .filter(m => !m.inGrace)
    .slice()
    .sort((a, b) => {
      if (enforceWarToday) {
        const aMissing = !isWarActiveToday(a) ? 1 : 0;
        const bMissing = !isWarActiveToday(b) ? 1 : 0;
        if (aMissing !== bMissing) return bMissing - aMissing;
      }
      return Number(b.risk ?? 0) - Number(a.risk ?? 0);
    });

  const slice = pageSlice(attention, page);
  const attentionTable = renderTable(
    [
      { key: 'name', label: 'Name', width: 16, align: 'left' },
      { key: 'risk', label: 'Risk', width: 4, align: 'right' },
      { key: 'war', label: 'War%', width: 4, align: 'right' },
      { key: 'decks', label: 'Decks', width: 9, align: 'right' },
      { key: 'fame', label: 'Fame', width: 5, align: 'right' },
      { key: 'wn', label: 'W/N', width: 3, align: 'right' },
      { key: 'seen', label: 'Seen', width: 9, align: 'right' },
    ],
    slice.pageItems.map((m) => {
      const inactiveDays = daysSinceLastSeen(m.lastSeen);
      const tag = cleanTag(m.tag);
      const warnings = warningMap.get(tag) ?? 0;
      const notes = noteMap.get(tag) ?? 0;
      const miss = enforceWarToday && !isWarActiveToday(m) ? '!' : '';
      const agg = m.windowAgg ?? {};
      const fameWin = Math.round(Number(agg.fameDeltaSum ?? 0));
      const deckPct = Math.round((1 - Number(m.deckMissRate ?? 1)) * 100);
      const decksAvg = Math.round((1 - Number(m.deckMissRate ?? 1)) * edpd * 10) / 10;
      return {
        name: `${miss}${String(m?.name ?? 'unknown').trim() || 'unknown'}`,
        risk: `${Math.round(Number(m.risk ?? 0) * 100)}%`,
        war: `${Number(m.warParticipationRate ?? 0)}%`,
        decks: `${decksAvg}(${deckPct}%)`,
        fame: `+${fameWin}`,
        wn: `${warnings}/${notes}`,
        seen: formatDaysAgo(inactiveDays),
      };
    }),
  );

  const healthIssues = Array.isArray(data.health?.issues) && data.health.issues.length
    ? data.health.issues.join('\n')
    : 'No issues reported.';

  const logText = logSummary.count === 0
    ? 'No race log available.'
    : [
      `Races tracked: ${logSummary.count}`,
      `Avg rank: ${logSummary.avgRank}`,
      `1st place finishes: ${logSummary.firsts}`,
      `Top-2 finishes: ${logSummary.top2}`,
      `Last race rank: ${logSummary.lastRank ?? '-'}`,
    ].join('\n');

  const topTrophies = merged
    .slice()
    .sort((a, b) => Number(b.trophies ?? 0) - Number(a.trophies ?? 0))
    .slice(0, 8)
    .map((m, i) => `${i + 1}) ${displayNameWithRoles(m, roleCtx)} | \uD83C\uDFC6${Number(m.trophies ?? 0)}`);

  const trendRows = merged
    .map(m => ({
      name: displayNameWithRoles(m, roleCtx),
      delta: warDelta(m.series),
    }))
    .filter(x => Number.isFinite(x.delta) && x.delta !== 0)
    .sort((a, b) => b.delta - a.delta);

  const improvers = trendRows
    .slice(0, 5)
    .map((x, i) => `${i + 1}) ${x.name} | +${x.delta}`);

  const decliners = trendRows
    .slice()
    .reverse()
    .slice(0, 5)
    .map((x, i) => `${i + 1}) ${x.name} | ${x.delta}`);

  const nonGrace = merged.filter(m => !m.inGrace);
  const bestPerformer = nonGrace.slice().sort((a, b) => Number(a.risk ?? 1) - Number(b.risk ?? 1))[0] ?? null;
  const worstPerformer = attention[0] ?? null;
  const spotlight = renderSpotlight({
    top: bestPerformer ? `${String(bestPerformer.name ?? 'unknown')} · ${Number(bestPerformer.warParticipationRate ?? 0)}% war · ${Math.round(Number(bestPerformer.risk ?? 0) * 100)}% risk` : null,
    bottom: worstPerformer ? `${String(worstPerformer.name ?? 'unknown')} · ${Number(worstPerformer.warParticipationRate ?? 0)}% war · ${Math.round(Number(worstPerformer.risk ?? 0) * 100)}% risk` : null,
  });

  return {
    title: 'Overview',
    header: [
      '## 🐙 KRAKEN OPS — Overview',
      `**Health:** ${data.health.score}/100 (${data.health.grade}) · **API:** ${degradeText()}`,
    ].join('\n'),
    blocks: [
      spotlight,
      healthIssues,
      [
        '### Current Counts',
        `Active today: **${activeToday}/${merged.length}** · Behind on war today: **${enforceWarToday ? missingToday : 0}** (no grace: **${enforceWarToday ? missingTodayNoGrace : 0}**)`,
        `War enforcement: **${enforceWarToday ? 'Active' : 'Paused'}** via **${cycleDecision.source}**${cycleDecision.anchorDecision?.cycleLabel ? ` (${cycleDecision.anchorDecision.cycleLabel})` : ''}`,
        `Inactive across window: **${warInactiveWindow}** · High risk: **${highRisk}** · Repeat offenders: **${repeatOffenders}** · Zero donors: **${zeroDonors}** · In grace: **${inGraceCount}**`,
      ].join('\n'),
      `### New Joiners / Grace\nGrace period: **${Number(data.graceDays ?? 1)} day(s)** (join day excluded)\n${bulletList(newJoiners, 'No one currently in grace.')}`,
      `### Recent Race Results\n${logText}`,
      `### Top Trophy Holders\n${bulletList(topTrophies, 'No trophy data.')}`,
      `### War Trend\n${sectionValue(['Top improvers'], improvers, 'No trend data.')}\n\n${sectionValue(['Top decliners'], decliners, 'No trend data.')}`,
      `### 🚨 Attention Queue (${enforceWarToday ? 'Behind on War First, Then Risk' : 'Training/Non-war: Risk Only'})\n${attentionTable ?? 'No attention items right now.'}`,
    ],
    page: slice.page,
    totalPages: slice.totalPages,
  };
}

function buildDonationsTab(data, page, _roleCtx) {
  const sorted = data.members
    .slice()
    .sort((a, b) => Number(b.donations ?? 0) - Number(a.donations ?? 0));

  const totalDonations = data.members.reduce((sum, m) => sum + Number(m.donations ?? 0), 0);
  const avgDonations = data.members.length > 0
    ? Math.round(totalDonations / data.members.length)
    : 0;

  const lowDonors = data.members
    .slice()
    .sort((a, b) => Number(a.donations ?? 0) - Number(b.donations ?? 0))
    .slice(0, 8);

  const lowDonorsTable = renderTable(
    [
      { key: 'rank', label: '#', width: 3, align: 'right' },
      { key: 'name', label: 'Name', width: 16, align: 'left' },
      { key: 'sent', label: 'Sent', width: 5, align: 'right' },
      { key: 'recv', label: 'Received', width: 8, align: 'right' },
    ],
    lowDonors.map((m, i) => ({
      rank: i + 1,
      name: String(m?.name ?? 'unknown'),
      sent: Number(m.donations ?? 0),
      recv: Number(m.donationsReceived ?? 0),
    })),
  );

  const slice = pageSlice(sorted, page);
  const donorsTable = renderTable(
    [
      { key: 'rank', label: '#', width: 3, align: 'right' },
      { key: 'name', label: 'Name', width: 16, align: 'left' },
      { key: 'sent', label: 'Sent', width: 5, align: 'right' },
      { key: 'recv', label: 'Received', width: 8, align: 'right' },
    ],
    slice.pageItems.map((m, i) => ({
      rank: slice.page * PAGE_SIZE + i + 1,
      name: String(m?.name ?? 'unknown'),
      sent: Number(m.donations ?? 0),
      recv: Number(m.donationsReceived ?? 0),
    })),
  );

  const topDonor = sorted[0] ?? null;
  const lowestDonor = lowDonors[0] ?? null;
  const donationSpotlight = renderSpotlight({
    topLabel: '🏆 Top donor',
    bottomLabel: '⚠️ Lowest donor',
    top: topDonor ? `${String(topDonor.name ?? 'unknown')} · ${Number(topDonor.donations ?? 0)} sent` : null,
    bottom: lowestDonor ? `${String(lowestDonor.name ?? 'unknown')} · ${Number(lowestDonor.donations ?? 0)} sent` : null,
  });

  return {
    title: 'Donations',
    header: [
      '## 🎁 KRAKEN OPS — Donations',
      `**Total sent:** ${totalDonations} · **Avg/member:** ${avgDonations} · **Zero donors:** ${data.members.filter(m => Number(m.donations ?? 0) === 0).length}`,
    ].join('\n'),
    blocks: [
      donationSpotlight,
      'In-game donation counters are cumulative (not per-day). Use ACTIONS to combine donation + war + risk before final decisions.',
      `### 🎁 Top Donors\n${donorsTable ?? 'No donation data yet.'}`,
      `### 📉 Lowest Donors\n${lowDonorsTable ?? 'No low-donor data.'}`,
    ],
    page: slice.page,
    totalPages: slice.totalPages,
  };
}

function buildActionsTab(data, page, selectedTag, roleCtx) {
  const cycleDecision = getWarDayDecision({
    race: data.race,
    snapshotWarDay: isWarActivityPresent(data.members),
    nowMs: Date.now(),
  });
  const warningMap = toTagCountMap(data.metadata?.warnings);
  const noteMap = toTagCountMap(data.metadata?.notes);
  const clanRoleByTag = new Map(
    (Array.isArray(data.members) ? data.members : []).map((m) => [cleanTag(m.tag), String(m.role ?? 'member')]),
  );
  const { ranked, watchClosely, moveUnderwatch, bootReview, warcoreReady } = categorizeTierDecisions(data.policyRows, {
    scoredByTag: data.scoredByTag,
    onBreakTags: data.onBreakTags,
  });

  const recEntries = [];
  const recByTag = new Map();

  function joinReasons(reasons, max = 2) {
    if (!Array.isArray(reasons) || reasons.length === 0) return '';
    return reasons.filter(Boolean).slice(0, max).join(' / ');
  }

  function addRecEntry(item, action, fallbackReason) {
    const tag = cleanTag(item.tag);
    const reasonText = joinReasons(item.policy?.reasons?.map(explainPolicyReason), 2) || fallbackReason;
    const completionPct = Math.round((Number(item.sum14?.usedDecks ?? 0) / Math.max(1, Number(item.sum14?.expectedDecks ?? 0))) * 100);
    const entry = {
      action,
      name: displayNameWithRoles(item, roleCtx),
      risk: Math.max(0, Math.min(100, completionPct)),
      reason: `${reasonText} | w ${warningMap.get(tag) ?? 0} | n ${noteMap.get(tag) ?? 0}`,
    };
    recEntries.push(entry);
    recByTag.set(tag, { action, reasonText });
  }

  for (const item of warcoreReady) addRecEntry(item, item.currentTier === 'warcore' ? 'KEEP warcore' : 'PROMOTE to warcore', 'Perfect 2-war window');
  for (const item of watchClosely) addRecEntry(item, 'MOVE warcore -> probation', 'Large inconsistency across 2 complete wars');
  for (const item of moveUnderwatch) addRecEntry(item, 'MOVE to underwatch', 'Probation review failed across 1 full war week');
  for (const item of bootReview) addRecEntry(item, 'APPLY boot-review role', 'Inactive across 1 full war week');

  const worstOverall = ranked
    .slice(0, 3)
    .map(m => {
      const tag = cleanTag(m.tag);
      const rec = recByTag.get(tag) ?? null;
      const whyParts = [];

      if (rec?.reasonText) whyParts.push(rec.reasonText);
      for (const r of (Array.isArray(m.policy?.reasons) ? m.policy.reasons.map(explainPolicyReason) : [])) {
        if (!r || whyParts.includes(r)) continue;
        whyParts.push(r);
        if (whyParts.length >= 3) break;
      }

      const why = whyParts.length ? whyParts.slice(0, 2).join(' | ') : 'Review current 2-war window';
      const action = rec?.action ?? 'MONITOR';
      // This is deck completion (usedDecks/expectedDecks), not a risk score \u2014 policyRows has
      // no risk-score.js data on it at all. Previously shown twice under both \uD83C\uDFAF (risk%, which
      // means something different everywhere else in this command) and \u2694 (war%), duplicating
      // the identical number under two misleading labels. Shown once, correctly labeled.
      const completionPct = Math.round((Number(m.sum14?.usedDecks ?? 0) / Math.max(1, Number(m.sum14?.expectedDecks ?? 0))) * 100);
      const deckPct = Math.max(0, Math.min(100, completionPct));
      const w = warningMap.get(tag) ?? 0;
      const n = noteMap.get(tag) ?? 0;

      const line = `${displayNameWithRoles(m, roleCtx)} | \uD83C\uDCCF${deckPct}% | ${action} | ${why} | \uD83D\uDCDD${w}/${n}`;
      return line.length > 220 ? line.slice(0, 217) + '...' : line;
    });

  // Quick-glance only \u2014 /war-board is the authoritative, fully-paginated decision
  // board for these same tier categories, so this stays a short teaser rather than
  // a second incomplete copy of the same list.
  const kickShortlist = bootReview
    .slice(0, 3)
    .map((k, i) => `${i + 1}) **${k.name}** | \uD83C\uDCCF${Number(k.sum14?.usedDecks ?? 0)}/${Number(k.sum14?.expectedDecks ?? 0)} | ${joinReasons(k.policy?.reasons?.map(explainPolicyReason), 2) || 'Inactive across 2 wars'}`);

  const selectedTagClean = cleanTag(selectedTag);
  const selectedPlayer = ranked.find(m => cleanTag(m.tag) === selectedTagClean) ?? ranked[0] ?? null;

  const queueSlice = pageSlice(recEntries, page);
  const pickerSource = ranked.slice().sort((a, b) => Number(a.sum14?.usedDecks ?? 0) - Number(b.sum14?.usedDecks ?? 0));
  const pickerSlice = pageSlice(pickerSource, page, PICKER_PAGE_SIZE);
  const totalPages = Math.max(queueSlice.totalPages, pickerSlice.totalPages);
  const safePage = clamp(page, 0, totalPages - 1);

  const finalQueueSlice = pageSlice(recEntries, safePage);
  const finalPickerSlice = pageSlice(pickerSource, safePage, PICKER_PAGE_SIZE);

  const pickerOptions = finalPickerSlice.pageItems.map(m => {
    const name = String(displayNameWithRoles(m, roleCtx) ?? 'Unknown');
    const label = name.length > 100 ? `${name.slice(0, 97)}...` : name;
    const deckPct = Math.round((Number(m.sum14?.usedDecks ?? 0) / Math.max(1, Number(m.sum14?.expectedDecks ?? 0))) * 100);
    const tag = cleanTag(m.tag);
    const selected = selectedPlayer ? cleanTag(selectedPlayer.tag) === tag : false;
    return {
      label,
      value: tag,
      // "war %" here used to just repeat deckPct under a second label — same
      // duplicated-number-two-labels bug fixed in the drilldown lines below.
      description: `deck ${deckPct}% | missed ${Number(m.sum14?.missedWarDays ?? 0)} war day(s)`,
      default: selected,
    };
  });

  const detailLines = selectedPlayer
    ? [
      `Player: **${selectedPlayer.name}**`,
      `Clash tag: #${cleanTag(selectedPlayer.tag)}`,
      `Clan role: ${clanRoleByTag.get(cleanTag(selectedPlayer.tag)) ?? 'member'}`,
      `Discord role: ${String(roleCtx?.discordRoleByTag?.get?.(cleanTag(selectedPlayer.tag)) ?? 'unlinked')}`,
      `Current tier: ${selectedPlayer.currentTier}`,
      `Recommended tier: ${selectedPlayer.policy?.remove ? 'boot-review role' : selectedPlayer.policy?.desiredTier}`,
      '',
      '2-war window',
      `Decks: ${Number(selectedPlayer.sum14?.usedDecks ?? 0)}/${Number(selectedPlayer.sum14?.expectedDecks ?? 0)}`,
      `Missed war days: ${Number(selectedPlayer.sum14?.missedWarDays ?? 0)}${Number(selectedPlayer.sum14?.yetToPlayWarDays ?? 0) > 0 ? ' (today still playable)' : ''}`,
      `Fame: ${Math.round(Number(selectedPlayer.sum14?.fame ?? 0))}`,
      '',
      '1-war window',
      `Decks: ${Number(selectedPlayer.sum7?.usedDecks ?? 0)}/${Number(selectedPlayer.sum7?.expectedDecks ?? 0)}`,
      `Missed war days: ${Number(selectedPlayer.sum7?.missedWarDays ?? 0)}${Number(selectedPlayer.sum7?.yetToPlayWarDays ?? 0) > 0 ? ' (today still playable)' : ''}`,
      '',
      'Today',
      `Fame: ${Number(selectedPlayer.fame ?? 0)} | Decks: ${Number(selectedPlayer.decksUsedToday ?? 0)} | Repairs: ${Number(selectedPlayer.repairPoints ?? 0)} | Boat: ${Number(selectedPlayer.boatAttacks ?? 0)}`,
      `Donations: sent ${Number(selectedPlayer.donations ?? 0)} | received ${Number(selectedPlayer.donationsReceived ?? 0)}`,
      `Trend delta: ${warDelta(selectedPlayer.series)}`,
      `Why: ${joinReasons(selectedPlayer.policy?.reasons?.map(explainPolicyReason), 4) || 'No reason data'}`,
      `Warnings: ${warningMap.get(cleanTag(selectedPlayer.tag)) ?? 0} | Notes: ${noteMap.get(cleanTag(selectedPlayer.tag)) ?? 0}`,
      `Last seen: ${formatDaysAgo(daysSinceLastSeen(selectedPlayer.lastSeen))}`,
    ]
    : ['No player data available.'];

  const actionLines = finalQueueSlice.pageItems.map((e, i) =>
    `${finalQueueSlice.page * PAGE_SIZE + i + 1}) ${e.name}\nAction: ${e.action}\nConfidence: ${e.risk}%\nWhy: ${e.reason}`
  );

  // warcoreReady inherits `ranked`'s ascending-usedDecks order (lowest first — correct for
  // boot-review urgency, backwards here) — the strongest performer is the LAST entry, not
  // the first, which used to surface the most marginal qualifier under a "Top" label.
  const topPromotion = warcoreReady.length ? warcoreReady[warcoreReady.length - 1] : null;
  const topBootCandidate = bootReview[0] ?? null;
  const actionsSpotlight = renderSpotlight({
    topLabel: '⬆️ Top promotion candidate',
    bottomLabel: '⬇️ Top boot-review candidate',
    top: topPromotion ? `${displayNameWithRoles(topPromotion, roleCtx)}` : null,
    bottom: topBootCandidate ? `${displayNameWithRoles(topBootCandidate, roleCtx)}` : null,
  });

  return {
    title: 'Actions',
    header: [
      '## 🛠️ KRAKEN OPS — Actions',
      `**Health:** ${data.health.score}/100 (Grade ${data.health.grade}) · **Policy source:** ${cycleDecision.source}${cycleDecision.anchorDecision?.cycleLabel ? ` (${cycleDecision.anchorDecision.cycleLabel})` : ''}`,
    ].join('\n'),
    blocks: [
      actionsSpotlight,
      [
        '### 📋 Decision Summary',
        `Ready for or keep warcore: **${warcoreReady.length}** · Watch closely: **${watchClosely.length}** · Move to underwatch: **${moveUnderwatch.length}** · Boot-review: **${bootReview.length}**`,
        `Linked clan members: **${ranked.length}** · Unlinked: **${Math.max(0, (Array.isArray(data.members) ? data.members.length : 0) - ranked.length)}**`,
        `Full decision board (every tier, fully paged): \`/war-board\``,
      ].join('\n'),
      `### 🚪 Boot Review — Quick Glance\n${bulletList(kickShortlist, 'No kick candidates right now.')}${bootReview.length > kickShortlist.length ? `\n+${bootReview.length - kickShortlist.length} more — full list in \`/war-board\`` : ''}`,
      `### 📝 Action Queue\n${bulletList(actionLines, 'No recruit ladder recommendations right now.')}`,
      `### 🔎 Player Drilldown\n${detailLines.join('\n')}`,
      `### ❓ Top Reasons Players Are Surfacing\n${bulletList(worstOverall, 'No risk data yet.')}${ranked.length > worstOverall.length ? `\nFull decision board: \`/war-board\`` : ''}`,
    ],
    page: safePage,
    totalPages,
    selectedTag: selectedPlayer ? cleanTag(selectedPlayer.tag) : null,
    pickerOptions,
  };
}

function buildTabView(tab, data, page, selectedTag, roleCtx) {
  if (tab === 'donations') return buildDonationsTab(data, page, roleCtx);
  if (tab === 'actions') return buildActionsTab(data, page, selectedTag, roleCtx);
  return buildOverviewTab(data, page, roleCtx);
}

function opsPlayerPickerRow(state, view) {
  if (state.tab !== 'actions') return null;
  if (!Array.isArray(view.pickerOptions) || view.pickerOptions.length === 0) return null;

  const picker = new StringSelectMenuBuilder()
    .setCustomId(`ops:pick:${state.tab}:${state.windowDays}:${state.page}:${state.ownerId}`)
    .setPlaceholder('Select player for drilldown')
    .addOptions(view.pickerOptions);

  return new ActionRowBuilder().addComponents(picker);
}

// Only shown on the actions tab once a player is actually selected in the drilldown —
// warnings/notes are per-player, so there's nothing to attach one to otherwise.
function opsWarnNoteRow(state, view) {
  if (state.tab !== 'actions') return null;
  if (!view.selectedTag) return null;
  const tagToken = encodeTagToken(view.selectedTag);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ops:warnOpen:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel('⚠️ Add Warning')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ops:noteOpen:${state.tab}:${state.windowDays}:${state.page}:${tagToken}:${state.ownerId}`)
      .setLabel('📝 Add Note')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Builds the modal shown when a warn/note button is clicked — customId carries the same
// tab/windowDays/page/tag/ownerId state as every other ops: action, so submitting it can
// rebuild and edit the exact same drilldown view the button was clicked from.
function buildWarnNoteModal({ kind, tab, windowDays, page, playerTag, ownerId }) {
  const isWarn = kind === 'warn';
  const tagToken = encodeTagToken(playerTag);
  const modal = new ModalBuilder()
    .setCustomId(`ops:${isWarn ? 'warnSubmit' : 'noteSubmit'}:${tab}:${windowDays}:${page}:${tagToken}:${ownerId}`)
    .setTitle(isWarn ? 'Add Warning' : 'Add Note');

  const input = new TextInputBuilder()
    .setCustomId('text')
    .setLabel(isWarn ? 'Warning reason' : 'Note text')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// Modal submit handler for warnSubmit/noteSubmit — a fully separate flow from the rest
// of opsHandler below: writes to metadata.js, then rebuilds and edits the original OPS
// panel message the warn/note button was attached to (same defer-then-editReply pattern
// the main handler uses for every other button/select).
async function handleWarnNoteSubmit(interaction) {
  // Tracks whether the write itself completed, so the catch below can report an accurate
  // message regardless of which stage actually failed — writing then re-rendering are two
  // separate risks, and conflating them either way (claiming a save failed when it didn't,
  // or vice versa) is worse than just tracking the truth explicitly.
  let written = false;
  try {
    const parsed = parseOpsAction(interaction.customId) ?? {};

    if (parsed.ownerId && interaction.user?.id && interaction.user.id !== parsed.ownerId) {
      return interaction.reply({
        content: 'This OPS panel belongs to someone else. Run `/ops` to open your own panel.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!parsed.playerTag) {
      return interaction.reply({ content: 'No player selected — pick one from the drilldown first.', flags: MessageFlags.Ephemeral });
    }

    const text = String(interaction.fields.getTextInputValue('text') ?? '').trim();
    if (!text) {
      return interaction.reply({ content: 'Text is required.', flags: MessageFlags.Ephemeral });
    }

    // Acknowledge BEFORE writing, not after — deferUpdate() only flips interaction.deferred
    // to true once its own REST call actually succeeds (confirmed against discord.js's
    // InteractionResponses source), so writing first meant a transient failure on this
    // call alone would land in the catch block below with deferred still false, reporting
    // "could not save" to the leader even though addWarning/addNote had already succeeded —
    // inviting a resubmit that adds the same warning/note twice, since neither has any
    // idempotency guard. Deferring first means the only way to reach the write below is a
    // successful acknowledgment, so a failure from here on is a real, accurately-reported one.
    await interaction.deferUpdate();

    const isWarn = interaction.customId.startsWith('ops:warnSubmit:');
    const issuedBy = interaction.user?.tag ?? String(interaction.user?.id ?? 'unknown');
    if (isWarn) addPlayerWarningToDb(parsed.playerTag, text, issuedBy);
    else addPlayerNoteToDb(parsed.playerTag, text, issuedBy);
    written = true;

    const state = {
      tab: parsed.tab,
      windowDays: parsed.windowDays,
      page: parsed.page,
      playerTag: parsed.playerTag,
      ownerId: parsed.ownerId ?? interaction.user?.id ?? null,
    };
    const data = await loadOpsData(state.windowDays);
    const roleCtx = await buildRoleContext(interaction.guild, data.members);
    const view = buildTabView(state.tab, data, state.page, state.playerTag, roleCtx);
    state.playerTag = cleanTag(view.selectedTag ?? state.playerTag);
    const payload = buildOpsPayload({ state, data, view });
    return interaction.editReply(payload);
  } catch (err) {
    console.error('[OPS] warn/note submit error:', formatErrorForLog(err));
    const content = written
      ? 'Saved, but the panel could not be refreshed — reopen with `/ops` to see it.'
      : 'Could not save — check logs.';
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content });
    }
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

function buildOpsPayload({ state, data, view }) {
  const winLabel = state.windowDays === 1 ? 'Today' : `${state.windowDays} days`;
  const tabColors = {
    overview: 0x5865f2,
    donations: 0x57f287,
    actions: 0xfee75c,
  };

  const metaLine = `**Window:** ${winLabel} · **Page:** ${view.page + 1}/${view.totalPages} · **Updated:** ${data.day}`;
  const container = buildDashboardContainer({
    accentColor: tabColors[state.tab] ?? 0x5865f2,
    thumbnailUrl: CLAN_BADGE_URL,
    header: view.header ? `${view.header}\n${metaLine}` : `## KRAKEN OPS — ${view.title}\n${metaLine}`,
    blocks: view.blocks,
  });

  const paging = {
    canPrev: view.page > 0,
    canNext: view.page < (view.totalPages - 1),
  };

  const stateForButtons = { ...state, page: view.page };

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      container,
      opsTabsRow(stateForButtons),
      opsSubRow(stateForButtons),
      opsPagingRow(stateForButtons, { ...paging, page: view.page, totalPages: view.totalPages }),
      ...(opsPlayerPickerRow(stateForButtons, view) ? [opsPlayerPickerRow(stateForButtons, view)] : []),
      ...(opsWarnNoteRow(stateForButtons, view) ? [opsWarnNoteRow(stateForButtons, view)] : []),
    ].filter(Boolean),
    allowedMentions: { parse: [] },
  };
}

export async function opsHandler(interaction) {
  try {
    // Warn/note modal submissions are a fully separate flow (data write, then edit the
    // original panel) — handled entirely by handleWarnNoteSubmit, never reaching the
    // generic component dispatch below.
    if (interaction.isModalSubmit() && typeof interaction.customId === 'string'
      && (interaction.customId.startsWith('ops:warnSubmit:') || interaction.customId.startsWith('ops:noteSubmit:'))) {
      return await handleWarnNoteSubmit(interaction);
    }

    const isComponent = interaction.isButton() || interaction.isStringSelectMenu();

    const parsedForAuth = isComponent
      ? (parseOpsAction(interaction.customId) ?? { ownerId: null })
      : { ownerId: null };

    if (isComponent && parsedForAuth.ownerId && interaction.user?.id && interaction.user.id !== parsedForAuth.ownerId) {
      if (!interaction.deferred && !interaction.replied) {
        return interaction.reply({
          content: 'This OPS panel belongs to someone else. Run `/ops` to open your own panel.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.followUp({
        content: 'This OPS panel belongs to someone else. Run `/ops` to open your own panel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Warn/note buttons open a modal instead of the usual defer-then-rebuild flow below —
    // showModal() must be an interaction's FIRST response, so this has to run before the
    // deferUpdate() every other button/select triggers unconditionally just below.
    if (interaction.isButton() && typeof interaction.customId === 'string'
      && (interaction.customId.startsWith('ops:warnOpen:') || interaction.customId.startsWith('ops:noteOpen:'))) {
      if (!parsedForAuth.playerTag) {
        return interaction.reply({ content: 'No player selected — pick one from the drilldown first.', flags: MessageFlags.Ephemeral });
      }
      return interaction.showModal(buildWarnNoteModal({
        kind: interaction.customId.startsWith('ops:warnOpen:') ? 'warn' : 'note',
        tab: parsedForAuth.tab,
        windowDays: parsedForAuth.windowDays,
        page: parsedForAuth.page,
        playerTag: parsedForAuth.playerTag,
        ownerId: parsedForAuth.ownerId ?? interaction.user?.id ?? null,
      }));
    }

    // Interactions must be acknowledged quickly (<=3s).
    // Defer immediately, then reply/edit once data is ready.
    if (isComponent && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    if (!isComponent && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const parsed = (interaction.isButton() || interaction.isStringSelectMenu())
      ? (parseOpsAction(interaction.customId) ?? { tab: 'overview', windowDays: 7, page: 0, playerTag: null, ownerId: null })
      : { tab: 'overview', windowDays: 7, page: 0, playerTag: null, ownerId: null };

    const state = {
      tab: validTab(parsed.tab),
      windowDays: toWindowDays(parsed.windowDays),
      page: toPage(parsed.page),
      playerTag: cleanTag(parsed.playerTag),
      ownerId: parsed.ownerId ?? interaction.user?.id ?? null,
    };

    if (interaction.isStringSelectMenu()) {
      const selected = Array.isArray(interaction.values) ? interaction.values[0] : null;
      state.playerTag = cleanTag(selected);
    }

    const data = await loadOpsData(state.windowDays);
    const roleCtx = await buildRoleContext(interaction.guild, data.members);
    const view = buildTabView(state.tab, data, state.page, state.playerTag, roleCtx);
    state.playerTag = cleanTag(view.selectedTag ?? state.playerTag);
    const payload = buildOpsPayload({ state, data, view });

    if (isComponent) {
      return interaction.editReply(payload);
    }

    const userId = interaction?.user?.id;
    const channelId = interaction?.channelId;
    const cached = userId ? OPS_PANEL_BY_USER.get(userId) : null;

    if (cached && cached.channelId === channelId && interaction.channel) {
      try {
        const previous = await interaction.channel.messages.fetch(cached.messageId);
        if (previous) {
          await previous.edit(payload);
          return interaction.editReply({
            content: 'Updated your existing OPS panel above.',
            embeds: [],
            components: [],
          });
        }
      } catch {
        // If old panel is gone/uneditable, create a new one below.
      }
    }

    await interaction.editReply(payload);
    const replyMessage = await interaction.fetchReply().catch(() => null);

    if (userId && replyMessage?.id) {
      OPS_PANEL_BY_USER.set(userId, { messageId: replyMessage.id, channelId });
    }

    return replyMessage;
  } catch (err) {
    console.error('[OPS] handler error:', formatErrorForLog(err));

    const failPayload = {
      content: 'OPS failed to load. Check logs.',
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: failPayload.content });
    }

    return interaction.reply(failPayload);
  }
}






