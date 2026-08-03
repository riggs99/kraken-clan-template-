/**
 * Input validation and sanitization utilities
 * Ensures all user inputs are safely validated before use
 */
import { redactSecrets } from './security.js';

/**
 * Validate clan tag (already cleaned by cleanTag, but add extra validation)
 * @param {string} tag - Clan tag (without #)
 * @returns {boolean} - True if valid
 */
export function validateClanTag(tag) {
  if (!tag || typeof tag !== 'string') {
    return false;
  }

  // Clan tags are alphanumeric, 3-14 characters
  const tagPattern = /^[A-Z0-9]{3,14}$/;
  return tagPattern.test(tag);
}

/**
 * Validate Discord channel ID
 * @param {string} channelId - Discord channel ID
 * @returns {boolean} - True if valid format
 */
export function validateChannelId(channelId) {
  if (!channelId || typeof channelId !== 'string') {
    return false;
  }

  // Discord IDs are numeric strings, typically 17-20 digits
  const idPattern = /^\d{17,20}$/;
  return idPattern.test(channelId);
}

/**
 * Sanitize error messages to prevent information disclosure
 * @param {Error|string} error - Error object or message
 * @returns {string} - Safe error message for users
 */
export function sanitizeErrorMessage(error) {
  const message = error?.message || String(error);

  // Catch literal secret values (env-driven scan for TOKEN/SECRET/KEY/PASS/JWT-named
  // vars) before the shape-based patterns below — this reply is user-facing, so it
  // needs the same coverage as formatErrorForLog's log-facing redaction, not just the
  // fixed set of known token/path shapes.
  let sanitized = redactSecrets(message);

  // Remove any file paths
  sanitized = sanitized.replace(/[A-Za-z]:\\[^:\s]+/g, '[path]');
  sanitized = sanitized.replace(/\/[\w./]+/g, '[path]');

  // (Bearer/Discord-token/interaction-URL shapes are already redacted by redactSecrets above.)

  // Remove any potential SQL-like patterns (future-proofing)
  sanitized = sanitized.replace(/SELECT|INSERT|UPDATE|DELETE|DROP/gi, '[sql]');
  
  // Limit length to prevent excessive output
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 197) + '...';
  }
  
  return sanitized;
}

/**
 * Validate environment configuration at startup
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validateEnvironmentConfig() {
  const errors = [];

  // Required variables
  const required = [
    'DISCORD_TOKEN',
    'DISCORD_APP_ID',
    'DISCORD_GUILD_ID',
    'CR_API_BASE',
    'CR_API_TOKEN',
    'CLAN_TAG'
  ];

  for (const key of required) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  // Validate specific formats
  if (process.env.CLAN_TAG && !validateClanTag(process.env.CLAN_TAG)) {
    errors.push('CLAN_TAG must be alphanumeric, 3-14 characters');
  }

  if (process.env.LEADER_CHANNEL_ID && !validateChannelId(process.env.LEADER_CHANNEL_ID)) {
    errors.push('LEADER_CHANNEL_ID must be a valid Discord channel ID (numeric)');
  }

  if (process.env.REPORTS_CHANNEL_ID && !validateChannelId(process.env.REPORTS_CHANNEL_ID)) {
    errors.push('REPORTS_CHANNEL_ID must be a valid Discord channel ID (numeric)');
  }

  if (process.env.DISCORD_GUILD_ID && !validateChannelId(process.env.DISCORD_GUILD_ID)) {
    errors.push('DISCORD_GUILD_ID must be a valid Discord guild ID (numeric)');
  }

  // Validate API base URL
  if (process.env.CR_API_BASE && !process.env.CR_API_BASE.startsWith('https://')) {
    errors.push('CR_API_BASE must be an HTTPS URL');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Dead rate-limit subsystem removed (isRateLimited/cleanupRateLimits/userRateLimits):
// isRateLimited had zero callers, so the map cleanupRateLimits swept every 5 minutes
// from index.js was permanently empty. cooldown.js's onCooldown provides the real
// per-user command throttling.
