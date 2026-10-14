import type { BaseBot } from '@bot';

import { parseBugReportConfig } from '../../../application/bug-report/config';
import { hubTicketStore, type BugReportDeps } from '../../../application/bug-report/tickets';

/** `BaseBot` -> {@link BugReportDeps} bridge for the interaction path. */
export const buildBugReportDepsFromBot = (bot: BaseBot): BugReportDeps => {
  const config = parseBugReportConfig(bot.config);
  return {
    client: bot.client,
    tickets: hubTicketStore(bot.connectionManager, config.hub.guildId),
    botId: bot.clientId,
    botLabel: bot.personaName || (bot.client.user?.username ?? bot.clientId),
    config,
    translator: bot.translator,
    logger: bot.requireLogger(),
    isAdmin: (userId) => bot.isAdmin(userId),
  };
};
