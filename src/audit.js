export function audit(interaction, action) {
  const who = interaction.user?.tag || 'unknown';
  const where = interaction.guildId + ':' + interaction.channelId;
  const when = new Date().toISOString();
  console.log('[AUDIT]', when, who, action, where);
}
