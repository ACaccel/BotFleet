/**
 * ActivityPlugin — rebuilds activity and roll-call jobs on startup and
 * guild database recovery.
 *
 * The plugin resolves its dependencies through `ctx` and calls the
 * application services the command and button handlers share, since
 * handlers and plugins may not import each other. Roll calls are rebuilt
 * here too because closing one records attendance on its activity.
 */
import { TOKENS } from '../../bot/tokens';
import type { Plugin, PluginRuntimeContext } from '../../core/plugin';
import { rebootActivityJobs } from '../../application/activity/activity';
import { rebootRollCalls, type RollCallDeps } from '../../application/roll-call/roll-call';

const PLUGIN_ID = 'activity';
const PLUGIN_VERSION = '1.0.0';

const rebuildJobs = async (ctx: PluginRuntimeContext, guildId?: string): Promise<void> => {
  try {
    const client = ctx.resolve(TOKENS.DiscordClient);
    const deps: RollCallDeps = {
      client,
      registry: ctx.resolve(TOKENS.GuildRegistry),
      jobMap: ctx.resolve(TOKENS.JobMap),
      logger: ctx.logger,
      translator: ctx.translator,
    };
    await rebootActivityJobs(deps, guildId);
    await rebootRollCalls(deps, guildId);
  } catch (err: unknown) {
    ctx.logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'activity: rebootJobs failed; scheduled jobs may be missing',
    );
  }
};

export const createActivityPlugin = (): Plugin => ({
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  onReady: (ctx) => rebuildJobs(ctx),
  onGuildDatabaseReady: (ctx, guildId) => rebuildJobs(ctx, guildId),
});
