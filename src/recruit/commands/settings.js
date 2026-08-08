import { MessageFlags } from 'discord.js';
import { getExpectedDecksPerDay, setExpectedDecksPerDay } from '../db.js';
import { isServerOwner } from '../../permissions.js';
import { buildDashboardContainer, CLAN_BADGE_URL, STATUS_COLORS } from '../../dashboard-components.js';

export const command = {
  name: 'recruit-settings',
  description: 'View or update KRAKEN recruit policy settings (server owner only)',
  options: [
    {
      type: 1, // SUB_COMMAND
      name: 'view',
      description: 'Show current recruit policy settings',
    },
    {
      type: 1, // SUB_COMMAND
      name: 'set-decks-per-day',
      description: 'Set the expected war decks per day (default: 4)',
      options: [
        {
          type: 4, // INTEGER
          name: 'value',
          description: 'Expected decks per day (1–10)',
          required: true,
          min_value: 1,
          max_value: 10,
        },
      ],
    },
  ],
};

export async function handleSettings(interaction, { db }) {
  if (!(await isServerOwner(interaction))) {
    return interaction.reply({ content: 'Only the server owner can run this.', flags: MessageFlags.Ephemeral });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    const decksPerDay = getExpectedDecksPerDay(db);
    const container = buildDashboardContainer({
      accentColor: STATUS_COLORS.neutral,
      thumbnailUrl: CLAN_BADGE_URL,
      header: '## 🐙 KRAKEN Recruit Settings',
      blocks: [
        `**Expected decks per war day:** ${decksPerDay}\n\nUse \`/recruit-settings set-decks-per-day\` to change. Takes effect on the next eval.`,
      ],
    });
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'set-decks-per-day') {
    const value = interaction.options.getInteger('value');
    try {
      setExpectedDecksPerDay(db, value);
    } catch (e) {
      return interaction.reply({ content: `Invalid value: ${String(e?.message ?? e)}`, flags: MessageFlags.Ephemeral });
    }
    const container = buildDashboardContainer({
      accentColor: STATUS_COLORS.healthy,
      thumbnailUrl: CLAN_BADGE_URL,
      header: '## 🐙 KRAKEN Settings Updated',
      blocks: [
        `Expected decks per war day set to **${value}**.\n\nTakes effect on the next evaluator run and standings refresh.`,
      ],
    });
    return interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
      allowedMentions: { parse: [] },
    });
  }

  return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
}
