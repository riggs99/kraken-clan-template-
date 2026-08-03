function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text) {
  let s = String(text ?? '');

  // Common auth patterns
  s = s.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, 'Authorization: Bearer [redacted]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, 'Bearer [redacted]');

  // Discord bot token (typical 3-part base64-ish)
  s = s.replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,}\b/g, '[discord_token_redacted]');

  // Discord interaction callback URLs include a short-lived interaction token; redact it.
  s = s.replace(/https:\/\/discord\.com\/api\/v\d+\/interactions\/(\d+)\/[^/\s]+/g, 'https://discord.com/api/vX/interactions/$1/[interaction_token_redacted]');

  // Redact any env values for obvious secret keys (best-effort).
  try {
    for (const [key, value] of Object.entries(process.env ?? {})) {
      if (!value || typeof value !== 'string') continue;
      if (!/(TOKEN|SECRET|KEY|PASS|PASSWORD|JWT)/i.test(key)) continue;
      const v = value.trim();
      if (v.length < 8) continue;
      s = s.replace(new RegExp(escapeRegExp(v), 'g'), `[${key}_redacted]`);
    }
  } catch {
    // ignore
  }

  return s;
}

export function formatErrorForLog(err) {
  if (!err) return '';
  const name = err?.name ? String(err.name) : 'Error';
  const message = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack) : '';
  const out = stack && stack.includes(message) ? stack : `${name}: ${message}\n${stack}`;
  return redactSecrets(out).trim();
}

