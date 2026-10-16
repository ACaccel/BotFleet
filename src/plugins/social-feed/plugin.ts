/**
 * SocialFeedPlugin — forwards new posts from the accounts each guild
 * has subscribed to into the channels those subscriptions name.
 *
 * Lifecycle wiring only; the pass itself lives in `internal/poll.ts`.
 * `onReady` runs one pass immediately (so a restart surfaces anything
 * missed while the bot was down) and then drives a self-rescheduling
 * `setTimeout` loop, mirroring `message-backup`. Every pass is wrapped
 * so a throw is logged and the loop always reschedules itself.
 *
 * Config is parsed once at composition time — a malformed block fails the
 * boot, not the first pass — and the loop's mutable state is captured in
 * the factory closure (mirrors `createSocialLinkPreviewPlugin`).
 *
 * Subscriptions live in each guild's database rather than in config, so
 * there is no startup reconciliation: deleting a subscription deletes
 * its cursor with it, and nothing can be orphaned.
 */
import { logError, logSystem } from '../../core/logger';
import type { Plugin } from '../../core/plugin';
import { TOKENS } from '../../bot/tokens';
import type { FeedPlatformRegistry } from '../../infra/social-feed';
import { parseSocialFeedConfig } from './config';
import { runFeedPass, type FeedPassDeps } from './internal';

const PLUGIN_ID = 'social-feed';
const PLUGIN_VERSION = '1.0.0';

/** Optional collaborators wired by the composition root / tests. */
interface CreateSocialFeedDeps {
  /**
   * Platform registry. The composition root injects the same instance
   * it registers under `TOKENS.FeedPlatformRegistry`, so the poller and
   * the `/feed_*` commands share one set of platforms; when omitted it
   * is resolved from the container in `onReady`, which keeps the plugin
   * usable by a composition root that only binds the token.
   */
  readonly platforms?: FeedPlatformRegistry;
}

export const createSocialFeedPlugin = (
  rawConfig: unknown,
  deps: CreateSocialFeedDeps = {},
): Plugin => {
  const config = parseSocialFeedConfig(rawConfig);

  let loopHandle: NodeJS.Timeout | undefined;
  let stopped = false;
  // Counts completed passes so every `fullSweepEveryPolls`-th one re-reads
  // the full timeline; the first pass is a sweep because the counter
  // starts at zero.
  let passCount = 0;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async onReady(ctx): Promise<void> {
      if (!config.enabled) {
        logSystem(ctx.logger, 'social-feed disabled; not polling');
        return;
      }
      const passDeps: FeedPassDeps = {
        platforms: deps.platforms ?? ctx.resolve(TOKENS.FeedPlatformRegistry),
        registry: ctx.resolve(TOKENS.GuildRegistry),
        client: ctx.resolve(TOKENS.DiscordClient),
        translator: ctx.translator,
        logger: ctx.logger,
        clock: ctx.clock,
        config,
      };

      const runOnce = async (): Promise<void> => {
        const fullSweep = passCount % config.fullSweepEveryPolls === 0;
        passCount += 1;
        await runFeedPass(passDeps, fullSweep);
      };

      const scheduleNext = (): void => {
        if (stopped) return;
        loopHandle = setTimeout(() => {
          // Run the pass in a self-contained async IIFE: a throw must be
          // caught here and the loop always rescheduled in `finally`.
          // Without this, a rejected pass would die as an
          // unhandledRejection and silently kill the loop.
          void (async (): Promise<void> => {
            try {
              await runOnce();
            } catch (err: unknown) {
              logError(ctx.logger, null, err);
            } finally {
              scheduleNext();
            }
          })();
        }, config.pollIntervalMs);
      };

      try {
        await runOnce();
      } catch (err: unknown) {
        logError(ctx.logger, null, err);
      }
      scheduleNext();
    },

    async onShutdown(): Promise<void> {
      stopped = true;
      if (loopHandle !== undefined) {
        clearTimeout(loopHandle);
        loopHandle = undefined;
      }
    },
  };
};
