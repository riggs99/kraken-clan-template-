import { initDb } from './db.js';
import { formatErrorForLog } from '../security.js';
import { applyCore } from './commands/apply.js';
import { handleStatus, handleStatusAutocomplete, command as statusCommand } from './commands/status.js';
import { handleHelp, command as helpCommand } from './commands/help.js';
import { handleSetup, command as setupCommand } from './commands/setup.js';
import { handleEvalNow, command as evalNowCommand } from './commands/eval-now.js';
import { handleSeasonReport, command as seasonReportCommand } from './commands/season-report.js';
import { handleSeasonReset, handleSeasonResetConfirm, handleSeasonResetCancel, command as seasonResetCommand } from './commands/season-reset.js';
import { handleWarBoard, parseWarBoardAction, command as warBoardCommand } from './commands/war-board.js';
import { handleDecisionsReset, handleDecisionsResetConfirm, handleDecisionsResetCancel, command as decisionsResetCommand } from './commands/decisions-reset.js';
import { handleBreakReset, handleBreakResetConfirm, handleBreakResetCancel, command as breakResetCommand } from './commands/break-reset.js';
import { handleAppeal, handleAppealsInteraction, command as appealCommand } from './commands/appeal.js';
import { handleSettings, command as settingsCommand } from './commands/settings.js';
import { handleHistory, command as historyCommand } from './commands/history.js';
import { handleAddMember, command as addMemberCommand } from './commands/add-member.js';
import { handleRemoveMember, handleRemoveMemberConfirm, handleRemoveMemberCancel, command as removeMemberCommand } from './commands/remove-member.js';
import { handleBanMember, handleBanMemberConfirm, handleBanMemberCancel, command as banMemberCommand } from './commands/ban-member.js';
import { getRecruitRuntimeIds } from './db.js';
import { normalizePlayerTag } from '../util.js';
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { handleBreakInteraction } from './breaks.js';
import { handleWaitlistConfirm } from './waitlist.js';

let dbSingleton = null;

function getDb() {
  if (dbSingleton) return dbSingleton;
  dbSingleton = initDb();
  return dbSingleton;
}

export function getRecruitDb() {
  return getDb();
}

// Single source of truth for every recruit-guild chat-input command: pairing a
// command's slash-command definition with its handler here means adding a new
// command only ever needs one entry, not two lists kept in sync by hand — the
// deploy list and the dispatch chain used to be separate, and drift is exactly
// what happens when a new command (e.g. /recruit-help) needs both touched.
// Every handler gets the same (interaction, ctx) signature; ctx carries
// whatever superset of {recruitConfig, db, runtime, client} a given handler
// needs, and unused fields are simply ignored via destructuring.
const chatInputCommands = [
  { command: statusCommand, handle: handleStatus },
  { command: helpCommand, handle: handleHelp },
  { command: setupCommand, handle: handleSetup },
  { command: evalNowCommand, handle: handleEvalNow },
  { command: seasonReportCommand, handle: handleSeasonReport },
  { command: seasonResetCommand, handle: handleSeasonReset },
  { command: warBoardCommand, handle: handleWarBoard },
  { command: decisionsResetCommand, handle: handleDecisionsReset },
  { command: breakResetCommand, handle: handleBreakReset },
  { command: appealCommand, handle: handleAppeal },
  { command: settingsCommand, handle: handleSettings },
  { command: historyCommand, handle: handleHistory },
  { command: addMemberCommand, handle: handleAddMember },
  { command: removeMemberCommand, handle: handleRemoveMember },
  { command: banMemberCommand, handle: handleBanMember },
];

export const recruitCommands = chatInputCommands.map(c => c.command);
const chatInputHandlerByName = new Map(chatInputCommands.map(c => [c.command.name, c.handle]));

export async function handleRecruitInteraction(interaction, recruitConfig) {
  const recruitGuildId = String(recruitConfig?.recruitGuildId ?? '');
  if (interaction.guildId !== recruitGuildId) return false;

  const db = getDb();
  const runtime = getRecruitRuntimeIds(db);
  const ctx = { recruitConfig, db, runtime, client: interaction.client };

  try {
    if (interaction.isButton() || interaction.isModalSubmit()) {
      const handledBreak = await handleBreakInteraction(interaction, ctx);
      if (handledBreak) return true;
      const handledAppeal = await handleAppealsInteraction(interaction, ctx);
      if (handledAppeal) return true;
      if (interaction.isButton() && interaction.customId === 'recruit:waitlist:confirm') {
        await handleWaitlistConfirm(interaction, db);
        return true;
      }
      if (interaction.isButton() && interaction.customId.startsWith('warboard:')) {
        const parsed = parseWarBoardAction(interaction.customId);
        if (parsed) {
          await handleWarBoard(interaction, ctx, parsed);
          return true;
        }
      }
      if (interaction.isButton() && interaction.customId === 'recruit:decisionsResetConfirm') {
        await handleDecisionsResetConfirm(interaction, ctx);
        return true;
      }
      if (interaction.isButton() && interaction.customId === 'recruit:decisionsResetCancel') {
        await handleDecisionsResetCancel(interaction);
        return true;
      }
      if (interaction.isButton() && interaction.customId === 'recruit:seasonResetConfirm') {
        await handleSeasonResetConfirm(interaction, ctx);
        return true;
      }
      if (interaction.isButton() && interaction.customId === 'recruit:seasonResetCancel') {
        await handleSeasonResetCancel(interaction);
        return true;
      }
      if (interaction.isButton() && interaction.customId === 'recruit:breakResetConfirm') {
        await handleBreakResetConfirm(interaction, ctx);
        return true;
      }
      if (interaction.isButton() && interaction.customId === 'recruit:breakResetCancel') {
        await handleBreakResetCancel(interaction);
        return true;
      }
      if (interaction.isButton() && interaction.customId.startsWith('recruit:removeConfirm:')) {
        await handleRemoveMemberConfirm(interaction, ctx, interaction.customId.slice('recruit:removeConfirm:'.length));
        return true;
      }
      if (interaction.isButton() && interaction.customId.startsWith('recruit:removeCancel:')) {
        await handleRemoveMemberCancel(interaction);
        return true;
      }
      if (interaction.isButton() && interaction.customId.startsWith('recruit:banConfirm:')) {
        await handleBanMemberConfirm(interaction, ctx, interaction.customId.slice('recruit:banConfirm:'.length));
        return true;
      }
      if (interaction.isButton() && interaction.customId.startsWith('recruit:banCancel:')) {
        await handleBanMemberCancel(interaction);
        return true;
      }
    }

    if (interaction.isButton() && (interaction.customId === 'recruit:begin' || interaction.customId === 'recruit:agree')) {
      const welcomeChannelId = String(runtime?.channels?.welcomeChannelId ?? '');
      if (welcomeChannelId && interaction.channelId !== welcomeChannelId) {
        return interaction.reply({ content: 'Use the welcome panel in #welcome.', flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder()
        .setCustomId('recruit:applyModal')
        .setTitle('Agree & Join');

      const tagInput = new TextInputBuilder()
        .setCustomId('tag')
        .setLabel('Player tag (with or without #)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20)
        .setPlaceholder('#ABC2YGV');

      modal.addComponents(new ActionRowBuilder().addComponents(tagInput));

      await interaction.showModal(modal);
      return true;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'recruit:applyModal') {
      const tag = interaction.fields.getTextInputValue('tag');

      const clean = normalizePlayerTag(tag);
      if (!clean) {
        await interaction.reply({ content: 'Invalid tag.', flags: MessageFlags.Ephemeral });
        return true;
      }

      await applyCore(interaction, ctx, { tag });
      return true;
    }

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'status') {
        await handleStatusAutocomplete(interaction, ctx);
        return true;
      }
      return false;
    }

    if (!interaction.isChatInputCommand()) return false;

    const handler = chatInputHandlerByName.get(interaction.commandName);
    if (handler) {
      await handler(interaction, ctx);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[RECRUIT] handler error:', formatErrorForLog(e));
    try {
      // A handler that already deferred (e.g. /recruit-setup) needs editReply, not reply —
      // calling reply() on an already-deferred interaction throws, which used to mean this
      // whole catch silently did nothing and left the user staring at "thinking..." until
      // the interaction token expired, with zero indication anything failed.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'KRAKEN encountered an error. Try again later.' });
      } else {
        await interaction.reply({ content: 'KRAKEN encountered an error. Try again later.', flags: MessageFlags.Ephemeral });
      }
    } catch {
      // ignore
    }
    return true;
  }
}
