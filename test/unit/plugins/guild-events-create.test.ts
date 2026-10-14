/**
 * The guild-events plugin's `guildCreate` subscription wiring.
 *
 * `guild-events.test.ts` covers `handleGuildCreate` directly; this file
 * covers the step in between — that the subscription an inited plugin
 * exposes actually reaches that handler.
 *
 * Drives the plugin's real `events.guildCreate` handler with a live
 * IoC container holding a fake {@link GuildOnboardingPort}, and asserts
 * that joining a new guild routes through the port — not through
 * `BaseBot` internals. A failing port must be swallowed (logged, not
 * rethrown) so the dispatcher's per-subscription isolation is not the
 * only safety net.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGuildEventsPlugin } from '../../../src/plugins/guild-events';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';
import type { GuildOnboardingPort, GuildOnboardingResult } from '../../../src/core/plugin';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createPermissionRankPolicy } from '../../../src/core/plugin';

const silent = silentLogger();

const emptyRegistry: GuildRegistry = {
  getRepos: () => undefined,
  getChannel: () => undefined,
  getRole: () => undefined,
  listGuildIds: () => [],
};

const buildEventContext = (port: GuildOnboardingPort): ReturnType<typeof buildPluginContext> => {
  const container = createContainer();
  container.registerSingleton(TOKENS.Logger, () => silent);
  container.registerSingleton(TOKENS.GuildOnboardingPort, () => port);
  container.registerSingleton(TOKENS.GuildRegistry, () => emptyRegistry);
  container.registerSingleton(TOKENS.PermissionRankPolicy, () => createPermissionRankPolicy({}));
  return buildPluginContext({ logger: silent, resolve: container.resolve.bind(container) });
};

/**
 * The host resolves a plugin's dependencies in `init` and only then
 * attaches its event subscriptions, so a hand-driven dispatch runs the
 * same two steps in the same order.
 */
const initedPlugin = async (
  port: GuildOnboardingPort,
): Promise<{
  plugin: ReturnType<typeof createGuildEventsPlugin>;
  ctx: ReturnType<typeof buildPluginContext>;
}> => {
  const plugin = createGuildEventsPlugin();
  const ctx = buildEventContext(port);
  await plugin.init?.(ctx);
  return { plugin, ctx };
};

const fakeGuild = (id: string) => buildGuild({ id, name: `guild-${id}` });

describe('guild-events plugin guildCreate subscription', () => {
  it('onboards a newly joined guild through GuildOnboardingPort', async () => {
    const result: GuildOnboardingResult = {
      guildId: 'g-100',
      databaseConnected: true,
      commandsRegistered: true,
    };
    const onboardGuild = vi.fn(async () => result);
    const port: GuildOnboardingPort = { onboardGuild };

    const { plugin, ctx } = await initedPlugin(port);

    await plugin.events?.guildCreate?.(ctx, fakeGuild('g-100'));

    expect(onboardGuild).toHaveBeenCalledTimes(1);
    expect(onboardGuild).toHaveBeenCalledWith('g-100');
  });

  it('swallows a failing onboarding so the subscription never rejects', async () => {
    const onboardGuild = vi.fn(async () => {
      throw new Error('mongo unreachable');
    });
    const port: GuildOnboardingPort = { onboardGuild };

    const { plugin, ctx } = await initedPlugin(port);

    // The contract this regression test protects: a port failure is
    // logged, not rethrown — onboarding is a structural side effect.
    await expect(plugin.events?.guildCreate?.(ctx, fakeGuild('g-200'))).resolves.toBeUndefined();
    expect(onboardGuild).toHaveBeenCalledTimes(1);
  });
});
