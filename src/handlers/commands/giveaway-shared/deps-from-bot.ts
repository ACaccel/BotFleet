/**
 * `BaseBot` -> {@link GiveawayDeps} bridge for the interaction path. The
 * plugin builds the same bundle from its context; keeping the bridge in
 * its own file keeps the `BaseBot` dependency out of the shared service.
 */
import type { BaseBot } from '@bot';

import type { GiveawayDeps } from '../../../application/giveaway/giveaway';

export const buildGiveawayDepsFromBot = (bot: BaseBot): GiveawayDeps => ({
  client: bot.client,
  registry: bot.guildRegistry,
  jobMap: bot.jobMap,
  logger: bot.requireLogger(),
  translator: bot.translator,
});
