let failureCount = 0;
let windowStart = 0;
let openUntil = 0;
let lastError = '';

const DEFAULT_WINDOW_MS = 60000;      // 1 minute
const DEFAULT_THRESHOLD = 5;          // 5 failures in window
const DEFAULT_OPEN_MS = 600000;       // 10 minutes open

function getNum(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getBreakerConfig() {
  return {
    windowMs: getNum('CR_BREAKER_WINDOW_MS', DEFAULT_WINDOW_MS),
    threshold: getNum('CR_BREAKER_THRESHOLD', DEFAULT_THRESHOLD),
    openMs: getNum('CR_BREAKER_OPEN_MS', DEFAULT_OPEN_MS)
  };
}

// A failure burst with no further calls afterward left failureCount frozen forever
// (it only decayed on the *next* recordFailure), so shouldWarnDegraded/getBreakerStatus
// could report "degraded" indefinitely after a transient blip with nothing left to
// reset it. Expire the window on read too, not just on the next failure.
function decayIfWindowExpired() {
  const now = Date.now();
  const cfg = getBreakerConfig();
  if (windowStart && (now - windowStart) > cfg.windowMs) {
    windowStart = 0;
    failureCount = 0;
  }
}

export function canRequest() {
  const now = Date.now();
  return !(openUntil > now);
}

export function recordFailure(errMsg) {
  const now = Date.now();
  const cfg = getBreakerConfig();

  if (!windowStart || (now - windowStart) > cfg.windowMs) {
    windowStart = now;
    failureCount = 0;
  }

  failureCount += 1;
  lastError = String(errMsg || '');

  if (failureCount >= cfg.threshold) {
    openUntil = now + cfg.openMs;
  }
}

export function recordSuccess() {
  // On success, gently cool down failure pressure.
  if (failureCount > 0) failureCount -= 1;
}

export function getBreakerStatus() {
  decayIfWindowExpired();
  const now = Date.now();
  const isOpen = openUntil > now;
  const remainingMs = isOpen ? (openUntil - now) : 0;
  return {
    isOpen,
    remainingSec: Math.ceil(remainingMs / 1000),
    failureCount,
    lastError
  };
}

export function shouldWarnDegraded() {
  decayIfWindowExpired();
  const cfg = getBreakerConfig();
  // warn when we're close to opening
  return failureCount >= Math.max(1, cfg.threshold - 2);
}
