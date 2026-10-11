import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command } from '../command';
import type { ArchivePanel } from '../../../application/archive/panel';
import { withArchivePublicMessageLock } from '../../../application/archive/public-message';
import { ArchiveInputError } from '../../../core/errors';
import { archiveConfig, requireArchiveAccess } from '../archive-shared/access';
import { archiveFailure } from '../archive-shared/failure';
import { archiveBackupEntry, archiveStatusView } from '../archive-shared/views';
import { archiveCommandConfig } from './config';
import { executeArchiveSchedule } from './schedule';

const SUBCOMMANDS = ['backup', 'status', 'schedule'] as const;
const isArchiveSubcommand = (value: string): value is (typeof SUBCOMMANDS)[number] =>
  (SUBCOMMANDS as readonly string[]).includes(value);

/** Discord control of msg-archive: full backup, status and the periodic schedule. */
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
    try {
      const action = interaction.options.getSubcommand();
      if (!isArchiveSubcommand(action))
        throw new ArchiveInputError('replies:archive.invalid_action');
      const access = await requireArchiveAccess(interaction, bot);
      // Panels are public in the debug channel; access was checked first.
      await interaction.deferReply();
      const show = async (panel: ArchivePanel): Promise<void> => {
        await interaction.editReply({ content: '', ...panel, allowedMentions: { parse: [] } });
      };
      switch (action) {
        case 'backup': {
          const messageId = (await interaction.fetchReply()).id;
          // A backup's panel may move here; the worker's edits wait for this one.
          await withArchivePublicMessageLock(interaction.channelId, messageId, async () =>
            show(
              await archiveBackupEntry(bot, access, {
                userId: interaction.user.id,
                channelId: interaction.channelId,
                messageId,
              }),
            ),
          );
          return;
        }
        case 'status':
          await show(await archiveStatusView(bot, access));
          return;
        case 'schedule':
          await show(await executeArchiveSchedule(interaction, bot, access));
          return;
        default: {
          const unreachable: never = action;
          throw new TypeError(`Unknown archive subcommand ${String(unreachable)}`);
        }
      }
    } catch (error) {
      await archiveFailure(interaction, bot, error);
    }
  }
}
