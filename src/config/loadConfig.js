import fs from 'node:fs';
import path from 'node:path';

function mustGet(obj, dottedKey) {
  const parts = String(dottedKey).split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`Config invalid: Missing required key "${dottedKey}"`);
    }
    cur = cur[p];
  }
  return cur;
}

function findPutPlaceholders(value, found = []) {
  if (typeof value === 'string') {
    if (value.includes('PUT_')) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) findPutPlaceholders(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) findPutPlaceholders(v, found);
    return found;
  }
  return found;
}

function loadJsonFile(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing config file: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(`Config invalid JSON: ${absPath} (${msg})`);
  }
}

export function loadConfig({ absPath, requiredKeys = [] }) {
  const cfg = loadJsonFile(absPath);

  for (const k of requiredKeys) mustGet(cfg, k);

  const placeholders = findPutPlaceholders(cfg);
  if (placeholders.length > 0) {
    console.error(
      'Enable Developer Mode in Discord → Right-click server/channel/role → Copy ID → paste into config.'
    );
    throw new Error('Config incomplete: Replace all PUT_* placeholders in config/*.json');
  }

  return cfg;
}

export function loadOpsConfig() {
  const absPath = path.resolve(process.cwd(), 'config', 'ops.config.json');
  // Only `enabled` and `opsGuildId` are actually read anywhere in the codebase (confirmed
  // via grep — OPS's real auth runs through permissions.js's env-var-based isAuthorized(),
  // not this file). The channels/roles/clan/features keys used to be required here too, a
  // holdover from before the /ops redesign, which meant a fresh setup had to populate 9
  // fields with zero effect on behavior before the bot would even start.
  return loadConfig({
    absPath,
    requiredKeys: [
      'enabled',
      'opsGuildId',
    ]
  });
}

export function loadRecruitConfig() {
  const absPath = path.resolve(process.cwd(), 'config', 'recruit.config.json');
  // roles.applicantRoleId/approvedRoleId and the cooldowns/probation/scoring blocks are
  // holdovers from a pre-policy.js design (a numeric score-threshold recruit system,
  // before the perfect-32/32-window tier logic in src/recruit/policy.js replaced it) —
  // confirmed via grep, none of them are read anywhere in the current codebase. Trimmed
  // to just what's actually required to start.
  return loadConfig({
    absPath,
    requiredKeys: [
      'enabled',
      'recruitGuildId',
      'clanName',
      'channels.welcomeChannelId',
      'channels.applyChannelId',
      'channels.decisionsLogChannelId',
      'roles.newArrivalRoleId',
      'roles.probationRoleId',
      'warServer.inviteUrl',
    ]
  });
}

