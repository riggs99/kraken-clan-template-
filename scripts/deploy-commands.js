import { REST, Routes } from 'discord.js';
import { loadEnv } from '../src/env.js';
import { formatErrorForLog } from '../src/security.js';
import { loadOpsConfig, loadRecruitConfig } from '../src/config/loadConfig.js';
import { recruitCommands } from '../src/recruit/index.js';

loadEnv();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Keep the public command surface minimal.
const opsCommands = [
  { name: 'ops', description: 'Main Kraken command center (discipline, donations, rewards, actions)' },
  { name: 'war', description: 'War performance, live leaders, and tier decisions — the standalone war hub' },
];

(async () => {
  try {
    const opsConfig = loadOpsConfig();
    console.log('Deploying slash commands (guild-scoped only)...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, String(opsConfig.opsGuildId)),
      { body: opsCommands }
    );
    console.log(`OPS commands deployed (guild=${opsConfig.opsGuildId})`);

    try {
      const recruitConfig = loadRecruitConfig();
      if (recruitConfig.enabled) {
        await rest.put(
          Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, String(recruitConfig.recruitGuildId)),
          { body: [...opsCommands, ...recruitCommands] }
        );
        console.log(`RECRUIT commands deployed (guild=${recruitConfig.recruitGuildId}, includes /ops)`);
      } else {
        console.log('RECRUIT commands skipped (enabled=false)');
      }
    } catch (e) {
      console.error('[DEPLOY] Recruit config invalid; skipping RECRUIT deploy:', formatErrorForLog(e));
    }
  } catch (e) {
    console.error('[DEPLOY] Failed to deploy commands:', formatErrorForLog(e));
    process.exitCode = 1;
  }
})();
