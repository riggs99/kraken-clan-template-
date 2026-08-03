const cooldowns = new Map();
const DEFAULT_MS = 10_000; // 10 seconds per command per user
const PRUNE_THRESHOLD = 500;

function pruneExpired(now = Date.now()) {
  for (const [key, until] of cooldowns) {
    if (now >= until) cooldowns.delete(key);
  }
}

export function onCooldown(userId, command, ms = DEFAULT_MS) {
  const key = userId + ':' + command;
  const now = Date.now();
  let until = cooldowns.get(key) || 0;

  if (until > 0 && now >= until) {
    cooldowns.delete(key);
    until = 0;
  }

  if (now < until) {
    return { on: true, retryAfter: Math.ceil((until - now) / 1000) };
  }

  if (cooldowns.size >= PRUNE_THRESHOLD) pruneExpired(now);

  cooldowns.set(key, now + ms);
  return { on: false, retryAfter: 0 };
}
