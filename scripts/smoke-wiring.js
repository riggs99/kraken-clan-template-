import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { loadOpsConfig, loadRecruitConfig } from '../src/config/loadConfig.js';
import { recruitCommands, handleRecruitInteraction } from '../src/recruit/index.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const deployPath = path.resolve(__dirname, 'deploy-commands.js');
const indexPath = path.resolve(__dirname, '../src/index.js');

const checks = [];

async function runCheck(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await runCheck('OPS config has guild scope id', () => {
  const ops = loadOpsConfig();
  assert(String(ops?.opsGuildId ?? '').trim().length > 0, 'opsGuildId missing');
});

await runCheck('Recruit config has guild scope id', () => {
  const recruit = loadRecruitConfig();
  assert(String(recruit?.recruitGuildId ?? '').trim().length > 0, 'recruitGuildId missing');
});

await runCheck('Recruit command set is unique', () => {
  const names = recruitCommands.map(command => command?.name).filter(Boolean);
  const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx);
  assert(duplicates.length === 0, `duplicate recruit commands: ${duplicates.join(', ')}`);
});

await runCheck('Recruit command set contains expected entries', () => {
  const names = new Set(recruitCommands.map(command => command?.name));
  for (const required of ['status', 'recruit-setup', 'recruit-eval-now', 'war-board']) {
    assert(names.has(required), `missing command: ${required}`);
  }
});

await runCheck('Deploy script is guild-scoped only', () => {
  const source = fs.readFileSync(deployPath, 'utf8');
  assert(source.includes('Routes.applicationGuildCommands'), 'guild-scoped route missing');
  assert(!source.includes('Routes.applicationCommands('), 'global route detected');
});

await runCheck('Deploy script includes OPS in recruit guild payload', () => {
  const source = fs.readFileSync(deployPath, 'utf8');
  assert(source.includes('{ body: [...opsCommands, ...recruitCommands] }'), 'recruit deploy payload missing ops commands');
});

await runCheck('Recruit handler hard-stops outside recruit guild', async () => {
  const fakeInteraction = { guildId: 'guild-a' };
  const handled = await handleRecruitInteraction(fakeInteraction, { recruitGuildId: 'guild-b' });
  assert(handled === false, 'expected false for non-recruit guild interaction');
});

await runCheck('Main index routes recruit before OPS fallback', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  assert(source.includes('if (recruitConfig?.enabled && interaction.guildId === String(recruitConfig.recruitGuildId))'), 'recruit guild guard missing');
  assert(source.includes('const handled = await handleRecruitInteraction(interaction, recruitConfig);'), 'recruit handler call missing');
  assert(source.includes('if (handled) return;'), 'recruit short-circuit missing');
});

const failed = checks.filter(check => !check.ok);
for (const check of checks) {
  if (check.ok) {
    console.log(`[PASS] ${check.name}`);
  } else {
    console.log(`[FAIL] ${check.name}: ${check.error}`);
  }
}

if (failed.length > 0) {
  console.log(`\nSmoke wiring result: ${failed.length} failed / ${checks.length} total`);
  process.exitCode = 1;
} else {
  console.log(`\nSmoke wiring result: all ${checks.length} checks passed`);
}
