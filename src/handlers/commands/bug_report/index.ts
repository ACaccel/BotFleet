import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '@cmd';

import { parseBugReportConfig } from '../../../application/bug-report/config';
import { buildBugReportModal } from './build-modal';

/** `/bug_report`: open the report form; the ticket is created on submit. */
export default class bug_report extends Command {
  constructor() {
    super();
    this.setConfig({ name: 'bug_report', category: 'utility' });
  }

  /** Reports need a hub forum to land in. */
  public override validateBotConfig(config: unknown): void {
    parseBugReportConfig(config);
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    await interaction.showModal(buildBugReportModal(bot.translator));
  }
}
