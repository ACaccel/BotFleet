/**
 * GiveawayPlugin — rebuilds jobs on startup and guild database recovery.
 *
 * The plugin resolves its dependencies through `ctx` and calls
 * `rebootGiveawayJobs` directly, so composition roots never deep-import
 * `./internal`.
 */
import { TOKENS } from '../../bot/tokens';
import type { Plugin, PluginRuntimeContext } from '../../core/plugin';
import { type GiveawayDeps, rebootGiveawayJobs } from './internal/giveaway';

const PLUGIN_ID = 'giveaway';
const PLUGIN_VERSION = '1.0.0';

const rebuildJobs = async (ctx: PluginRuntimeContext, guildId?: string): Promise<void> => {
  try {
    const client = ctx.resolve(TOKENS.DiscordClient);
    const deps: GiveawayDeps = {
      client,
      registry: ctx.resolve(TOKENS.GuildRegistry),
      jobMap: ctx.resolve(TOKENS.JobMap),
      logger: ctx.logger,
      translator: ctx.translator,
    };
    await rebootGiveawayJobs(deps, guildId);
  } catch (err: unknown) {
    ctx.logger.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      'giveaway: rebootJobs failed; scheduled jobs may be missing',
    );
  }
};

export const createGiveawayPlugin = (): Plugin => ({
  id: PLUGIN_ID,
  version: PLUGIN_VERSION,
  onReady: (ctx) => rebuildJobs(ctx),
  onGuildDatabaseReady: (ctx, guildId) => rebuildJobs(ctx, guildId),
});
