/**
 * `BaseBot` -> {@link ActivityDeps} bridge for the interaction path. The
 * plugin builds the same bundle from its context; keeping the bridge in
 * its own file keeps the `BaseBot` dependency out of the shared service.
 */
import type { BaseBot } from '@bot';

import type { ActivityDeps } from '../../../application/activity/activity';

export const buildActivityDepsFromBot = (bot: BaseBot): ActivityDeps => ({
  client: bot.client,
  registry: bot.guildRegistry,
  jobMap: bot.jobMap,
  logger: bot.requireLogger(),
  translator: bot.translator,
});
