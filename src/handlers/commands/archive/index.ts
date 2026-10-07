import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import { archiveConfig, ArchiveAccessError, requireArchiveAccess } from './access';
import { archiveCommandConfig } from './config';
import { executeArchiveOperation } from './operations';
import { archiveFailure, publishArchiveReply } from './replies';
import { executeArchiveSchedule } from './schedule';

/** Discord is the worker's sole public operational control surface. */
export default class archive extends Command {
  constructor() {
    super();
    this.setConfig(archiveCommandConfig);
  }
  public override validateBotConfig(botConfig: unknown): void {
    archiveConfig.parse(botConfig);
  }
  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.deferReply();
    try {
      const group = interaction.options.getSubcommandGroup(false);
      if (group !== null && group !== 'schedule')
        throw new ArchiveAccessError('replies:archive.invalid_action');
      if (group === 'schedule') {
        const action = interaction.options.getSubcommand();
        if (!['status', 'enable', 'disable', 'interval'].includes(action))
          throw new ArchiveAccessError('replies:archive.invalid_action');
        const minutes =
          action === 'interval' || action === 'enable'
            ? interaction.options.getInteger('minutes', action === 'interval')
            : null;
        if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080))
          throw new ArchiveAccessError('replies:archive.invalid_interval');
      }
      const access = await requireArchiveAccess(interaction, bot);
      const reply =
        group === 'schedule'
          ? await executeArchiveSchedule(interaction, bot, access)
          : await executeArchiveOperation(interaction, bot, access.control, access);
      if (reply !== undefined) await publishArchiveReply(interaction, reply, bot, access);
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
