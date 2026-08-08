import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { validateEnvironmentConfig } from '../src/validation.js';
import { loadOpsConfig, loadRecruitConfig } from '../src/config/loadConfig.js';
import { getClan } from '../src/cr-api.js';

loadEnv();

const results = [];
function pass(label, detail) { results.push({ ok: true, label, detail }); }
function fail(label, detail, fix) { results.push({ ok: false, label, detail, fix }); }

const DISCORD_API = 'https://discord.com/api/v10';
const PERM_MANAGE_ROLES = 1n << 28n;
const PERM_MANAGE_CHANNELS = 1n << 4n;

async function discordApi(pathname) {
  const res = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
  });
  return res;
}

// 1. Env vars
const envResult = validateEnvironmentConfig();
if (envResult.valid) {
  pass('Required .env values present and well-formed');
} else {
  for (const msg of envResult.errors) {
    fail('Environment variable', msg, 'Open .env and fill in the missing/invalid value, then re-run this check.');
  }
}

// 2. Config files (PUT_* placeholder guard)
let opsConfig = null;
try {
  opsConfig = loadOpsConfig();
  pass('config/ops.config.json has no placeholders left');
} catch (e) {
  fail('config/ops.config.json', e.message, 'Open config/ops.config.json and replace any PUT_* value with your real server ID.');
}

let recruitConfig = null;
try {
  recruitConfig = loadRecruitConfig();
  pass('config/recruit.config.json has no placeholders left');
} catch (e) {
  fail('config/recruit.config.json', e.message, 'Open config/recruit.config.json and replace any PUT_* value (recruitGuildId, clanName, warServer.inviteUrl).');
}

// Catches the common copy/paste mistake of pointing .env and the config files at different servers.
if (process.env.DISCORD_GUILD_ID) {
  if (opsConfig && String(opsConfig.opsGuildId) !== String(process.env.DISCORD_GUILD_ID)) {
    fail('config/ops.config.json opsGuildId', 'Does not match DISCORD_GUILD_ID in .env', 'Make opsGuildId the same server ID as DISCORD_GUILD_ID.');
  }
  if (recruitConfig && String(recruitConfig.recruitGuildId) !== String(process.env.DISCORD_GUILD_ID)) {
    fail('config/recruit.config.json recruitGuildId', 'Does not match DISCORD_GUILD_ID in .env', 'Make recruitGuildId the same server ID as DISCORD_GUILD_ID.');
  }
}

// 3. Discord token actually works
let botUser = null;
if (process.env.DISCORD_TOKEN) {
  try {
    const res = await discordApi('/users/@me');
    if (res.ok) {
      botUser = await res.json();
      pass('Discord bot token is valid', `Logged in as ${botUser.username}`);
    } else if (res.status === 401) {
      fail('Discord bot token', 'Discord rejected it (401 Unauthorized)', 'The token is wrong or was reset. Copy a fresh one from the Bot tab in the Discord Developer Portal and update DISCORD_TOKEN in .env.');
    } else {
      fail('Discord bot token', `Discord returned HTTP ${res.status}`, 'Check your internet connection and try again.');
    }
  } catch (e) {
    fail('Discord bot token', `Could not reach Discord: ${e.message}`, 'Check your internet connection and try again.');
  }
} else {
  fail('Discord bot token', 'DISCORD_TOKEN is not set', 'Fill in DISCORD_TOKEN in .env first.');
}

// 4. Bot is actually a member of the configured server, with the permissions it needs
if (botUser && process.env.DISCORD_GUILD_ID) {
  try {
    const res = await discordApi('/users/@me/guilds');
    if (res.ok) {
      const guilds = await res.json();
      const guild = guilds.find(g => g.id === String(process.env.DISCORD_GUILD_ID));
      if (!guild) {
        fail(
          'Bot server membership',
          `Bot is not in server ${process.env.DISCORD_GUILD_ID}`,
          'Re-invite the bot: OAuth2 -> URL Generator (scopes bot + applications.commands) and pick this server when authorizing.'
        );
      } else {
        pass('Bot is in the configured Discord server', guild.name);
        const perms = BigInt(guild.permissions ?? '0');
        const missing = [];
        if ((perms & PERM_MANAGE_ROLES) === 0n) missing.push('Manage Roles');
        if ((perms & PERM_MANAGE_CHANNELS) === 0n) missing.push('Manage Channels');
        if (missing.length > 0) {
          fail(
            'Bot server permissions',
            `Missing: ${missing.join(', ')}`,
            'Re-invite the bot using the invite link with those permissions checked, or grant them to the bot\'s role in Server Settings -> Roles.'
          );
        } else {
          pass('Bot has Manage Roles + Manage Channels in the server');
        }
      }
    } else {
      fail('Bot server membership', `Discord returned HTTP ${res.status} listing bot guilds`, 'Try again in a moment.');
    }
  } catch (e) {
    fail('Bot server membership', `Could not reach Discord: ${e.message}`, 'Check your internet connection and try again.');
  }
}

// 5. Leader channel is real and visible to the bot
if (botUser && process.env.LEADER_CHANNEL_ID) {
  try {
    const res = await discordApi(`/channels/${process.env.LEADER_CHANNEL_ID}`);
    if (res.ok) {
      const channel = await res.json();
      pass('LEADER_CHANNEL_ID resolves to a real channel', `#${channel.name}`);
    } else {
      fail(
        'LEADER_CHANNEL_ID',
        `Discord returned HTTP ${res.status} for that channel ID`,
        'Right-click the intended channel in Discord -> Copy Channel ID -> paste into .env as LEADER_CHANNEL_ID.'
      );
    }
  } catch (e) {
    fail('LEADER_CHANNEL_ID', `Could not reach Discord: ${e.message}`, 'Check your internet connection and try again.');
  }
}

// 6. Clash Royale API key + clan tag actually work together
if (process.env.CR_API_TOKEN && process.env.CLAN_TAG) {
  try {
    const clan = await getClan();
    pass('Clash Royale API token + clan tag work', clan.name ?? process.env.CLAN_TAG);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('403')) {
      fail('Clash Royale API', 'Rejected with HTTP 403 (usually a wrong IP binding)', 'Check your current public IP at whatismyip.com and make sure it matches the IP the key was created with at developer.clashroyale.com. Re-create the key if your IP changed.');
    } else if (msg.includes('404')) {
      fail('Clash Royale API', 'Rejected with HTTP 404 (clan tag not found)', 'Double check CLAN_TAG in .env matches the clan tag exactly, without the leading #.');
    } else {
      fail('Clash Royale API', msg, 'Check CR_API_TOKEN and CLAN_TAG in .env, and your internet connection.');
    }
  }
} else {
  fail('Clash Royale API', 'CR_API_TOKEN or CLAN_TAG not set', 'Fill in both in .env first.');
}

// 7. Database path is writable and the native SQLite driver loads
try {
  const { default: Database } = await import('better-sqlite3');
  const dbPath = process.env.KRAKEN_DB_PATH || path.join(process.cwd(), 'data', 'kraken.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.close();
  pass('Database file is writable', dbPath);
} catch (e) {
  fail('Database', e.message, 'Make sure the data/ folder exists and this account has permission to write to it, then run "npm install" again if the error mentions better-sqlite3.');
}

// 8. Slash commands registered for this server
if (botUser && process.env.DISCORD_APP_ID && opsConfig?.opsGuildId) {
  try {
    const res = await discordApi(`/applications/${process.env.DISCORD_APP_ID}/guilds/${opsConfig.opsGuildId}/commands`);
    if (res.ok) {
      const commands = await res.json();
      const names = new Set(commands.map(c => c.name));
      if (names.has('ops') && names.has('war')) {
        pass('Slash commands are registered in the server');
      } else {
        fail('Slash commands', 'ops/war commands not found in this server yet', 'Run "npm run deploy" once your config files are complete.');
      }
    }
  } catch {
    // Non-critical - skip silently, this is just a convenience check.
  }
}

console.log('\n=== KRAKEN setup check ===\n');
for (const r of results) {
  if (r.ok) {
    console.log(`[OK]   ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    console.log(`[FAIL] ${r.label}: ${r.detail}`);
    console.log(`       Fix: ${r.fix}`);
  }
}

const failed = results.filter(r => !r.ok);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} of ${results.length} checks failed. Fix the items above, then run this check again: npm run setup-check`);
  process.exitCode = 1;
} else {
  console.log(`All ${results.length} checks passed. Run "npm run deploy" if you haven't yet, then start the bot with "npm start" and try /recruit-setup in Discord.`);
}
