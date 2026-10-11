/**
 * `BaseBot` -> {@link TempRoleDeps} bridge for the interaction path. The
 * plugin builds the same bundle from its context; keeping the bridge in
 * its own file keeps the `BaseBot` dependency out of the shared service.
 */
import type { BaseBot } from '@bot';
import { systemClock } from '../../../core/time';

import type { TempRoleDeps } from '../../../application/temp-role/temp-role';

export const buildTempRoleDepsFromBot = (bot: BaseBot): TempRoleDeps => ({
  client: bot.client,
  registry: bot.guildRegistry,
  jobMap: bot.jobMap,
  logger: bot.requireLogger(),
  translator: bot.translator,
  // Command-path deps run on the system wall clock; the plugin's reboot
  // path uses the injected `ctx.clock`, which is the same systemClock in
  // production and a fake clock under test.
  clock: systemClock,
});
