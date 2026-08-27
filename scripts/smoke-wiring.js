import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { loadOpsConfig, loadRecruitConfig } from '../src/config/loadConfig.js';
import { recruitCommands, handleRecruitInteraction } from '../src/recruit/index.js';
import { handleWizardInteraction } from '../src/recruit/wizard.js';
import { runRecruitSetupCore } from '../src/recruit/commands/setup.js';

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
  for (const required of ['status', 'recruit-setup', 'recruit-eval-now', 'standings']) {
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

await runCheck('setup.js exports the wizard-reusable core function', () => {
  assert(typeof runRecruitSetupCore === 'function', 'runRecruitSetupCore not exported');
});

await runCheck('Wizard handler ignores non-wizard customIds', async () => {
  const fakeInteraction = { customId: 'not-a-wizard-id', isButton: () => true };
  const handled = await handleWizardInteraction(fakeInteraction, {});
  assert(handled === false, 'expected false for a non-wizard: customId');
});

await runCheck('Main index dispatches wizard: interactions before the ops/war gate', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const wizardIdx = source.indexOf("wizardCustomId.startsWith('wizard:')");
  const opsWarGateIdx = source.indexOf('interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()');
  assert(wizardIdx !== -1, 'wizard: dispatch branch missing');
  assert(opsWarGateIdx !== -1, 'ops/war component gate missing');
  assert(wizardIdx < opsWarGateIdx, 'wizard: dispatch must come before the ops/war gate, or a wizard button falls into it and misfires the "kraken role required" reply on a DM interaction');
});

await runCheck('Wizard no longer offers a chat-channel adoption dropdown', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/recruit/wizard.js'), 'utf8');
  assert(!source.includes('wizard:pick:chatChannel'), 'chat-channel pick customId should have been removed');
  assert(!source.includes('PENDING_KEYS.chatChannel'), 'chat-channel staging key should have been removed');
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
