import { cleanTag } from './util.js';

export function buildMemberIntel({ clan, race, clanTag }) {
  const clanMembers = (clan?.memberList ?? []).map(m => ({
    tag: cleanTag(m.tag),
    name: m.name ?? 'Unknown',
    donations: Number(m.donations ?? 0),
    donationsReceived: Number(m.donationsReceived ?? 0),
    trophies: Number(m.trophies ?? 0),
    role: m.role ?? 'member',
    expLevel: Number(m.expLevel ?? 0),
    lastSeen: m.lastSeen ?? null,
    clanRank: Number(m.clanRank ?? 0),
  }));

  const byTag = new Map(clanMembers.map(m => [m.tag, m]));

  const clanTagClean = cleanTag(clanTag);
  const clans = race?.clans ?? [];
  const ourClan =
    clans.find(c => cleanTag(c.tag) === clanTagClean) ??
    clans.find(c => (c.tag || '').replace('#','').toUpperCase() === clanTagClean) ??
    null;

  const participants = (ourClan?.participants ?? []).map(p => ({
    tag: cleanTag(p.tag),
    name: p.name ?? 'Unknown',
    fame: Number(p.fame ?? 0),
    decksUsedToday: Number(p.decksUsedToday ?? 0),
    decksUsed: Number(p.decksUsed ?? 0),
    repairPoints: Number(p.repairPoints ?? 0),
    boatAttacks: Number(p.boatAttacks ?? 0),
  }));

  for (const p of participants) {
    const existing = byTag.get(p.tag);
    if (existing) {
      byTag.set(p.tag, { ...existing, ...p });
      continue;
    }
    // Participant fought this race but is no longer in clan.memberList (left/kicked
    // mid-war). Keep their war contribution instead of dropping it — losing this
    // silently undercounts that day's fame/decks everywhere this feeds into
    // (history.json, risk scoring, daily report totals, the evaluator).
    byTag.set(p.tag, {
      tag: p.tag,
      name: p.name,
      donations: 0,
      donationsReceived: 0,
      trophies: 0,
      role: 'member',
      expLevel: 0,
      lastSeen: null,
      clanRank: 0,
      ...p,
    });
  }

  return Array.from(byTag.values());
}

// buildMemberIntel (above) deliberately RETAINS a member who fought this race
// and has since left the clan, so that day's war totals aren't undercounted —
// which means its output is not the same thing as "who is actually in the clan
// right now." Every display/scoring path that shouldn't keep showing a departed
// member needs the live roster instead; this was independently reimplemented
// (and had already drifted — one copy skipping .filter(Boolean)) in ops.js,
// war-board.js, and evaluator.js before being consolidated here.
export function liveClanTagSet(clan) {
  return new Set((clan?.memberList ?? []).map(m => cleanTag(m?.tag)).filter(Boolean));
}

// Convenience wrapper for the common case: filter a buildMemberIntel() result
// down to members still actually in the clan.
export function filterToCurrentClan(members, clan) {
  const tags = liveClanTagSet(clan);
  return (Array.isArray(members) ? members : []).filter(m => tags.has(cleanTag(m?.tag)));
}

export function extractRaceMeta(race) {
  return {
    state: race?.state ? String(race.state) : 'unknown',
    sectionIndex: race?.sectionIndex ?? null,
    periodIndex: race?.periodIndex ?? null,
  };
}

// The CR API's race log (getRiverRaceLog) is the permanent, authoritative record of
// a race once it's over — used to reconcile our own on-demand snapshots, which can
// miss a member's final burst of war-day play (see history.js's
// reconcileFinalWarDayFromLog). Shared here since ops.js/war.js and schedule.js both
// need the same "find our clan's most recently completed race entry" extraction.
export function extractLatestClanLogParticipants(raceLog, clanTag) {
  const items = Array.isArray(raceLog) ? raceLog : (Array.isArray(raceLog?.items) ? raceLog.items : []);
  const clanTagClean = cleanTag(clanTag);
  const latest = items[0];
  const ourClan = latest?.standings?.find(s => cleanTag(s?.clan?.tag) === clanTagClean);
  return ourClan?.clan?.participants ?? [];
}
