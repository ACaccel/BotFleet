import type { StringSelectMenuInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { SSMHandler } from '@select-menu';

import { bindTranslator } from '../../../core/i18n';
import { relayDmToTicket } from '../../../application/bug-report/relay';
import { ticketRepo } from '../../../application/bug-report/tickets';
import { buildBugReportDepsFromBot } from '../../commands/bug_report/deps-from-bot';

/** A reporter with several open tickets picks which one their DM belongs to. */
export default class bug_ticket_pick extends SSMHandler {
  public override async execute(
    interaction: StringSelectMenuInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const t = bindTranslator(bot.translator);
    const deps = buildBugReportDepsFromBot(bot);
    const dmId = interaction.customId.split('|')[1] ?? '';
    const number = Number(interaction.values[0]);
    const dm = await interaction.channel?.messages.fetch(dmId).catch(() => null);
    const found = await (await ticketRepo(deps))?.findByNumber(deps.botId, number);
    if (found !== undefined && !found.ok) throw found.error;
    const ticket = found?.value;
    if (!dm || !ticket || ticket.reporter_id !== interaction.user.id) {
      await interaction.update({
        content: t('replies:bug_report.dm_unknown_ticket'),
        components: [],
      });
      return;
    }
    const outcome = await relayDmToTicket(deps, dm, ticket, t);
    await interaction.update({
      content: t(
        outcome === 'relayed'
          ? 'replies:bug_report.pick_relayed'
          : outcome === 'closed'
            ? 'replies:bug_report.dm_ticket_closed'
            : 'replies:bug_report.dm_relay_failed',
        { number },
      ),
      components: [],
    });
  }
}
