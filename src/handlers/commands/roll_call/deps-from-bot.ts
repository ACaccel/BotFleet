import type { BaseBot } from '@bot';

import type { RollCallDeps } from '../../../application/roll-call/roll-call';

/** `BaseBot` -> {@link RollCallDeps} bridge for the interaction path. */
export const buildRollCallDepsFromBot = (bot: BaseBot): RollCallDeps => ({
  client: bot.client,
  registry: bot.guildRegistry,
  jobMap: bot.jobMap,
  logger: bot.requireLogger(),
  translator: bot.translator,
});
