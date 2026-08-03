/**
 * Kraken CR-API Module
 * Consolidated Version: Fixed Export Conflicts & Lazy Env Loading
 */
import {
  canRequest,
  recordFailure,
  recordSuccess,
  getBreakerStatus as getRealBreakerStatus,
  shouldWarnDegraded as realShouldWarnDegraded,
} from './circuit-breaker.js';

function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function getConfig() {
  const baseRaw = pickEnv("CR_API_BASE","CRAPI_BASE","CR_BASE","CR_BASE_URL","CR_API_URL");
  const token = pickEnv("CR_API_TOKEN","CRAPI_TOKEN","CR_TOKEN","CR_API_JWT");
  const base = baseRaw.replace(/\/+$/, "");
  return { base, token };
}

function assertConfigured() {
  const { base, token } = getConfig();
  const missing = [];
  if (!base) missing.push("CR_API_BASE");
  if (!token) missing.push("CR_API_TOKEN");

  if (missing.length) {
    throw new Error(`CR API misconfigured (missing ${missing.join(" and ")})`);
  }
  return { base, token };
}

/**
 * CORE FETCH HELPER
 */
export async function crFetch(path, options = {}) {
  const { base, token } = assertConfigured();
  const cleanPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  const url = `${base}${cleanPath}`;

  // Fail fast if the breaker is open — don't hammer an already-unstable upstream.
  // circuit-breaker.js existed as a fully-built module but was never actually wired up
  // here; this file had its own stub getBreakerStatus()/shouldWarnDegraded() that always
  // returned "everything's fine", which is why /ops's "API state" line never once showed
  // degraded regardless of real API health.
  if (!canRequest()) {
    const status = getRealBreakerStatus();
    throw new Error(`CR API circuit breaker open (retry in ${status.remainingSec}s): ${status.lastError || 'repeated failures'}`);
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...((options && options.headers) ? options.headers : {})
  };

  // Bounded so a stalled connection or a hung upstream can never block a caller
  // indefinitely. This matters beyond just this request: scripts/season-reset.js
  // holds the cross-process history.json lock across this exact call, and that
  // lock's 5-minute staleness override assumes no legitimate holder needs
  // anywhere near that long — an unbounded fetch could exceed it and get force-
  // evicted by a concurrent process while still alive, defeating the lock.
  //
  // 20s was tried first and was too tight: /war and /ops fire THREE of these
  // concurrently (getClan/getCurrentRiverRace/getRiverRaceLog via Promise.all),
  // and a real (if slow) CR API response tripped it in production within hours
  // of shipping, hard-failing a routine command that has nothing to do with the
  // lock this timeout exists for. 90s keeps a wide margin below the 5-minute
  // staleness window (a real hang still gets caught well before then) while
  // giving normal CR API latency variance enough room not to false-positive.
  const CR_API_TIMEOUT_MS = 90_000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), CR_API_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: timeoutController.signal });
  } catch (e) {
    // Network-level failure (DNS, connection refused, timeout) — always a real API-health signal.
    recordFailure(String(e?.message ?? e));
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.ok) {
    recordSuccess();
    return res;
  }

  // Only rate-limiting and server-side errors count as breaker-tripping failures. A 404/400
  // from a bad tag lookup is a caller/input problem, not an unhealthy API — counting those
  // would let one mistyped tag contribute to opening the breaker for everyone.
  if (res.status === 429 || res.status >= 500) {
    recordFailure(`HTTP ${res.status}`);
  }

  // Avoid leaking response bodies or full URLs into logs by default.
  // Some error payloads can contain sensitive or noisy data.
  let bodyText = "";
  if (String(process.env.DEBUG_CR_API_BODY ?? '') === '1') {
    try { bodyText = await res.text(); } catch { bodyText = ""; }
  }
  const bodyHint = bodyText ? ` :: ${bodyText.slice(0, 200)}` : '';
  throw new Error(`CR API ${res.status}: ${cleanPath}${bodyHint}`);
}

/**
 * REQUIRED INTERFACE FUNCTIONS (Line 29-34 in index.js)
 */

export async function getClan(tag = process.env.CLAN_TAG) {
  if (!tag) throw new Error("CLAN_TAG missing");
  const res = await crFetch("/v1/clans/%23" + tag.replace('#', ''));
  return await res.json();
}

export async function getPlayer(tag) {
  if (!tag) return null;
  const res = await crFetch("/v1/players/%23" + tag.replace('#', ''));
  return await res.json();
}

export async function getCurrentRiverRace(tag = process.env.CLAN_TAG) {
  if (!tag) throw new Error("CLAN_TAG missing");
  const res = await crFetch("/v1/clans/%23" + tag.replace('#', '') + "/currentriverrace");
  return await res.json();
}

export async function getRiverRaceLog(tag = process.env.CLAN_TAG) {
  if (!tag) return [];
  const res = await crFetch("/v1/clans/%23" + tag.replace('#', '') + "/riverracelog");
  return await res.json();
}

export function getBreakerStatus() {
  return getRealBreakerStatus();
}

export function shouldWarnDegraded() {
  return realShouldWarnDegraded();
}
