#!/usr/bin/env node
// Automates everything in docs/onboard-a-clan.md AFTER the two steps that can
// never be automated (creating the Discord bot application, generating the CR
// API key — no public API exists for either). Run from a dedicated reference
// checkout (never a live clan folder, never itself started as a bot):
//
//   node /root/clans/_template/scripts/provision-clan.mjs --name <slug> [--dry-run] [--force-ram-check]
//
// See the plan this was built from for the full design rationale (safety
// guards, re-entry behavior, RAM-headroom gating) — this file's comments
// cover the "why" at each step, not a restatement of the plan.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateClanTag, validateChannelId } from '../src/validation.js';
import { redactSecrets } from '../src/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_ROOT = path.dirname(__dirname);
const CLANS_ROOT = path.dirname(REFERENCE_ROOT);
const PROVISIONING_LOG = path.join(REFERENCE_ROOT, 'provisioning.log');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RAM_HARD_BLOCK_MB = 150;
const RAM_WARN_MB = 400;

// Manage Roles (1<<28) + Manage Channels (1<<4) + Send Messages (1<<11) +
// Manage Messages (1<<13) + Embed Links (1<<14) + Read Message History (1<<16).
// Computed the same way scripts/setup-check.js already checks for (see its
// PERM_MANAGE_ROLES/PERM_MANAGE_CHANNELS bigint shifts) — matches the exact
// permission list documented in SETUP.md's invite step. Double-check against
// Discord's own permission calculator in the Developer Portal if this is ever
// suspected of drifting from what SETUP.md documents.
const INVITE_PERMISSIONS = (
  (1n << 28n) | (1n << 4n) | (1n << 11n) | (1n << 13n) | (1n << 14n) | (1n << 16n)
).toString();

const SECRET_VALUES = []; // literal secret strings collected this run, for redaction

function redact(text) {
  let s = redactSecrets(String(text ?? ''));
  for (const v of SECRET_VALUES) {
    if (v) s = s.split(v).join('[redacted]');
  }
  return s;
}

function log(msg) {
  process.stdout.write(`${redact(msg)}\n`);
}

function fail(msg) {
  process.stderr.write(`\n[PROVISION] ${redact(msg)}\n`);
  process.exitCode = 1;
  throw new ProvisionAbort(msg);
}

class ProvisionAbort extends Error {}

function fingerprint(secret) {
  const s = String(secret ?? '');
  return s.length >= 4 ? `...${s.slice(-4)}` : '(empty)';
}

// --- CLI args -----------------------------------------------------------

function parseArgs(argv) {
  const args = { name: null, dryRun: false, forceRamCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') args.name = argv[++i] ?? null;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force-ram-check') args.forceRamCheck = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// --- Subprocess helpers ---------------------------------------------------
// Every mutating action in this script routes through run()/writeFileAtomic()
// below, gated on args.dryRun — this is the one place dry-run and real paths
// can diverge, by construction, since there's only one code path for each.
// readOnly:true calls (version checks, pm2 jlist, RAM read) always execute
// for real, even under --dry-run, since they're needed to report an accurate
// simulation and never mutate anything.

function run(cmd, cmdArgs, { cwd, readOnly = false, stdio = 'inherit' } = {}) {
  if (args.dryRun && !readOnly) {
    log(`[DRY RUN] would run: ${cmd} ${cmdArgs.join(' ')}${cwd ? ` (cwd: ${cwd})` : ''}`);
    return { status: 0, stdout: '', dryRun: true };
  }
  return spawnSync(cmd, cmdArgs, { cwd, stdio, encoding: 'utf8' });
}

function writeFileAtomic(filePath, content) {
  if (args.dryRun) {
    log(`[DRY RUN] would write: ${filePath}`);
    return;
  }
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// --- pm2 helpers -----------------------------------------------------------
// Deliberately no wrapper here ever accepts an arbitrary pm2 subcommand —
// only these four operations exist, matching the plan's explicit pm2
// allowlist. `pm2 restart all` / `pm2 delete all` / any unscoped form must
// never be reachable from this script, given the shared-host blast radius.

function pm2List() {
  const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (result.status !== 0) fail(`pm2 jlist failed: ${result.stderr || result.error}`);
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    fail(`pm2 jlist returned unparseable output: ${e?.message ?? e}`);
    return [];
  }
}

function pm2Find(name) {
  return pm2List().find(p => p.name === name) ?? null;
}

function pm2Start(ecosystemPath) {
  return run('pm2', ['start', ecosystemPath], { readOnly: false });
}

function pm2Save() {
  return run('pm2', ['save'], { readOnly: false });
}

function pm2Logs(name, lines = 30) {
  return spawnSync('pm2', ['logs', name, '--lines', String(lines), '--nostream'], { encoding: 'utf8' });
}

// --- Prompts -----------------------------------------------------
// Deliberately NOT using node:readline. An earlier version mixed
// readline.question() (for normal prompts) with a separate hand-rolled
// raw-mode reader (for masked ones) — confirmed live on the actual host that
// this produced a real bug: a masked token prompt echoed a mix of real
// characters and asterisks instead of all asterisks, almost certainly
// readline's own internal keypress/echo handling on a real TTY still firing
// even with the raw-mode override active. Fixed by dropping readline
// entirely and routing every prompt (masked or not) through the exact same
// single raw-mode reader below — there is only ever one thing echoing a
// character to the screen now, so there is nothing left for it to race
// against. Trade-off: no arrow-key cursor movement or input history, just
// typing and backspace — an acceptable simplification for a one-time setup
// wizard, not a general-purpose shell.

function readLine({ mask = false } = {}) {
  return new Promise(resolve => {
    let input = '';
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    const onData = (buf) => {
      for (const ch of buf) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '') { // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') { // backspace/DEL
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        input += ch;
        process.stdout.write(mask ? '*' : ch);
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(promptText) {
  process.stdout.write(promptText);
  const value = await readLine({ mask: false });
  return value.trim();
}

async function askMasked(promptText) {
  process.stdout.write(promptText);
  const value = await readLine({ mask: true });
  return value.trim();
}

async function askValidated(promptText, validator, errorMsg) {
  for (;;) {
    const value = await ask(promptText);
    if (validator(value)) return value;
    log(`  ${errorMsg}`);
  }
}

async function askMaskedRequired(promptText) {
  for (;;) {
    const value = await askMasked(promptText);
    if (value.length > 0) return value;
    log('  This value is required.');
  }
}

async function waitForEnter(promptText) {
  await ask(promptText);
}

// --- Startup checks ----------------------------------------------------

function checkReferenceCheckout() {
  const envHere = path.join(REFERENCE_ROOT, '.env');
  if (fs.existsSync(envHere)) {
    fail(
      `${REFERENCE_ROOT} has its own .env file — this looks like a live clan folder, ` +
      `not the reference checkout. Run this from the dedicated reference checkout instead ` +
      `(a clone that is never filled in, never started under pm2).`
    );
  }
}

function checkPrereqs() {
  if (!process.stdin.isTTY) {
    fail('This script must be run interactively in a real terminal (no piping/redirection) — secrets are never accepted via stdin redirection.');
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) fail(`Node 20+ required, found ${process.versions.node}.`);
  for (const tool of ['git', 'pm2', 'npm']) {
    const check = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (check.status !== 0) fail(`Required tool not found on PATH: ${tool}`);
  }
  if (!args.name) fail('Usage: provision-clan.mjs --name <slug> [--dry-run] [--force-ram-check]');
  if (!SLUG_PATTERN.test(args.name)) {
    fail(`--name "${args.name}" is invalid. Must match ${SLUG_PATTERN} (lowercase letters, digits, hyphens, 2-31 chars, cannot start with a hyphen) — it becomes a folder name and a pm2 process name.`);
  }
}

// --- RAM check -----------------------------------------------------------

function readAvailableRamMb() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (!match) return null;
    return Math.round(Number(match[1]) / 1024);
  } catch {
    return null; // not Linux, or unreadable — caller decides how to handle
  }
}

// --- Config templating -----------------------------------------------------
// Reads the reference checkout's OWN current files as the template source —
// deliberately never a hardcoded copy embedded in this script, so a change to
// .env.example / config shapes in a later commit is picked up automatically
// without touching this file.

function buildEnvFile(collected) {
  const examplePath = path.join(REFERENCE_ROOT, '.env.example');
  if (!fs.existsSync(examplePath)) fail(`.env.example not found at ${examplePath} — is REFERENCE_ROOT correct?`);
  const lines = fs.readFileSync(examplePath, 'utf8').split('\n');
  const fill = {
    DISCORD_TOKEN: collected.discordToken,
    DISCORD_APP_ID: collected.discordAppId,
    DISCORD_GUILD_ID: collected.guildId,
    CR_API_TOKEN: collected.crApiToken,
    CLAN_TAG: collected.clanTag,
  };
  if (collected.leaderChannelId) fill.LEADER_CHANNEL_ID = collected.leaderChannelId;

  const seen = new Set();
  const out = lines.map(line => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && Object.prototype.hasOwnProperty.call(fill, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${fill[m[1]]}`;
    }
    return line;
  });
  for (const key of Object.keys(fill)) {
    if (!seen.has(key)) out.push(`${key}=${fill[key]}`);
  }
  return out.join('\n');
}

function buildOpsConfig(collected) {
  const srcPath = path.join(REFERENCE_ROOT, 'config', 'ops.config.json');
  const cfg = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  cfg.opsGuildId = collected.guildId;
  return JSON.stringify(cfg, null, 2) + '\n';
}

function buildRecruitConfig(collected) {
  const srcPath = path.join(REFERENCE_ROOT, 'config', 'recruit.config.json');
  const cfg = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  cfg.recruitGuildId = collected.guildId;
  cfg.clanName = collected.clanName;
  cfg.warServer = cfg.warServer ?? {};
  cfg.warServer.inviteUrl = collected.warInviteUrl;
  return JSON.stringify(cfg, null, 2) + '\n';
}

function buildEcosystemConfig(slug) {
  const srcPath = path.join(REFERENCE_ROOT, 'ecosystem.config.cjs');
  const raw = fs.readFileSync(srcPath, 'utf8');
  const targetLine = "name: 'kraken',";
  const occurrences = raw.split(targetLine).length - 1;
  if (occurrences !== 1) {
    fail(`ecosystem.config.cjs template shape changed (expected exactly one "${targetLine}", found ${occurrences}) — update provision-clan.mjs's buildEcosystemConfig() before continuing.`);
  }
  return raw.replace(targetLine, `name: '${slug}',`);
}

// --- Provisioning log --------------------------------------------------

function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  const redacted = redact(line);
  if (args.dryRun) {
    log(`[DRY RUN] would append to ${PROVISIONING_LOG}: ${redacted}`);
    return;
  }
  fs.appendFileSync(PROVISIONING_LOG, redacted + '\n', 'utf8');
}

// --- Re-entry detection --------------------------------------------------

function detectExistingClone(targetDir) {
  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) return { recognized: false };
  const originCheck = spawnSync('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const referenceOrigin = spawnSync('git', ['-C', REFERENCE_ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (originCheck.status === 0 && referenceOrigin.status === 0 && originCheck.stdout.trim() === referenceOrigin.stdout.trim()) {
    return { recognized: true };
  }
  return { recognized: false };
}

function envHasRealValues(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  const tokenLine = content.split('\n').find(l => l.startsWith('DISCORD_TOKEN='));
  return Boolean(tokenLine && tokenLine.slice('DISCORD_TOKEN='.length).trim().length > 0);
}

// --- Main ----------------------------------------------------------------

async function main() {
  checkPrereqs();
  checkReferenceCheckout();

  const slug = args.name;
  const targetDir = path.join(CLANS_ROOT, slug);

  log(`=== Provisioning clan "${slug}" ===`);
  if (args.dryRun) log('(dry run — nothing will actually be written or started)\n');

  // Collision pre-checks, before any secret prompting.
  const folderExists = fs.existsSync(targetDir);
  const existingPm2 = pm2Find(slug);

  let resumeMode = 'fresh';
  if (folderExists || existingPm2) {
    log(`Found existing state for "${slug}":`);
    if (folderExists) log(`  - folder exists: ${targetDir}`);
    if (existingPm2) log(`  - pm2 process "${slug}" exists (status: ${existingPm2.pm2_env?.status})`);

    if (existingPm2) {
      const existingCwd = existingPm2.pm2_env?.pm_cwd || existingPm2.pm2_env?.cwd;
      const expectedEcosystem = path.join(targetDir, 'ecosystem.config.cjs');
      const sameClan = existingCwd && path.resolve(existingCwd) === path.resolve(targetDir);
      if (!sameClan) {
        fail(
          `pm2 already has a process named "${slug}" pointing at a DIFFERENT directory ` +
          `(${existingCwd ?? 'unknown'}, expected ${targetDir}). Refusing to touch it — ` +
          `this is an unrelated collision, not a resumable partial run of this clan. ` +
          `Pick a different --name.`
        );
      }
      log(`Existing pm2 process "${slug}" already points at this clan's own folder (${expectedEcosystem}).`);
      log(`Treating this as a prior run that reached pm2 start. Re-checking status and saving.`);
      resumeMode = 'pm2-already-started';
    } else if (folderExists) {
      const clone = detectExistingClone(targetDir);
      if (!clone.recognized) {
        fail(
          `${targetDir} already exists but isn't recognized as a clone of this reference ` +
          `checkout's own repo — refusing to adopt an unrelated folder. Remove it manually ` +
          `first if it's genuinely leftover, or pick a different --name.`
        );
      }
      const envPath = path.join(targetDir, '.env');
      if (envHasRealValues(envPath)) {
        log(`${envPath} already has real values — this clan was already at least partially configured.`);
        const choice = await ask('Reuse existing config and jump to setup-check? [Y/n/abort]: ');
        if (/^a/i.test(choice)) fail('Aborted by operator.');
        if (/^n/i.test(choice)) {
          log('Editing individual fields isn\'t supported by this script yet — edit .env/config by hand, then re-run.');
          fail('Aborted — manual edit requested.');
        }
        resumeMode = 'reuse-config';
      } else {
        log('Folder exists but has no real .env values yet — resuming from npm install onward.');
        resumeMode = 'resume-install';
      }
    }
  }

  let collected = null;
  if (resumeMode === 'fresh' || resumeMode === 'resume-install') {
    collected = await collectInputs();
  }

  if (resumeMode === 'fresh') {
    fs.mkdirSync(CLANS_ROOT, { recursive: true });
    if (args.dryRun) {
      log(`[DRY RUN] would run: git clone <this repo> ${targetDir}`);
    } else {
      const referenceOrigin = spawnSync('git', ['-C', REFERENCE_ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
      if (referenceOrigin.status !== 0) fail('Could not determine the reference checkout\'s git remote URL.');
      const cloneResult = run('git', ['clone', referenceOrigin.stdout.trim(), targetDir]);
      if (cloneResult.status !== 0) fail('git clone failed — see output above.');
    }
  }

  if (resumeMode !== 'reuse-config' && resumeMode !== 'pm2-already-started') {
    writeFileAtomic(path.join(targetDir, '.env'), buildEnvFile(collected));
    writeFileAtomic(path.join(targetDir, 'config', 'ops.config.json'), buildOpsConfig(collected));
    writeFileAtomic(path.join(targetDir, 'config', 'recruit.config.json'), buildRecruitConfig(collected));
    writeFileAtomic(path.join(targetDir, 'ecosystem.config.cjs'), buildEcosystemConfig(slug));

    const installResult = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: targetDir });
    if (installResult.status !== 0) {
      appendLog({ slug, action: 'provision-failed', step: 'npm-install' });
      fail('npm install failed — see output above. Re-run this script to resume from here.');
    }

    log('\nRunning npm run setup-check...');
    const checkResult = run('npm', ['run', 'setup-check'], { cwd: targetDir });
    if (checkResult.status !== 0) {
      appendLog({ slug, action: 'provision-failed', step: 'setup-check' });
      fail('setup-check failed (see [FAIL] lines above for the exact fix). Fix the reported issue, then re-run this script with the same --name to resume.');
    }

    log('\nDeploying Discord slash commands...');
    const deployResult = run('node', ['scripts/deploy-commands.js'], { cwd: targetDir });
    if (deployResult.status !== 0) {
      appendLog({ slug, action: 'provision-failed', step: 'deploy-commands' });
      fail('deploy-commands.js failed — see output above. Re-run this script with the same --name to resume.');
    }
  } else if (resumeMode === 'reuse-config') {
    log('\nRe-running setup-check and deploy-commands against the existing config...');
    const checkResult = run('npm', ['run', 'setup-check'], { cwd: targetDir });
    if (checkResult.status !== 0) {
      appendLog({ slug, action: 'provision-failed', step: 'setup-check' });
      fail('setup-check failed — fix the reported issue and re-run.');
    }
    const deployResult = run('node', ['scripts/deploy-commands.js'], { cwd: targetDir });
    if (deployResult.status !== 0) {
      appendLog({ slug, action: 'provision-failed', step: 'deploy-commands' });
      fail('deploy-commands.js failed — see output above.');
    }
  }

  if (resumeMode !== 'pm2-already-started') {
    // RAM headroom check — a new instance's worst case is 350MB
    // (ecosystem.config.cjs's max_memory_restart), not the ~95MB steady-state
    // measured on this host, and host-wide OOM taking every hosted clan
    // offline at once is the single worst failure mode this whole script is
    // designed around avoiding — hence blocking by default, not just warning.
    const availableMb = readAvailableRamMb();
    if (availableMb === null) {
      log('Could not read /proc/meminfo (not Linux?) — skipping RAM check.');
    } else if (availableMb < RAM_HARD_BLOCK_MB && !args.forceRamCheck) {
      fail(`Only ${availableMb}MB RAM available (threshold ${RAM_HARD_BLOCK_MB}MB) — refusing to start a new instance. Pass --force-ram-check to override if you're certain this is safe.`);
    } else if (availableMb < RAM_WARN_MB) {
      log(`WARNING: only ${availableMb}MB RAM available (comfortable threshold ${RAM_WARN_MB}MB).`);
      const proceed = await ask('Proceed anyway? [y/N]: ');
      if (!/^y/i.test(proceed)) fail('Aborted by operator due to low RAM headroom.');
    } else {
      log(`RAM check OK: ${availableMb}MB available.`);
    }

    await finalConfirmation(slug, targetDir, collected, availableMb);

    log('\nStarting pm2 process...');
    const startResult = pm2Start(path.join(targetDir, 'ecosystem.config.cjs'));
    if (startResult.status !== 0 && !startResult.dryRun) {
      appendLog({ slug, action: 'provision-failed', step: 'pm2-start' });
      fail('pm2 start failed — see output above.');
    }
  }

  if (!args.dryRun) {
    let online = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(2000);
      const proc = pm2Find(slug);
      if (proc?.pm2_env?.status === 'online') { online = true; break; }
    }
    if (!online) {
      log(`\n"${slug}" did NOT come online. Recent logs:`);
      const logs = pm2Logs(slug, 30);
      log(logs.stdout || logs.stderr || '(no logs available)');
      log(`\nThis clan is NOT live. The pm2 entry was left in place for you to investigate — it was not auto-deleted.`);
      appendLog({ slug, action: 'provision-failed', step: 'pm2-online-check' });
      fail('Provisioning did not complete successfully.');
    }
    pm2Save();
  } else {
    log('[DRY RUN] would poll pm2 jlist for online status, then run: pm2 save');
  }

  appendLog({ slug, action: 'provision-success', dryRun: args.dryRun });

  log(`\n=== "${slug}" is live ===`);
  log(`Next: tell the clan leader to run /recruit-setup in their server.`);
  log(`  - Existing roster? Members use the "Link My Account" panel in #relink (keeps standing).`);
  log(`  - Brand-new recruits? Members use "Agree & Join" in #welcome.`);
}

async function collectInputs() {
  log('Enter the following (each is validated as you go):\n');
  const clanTagRaw = await askValidated('CR clan tag (without #): ', v => validateClanTag(v.replace('#', '').toUpperCase()), 'Must be 3-14 alphanumeric characters.');
  const clanTag = clanTagRaw.replace('#', '').toUpperCase();

  const discordAppId = await askValidated('Discord Application ID: ', validateChannelId, 'Must be a 17-20 digit Discord snowflake.');
  const discordToken = await askMaskedRequired('Discord bot token (input hidden): ');
  SECRET_VALUES.push(discordToken);

  const guildId = await askValidated('Discord server (guild) ID: ', validateChannelId, 'Must be a 17-20 digit Discord snowflake.');

  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${discordAppId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
  log(`\nInvite link (send this to the clan leader, or open it yourself):\n  ${inviteUrl}\n`);
  await waitForEnter('Press Enter once the bot has actually joined the server... ');

  const leaderChannelIdRaw = await ask('Leader channel ID (optional, press Enter to skip): ');
  let leaderChannelId = '';
  if (leaderChannelIdRaw) {
    if (validateChannelId(leaderChannelIdRaw)) leaderChannelId = leaderChannelIdRaw;
    else log('  Not a valid channel ID, skipping.');
  }

  const crApiToken = await askMaskedRequired('Clash Royale API token (input hidden): ');
  SECRET_VALUES.push(crApiToken);

  const clanName = await askValidated('Clan display name: ', v => v.trim().length > 0, 'Cannot be blank.');
  const warInviteUrl = await askValidated('Discord invite URL for this server (e.g. https://discord.gg/xxxx): ', v => /^https:\/\/discord\.(gg|com\/invite)\//.test(v.trim()), 'Must look like a discord.gg or discord.com/invite link.');

  return { clanTag, discordAppId, discordToken, guildId, leaderChannelId, crApiToken, clanName, warInviteUrl };
}

async function finalConfirmation(slug, targetDir, collected, availableMb) {
  log('\n=== READY TO GO LIVE ===');
  log(`Clan slug        : ${slug}`);
  log(`Folder           : ${targetDir}`);
  log(`pm2 process name : ${slug}`);
  if (collected) {
    log(`Clan tag         : ${collected.clanTag}`);
    log(`Discord guild ID : ${collected.guildId}`);
    log(`Discord app ID   : ${collected.discordAppId}`);
    log(`Bot token        : ${fingerprint(collected.discordToken)}`);
    log(`CR API token     : ${fingerprint(collected.crApiToken)}`);
    log(`Clan name        : ${collected.clanName}`);
    log(`Invite URL       : ${collected.warInviteUrl}`);
  } else {
    log('(reusing existing config from a prior run)');
  }
  log(`RAM available    : ${availableMb === null ? 'unknown' : availableMb + 'MB'}`);
  log('setup-check      : PASSED');
  log('deploy-commands  : PASSED');
  log('=========================');
  log('This starts a LIVE, Discord-connected, pm2-supervised process now.');
  const typed = await ask(`Type the clan slug ("${slug}") to confirm and go live, or Ctrl+C to abort: `);
  if (typed.trim() !== slug) fail('Slug did not match — aborted.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  if (err instanceof ProvisionAbort) {
    process.exitCode = process.exitCode || 1;
  } else {
    process.stderr.write(`\n[PROVISION] Unexpected error: ${redact(err?.stack || err?.message || String(err))}\n`);
    process.exitCode = 1;
  }
});
