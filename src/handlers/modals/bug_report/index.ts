import { MessageFlags, time, TimestampStyles, type ModalSubmitInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ModalHandler } from '@modal';

import { createTicket } from '../../../application/bug-report/tickets';
import type { BugTicketType } from '../../../persistence/schemas/bug-ticket.schema';
import { replyForError } from '../../../infra/discord/reply-for-error';
import { buildBugReportDepsFromBot } from '../../commands/bug_report/deps-from-bot';

const TYPES: readonly BugTicketType[] = ['bug', 'suggestion', 'other'];

/** Report form submit: open a ticket in the hub and tell the reporter its number. */
export default class bug_report_modal extends ModalHandler {
  public override async execute(interaction: ModalSubmitInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string, params?: Record<string, string | number>): string =>
      bot.translator?.t(`replies:bug_report.${key}`, params) ?? '';
    try {
      const chosen = interaction.fields.getStringSelectValues('type')[0];
      const type = TYPES.find((candidate) => candidate === chosen) ?? 'other';
      const guild = interaction.guild;
      const outcome = await createTicket(buildBugReportDepsFromBot(bot), {
        reporter: interaction.user,
        source:
          guild === null
            ? null
            : { guildId: guild.id, guildName: guild.name, channelId: interaction.channelId ?? '' },
        type,
        title: interaction.fields.getTextInputValue('title').trim(),
        content: interaction.fields.getTextInputValue('content').trim(),
        now: Date.now(),
      });
      const content =
        outcome.status === 'created'
          ? t(outcome.dmDelivered ? 'created' : 'created_no_dm', { number: outcome.number })
          : outcome.status === 'too_many'
            ? t('too_many', { max: outcome.max })
            : outcome.status === 'cooldown'
              ? t('cooldown', {
                  at: time(Math.ceil(outcome.retryAt / 1000), TimestampStyles.RelativeTime),
                })
              : t('unavailable');
      await interaction.editReply({ content });
    } catch (error) {
      await replyForError(
        interaction,
        bot,
        error,
        'replies:bug_report.failed',
        interaction.guildId,
      );
    }
  }
}
