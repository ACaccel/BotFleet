import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { ButtonHandler } from '@button';

import { setTicketClosed, ticketRepo } from '../../../application/bug-report/tickets';
import { buildBugReportDepsFromBot } from '../../commands/bug_report/deps-from-bot';

/** Close and Reopen on a ticket's hub post; bot admins only, checked on every click. */
export default class bug_ticket extends ButtonHandler {
  public override async execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const t = (key: string): string => bot.translator?.t(`replies:bug_report.${key}`) ?? '';
    if (!bot.isAdmin(interaction.user.id)) {
      await interaction.editReply({ content: t('admin_only') });
      return;
    }
    const thread = interaction.channel;
    const deps = buildBugReportDepsFromBot(bot);
    const found = thread?.isThread()
      ? await (await ticketRepo(deps))?.findByThread(thread.id)
      : undefined;
    if (found !== undefined && !found.ok) throw found.error;
    const ticket = found?.value;
    if (!thread?.isThread() || !ticket || ticket.bot_id !== deps.botId) {
      await interaction.editReply({ content: t('ticket_not_found') });
      return;
    }
    const close = interaction.customId.split('|')[1] === 'close';
    const changed = await setTicketClosed(
      deps,
      thread,
      ticket,
      close,
      interaction.user.id,
      Date.now(),
    );
    await interaction.editReply({
      content: t(changed ? (close ? 'ticket_closed' : 'ticket_reopened') : 'ticket_unchanged'),
    });
  }
}
