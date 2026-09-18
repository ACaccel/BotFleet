/**
 * TempRolePlugin — rebuilds jobs on startup and guild database recovery.
 *
 * The plugin resolves its dependencies through `ctx` and calls
 * `rebootTempRoleJobs` directly, so composition roots never deep-import
 * `./internal`. The `/temp_role` command handler bridges into the same
 * internals via its own `BaseBot` reference.
 */
import { TOKENS } from '../../bot/tokens';
import type { Plugin, PluginRuntimeContext } from '../../core/plugin';
import { type TempRoleDeps, rebootTempRoleJobs } from './internal/temp-role';

const PLUGIN_ID = 'temp-role';
const PLUGIN_VERSION = '1.0.0';

const rebuildJobs = async (ctx: PluginRuntimeContext, guildId?: string): Promise<void> => {
  try {
    const client = ctx.resolve(TOKENS.DiscordClient);
    const deps: TempRoleDeps = {
      client,
      registry: ctx.resolve(TOKENS.GuildRegistry),
      jobMap: ctx.resolve(TOKENS.JobMap),
      logger: ctx.logger,
      translator: ctx.translator,
      clock: ctx.clock,
    };
    await rebootTempRoleJobs(deps, guildId);
  } catch (err: unknown) {
    ctx.logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'temp-role: rebootJobs failed; expiry jobs may be missing',
    );
  }
};

export const createTempRolePlugin = (): Plugin => ({
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  onReady: (ctx) => rebuildJobs(ctx),
  onGuildDatabaseReady: (ctx, guildId) => rebuildJobs(ctx, guildId),
});
