export function todayKeyISO() {
  return new Date().toISOString().slice(0, 10);
}

export function cleanTag(raw) {
  const up = String(raw || '').replace('#', '').toUpperCase();
  return up.replace(/[^A-Z0-9]/g, '').slice(0, 14);
}

const PLAYER_TAG_RE = /^[PYLQGRJCUV0289]{3,14}$/;

export function normalizePlayerTag(raw) {
  const clean = cleanTag(raw);
  return PLAYER_TAG_RE.test(clean) ? clean : null;
}

export function avg(nums) {
  const arr = (nums ?? []).map(Number).filter(n => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a,b) => a + b, 0) / arr.length;
}

export function trendArrow(current, baseline) {
  const c = Number(current ?? 0);
  const b = Number(baseline);
  if (!Number.isFinite(b) || b <= 0) return '🆕';
  if (c >= b * 1.15) return '📈';
  if (c <= b * 0.85) return '📉';
  return '➖';
}

export function daysBetweenISO(fromISO, toISO) {
  try {
    const a = new Date(fromISO + 'T00:00:00Z').getTime();
    const b = new Date(toISO + 'T00:00:00Z').getTime();
    const diff = Math.floor((b - a) / (1000 * 60 * 60 * 24));
    return Number.isFinite(diff) ? diff : null;
  } catch {
    return null;
  }
}

export function daysSinceLastSeen(lastSeenISO) {
  if (!lastSeenISO) return null;
  try {
    const lastSeen = new Date(lastSeenISO).getTime();
    const now = Date.now();
    const diff = Math.floor((now - lastSeen) / (1000 * 60 * 60 * 24));
    return Number.isFinite(diff) ? diff : null;
  } catch {
    return null;
  }
}

export function formatDaysAgo(days) {
  if (days === null || days === undefined) return 'Unknown';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export function participationRate(activeDays, totalDays) {
  if (!totalDays || totalDays === 0) return 0;
  return Math.round((activeDays / totalDays) * 100);
}
