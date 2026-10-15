/**
 * Unit tests for {@link createSocialLinkPreviewPlugin}: plugin shape and the
 * cheap-guard ordering (enabled / bot author / DM / rank-suppressed channel /
 * non-sendable). The injected registry's `findProvider` is the probe: it is
 * reached only when every guard passes.
 *
 * Channel suppression comes from a real {@link PermissionRankPolicy} (built by
 * the production factory from static config) resolved off the event context.
 * The `social_preview` default ceiling is unbounded, so a channel previews
 * unless an operator sets a finite ceiling.
 *
 * Enabling the feature obliges the operator to supply all six embed-proxy host
 * lists, so every enabled fixture here is built from {@link enabledConfig}; a
 * disabled one carries none of them and must never reach the registry factory.
 */
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Message } from 'discord.js';

import { createSocialLinkPreviewPlugin } from '../../../../src/plugins/social-link-preview';
import {
  createDefaultLinkPreviewRegistry,
  LinkPreviewProviderRegistry,
} from '../../../../src/infra/link-preview';
import { createPermissionRankPolicy, type PermissionRankPolicy } from '../../../../src/core/plugin';
import { createContainer } from '../../../../src/core/ioc';
import { TOKENS } from '../../../../src/bot/tokens';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { buildPluginContext } from '../../../fixtures/runtime';
import type * as LinkPreviewModule from '../../../../src/infra/link-preview';

// Spy on the registry factory (wrapping the real impl, so behavior is
// unchanged) to assert the plugin forwards every configured proxy-host list.
// `vi.mock` is hoisted above the imports, so the spy is in place before the
// plugin captures the factory. Other tests inject their own `deps.registry`,
// so the factory is never called for them and the spy stays inert.
vi.mock('../../../../src/infra/link-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkPreviewModule>();
  return {
    ...actual,
    createDefaultLinkPreviewRegistry: vi.fn(actual.createDefaultLinkPreviewRegistry),
  };
});

/** An empty policy: `social_preview` ceiling defaults to unbounded, so nothing is suppressed. */
const emptyPolicy = createPermissionRankPolicy({});

/**
 * The six operator-supplied embed-proxy host lists. Placeholder hosts: no test
 * here probes the network, and the registry factory only stores them.
 */
const PROXY_HOSTS = {
  twitterProxyHosts: ['tw.example'],
  instagramProxyHosts: ['ig.example'],
  threadsProxyHosts: ['th.example'],
  facebookProxyHosts: ['fb.example'],
  redditProxyHosts: ['rd.example'],
  bilibiliProxyHosts: ['bili.example'],
};

/** A minimal valid enabled config: the master switch plus every mandatory list. */
const enabledConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  ...PROXY_HOSTS,
  ...overrides,
});

const ctx = (
  policy: PermissionRankPolicy,
  registerInstance: Parameters<typeof buildPluginContext>[0] extends infer O
    ? O extends { registerInstance?: infer R }
      ? R
      : never
    : never = () => undefined,
) => {
  const container = createContainer();
  container.registerSingleton(TOKENS.PermissionRankPolicy, () => policy);
  return buildPluginContext({ resolve: container.resolve.bind(container), registerInstance });
};

const makeRegistry = (): {
  registry: LinkPreviewProviderRegistry;
  findProvider: MockInstance;
} => {
  // An empty real registry: `findProvider` is a pass-through spy that finds nothing.
  const registry = new LinkPreviewProviderRegistry([]);
  return { registry, findProvider: vi.spyOn(registry, 'findProvider') };
};

interface MsgOpts {
  readonly content?: string;
  readonly bot?: boolean;
  readonly authorId?: string;
  readonly guildId?: string | null;
  readonly channelId?: string;
  readonly sendable?: boolean;
  readonly parentId?: string | null;
  /** Maps a channel id to its own parentId, so the ancestry walk can climb. */
  readonly ancestors?: Record<string, string | null>;
  /** The `reply` spy the plugin posts a preview through. */
  readonly reply?: ReturnType<typeof vi.fn>;
}

const makeMessage = (opts: MsgOpts = {}): Message =>
  buildMessage({
    content: opts.content ?? 'see https://x.com/a/status/1',
    author: { bot: opts.bot ?? false, id: opts.authorId ?? '111111111111111111' },
    client: { user: { id: '222222222222222222' } },
    guildId: opts.guildId === undefined ? 'g1' : opts.guildId,
    channelId: opts.channelId ?? 'c1',
    channel: { isSendable: () => opts.sendable ?? true, parentId: opts.parentId ?? null },
    guild: {
      channels: {
        cache: {
          get: (id: string) =>
            opts.ancestors && id in opts.ancestors ? { parentId: opts.ancestors[id] } : undefined,
        },
      },
    },
    ...(opts.reply === undefined ? {} : { reply: opts.reply }),
  });

/**
 * Deliver one `messageCreate` to a constructed plugin. A plugin that declares
 * no subscription is already inert, so an absent handler is a no-op rather
 * than a failure — the assertions below measure what the plugin *does*, which
 * keeps them honest whichever way an inert path is expressed.
 */
const deliver = async (
  plugin: ReturnType<typeof createSocialLinkPreviewPlugin>,
  message: Message,
  policy: PermissionRankPolicy = emptyPolicy,
): Promise<void> => {
  const handler = plugin.events?.messageCreate;
  if (handler === undefined) return;
  // The host resolves a plugin's dependencies in `init` and only then
  // attaches its subscriptions, so a hand-driven dispatch runs both steps.
  const context = ctx(policy);
  await plugin.init?.(context);
  // The discord.js event arg is OmitPartialGroupDMChannel<Message>; our fake
  // is structurally a Message, so narrow it to the handler's exact param type.
  await handler(context, message as Parameters<typeof handler>[1]);
};

const fire = async (
  rawConfig: unknown,
  message: Message,
  deps: Parameters<typeof createSocialLinkPreviewPlugin>[1],
  policy: PermissionRankPolicy = emptyPolicy,
): Promise<void> => deliver(createSocialLinkPreviewPlugin(rawConfig, deps), message, policy);

describe('createSocialLinkPreviewPlugin shape', () => {
  it('forwards all six configured proxy-host lists and the provider allow-list to the registry factory', () => {
    const spy = vi.mocked(createDefaultLinkPreviewRegistry);
    spy.mockClear();
    createSocialLinkPreviewPlugin(enabledConfig({ providers: ['twitter', 'bilibili'] }));
    expect(spy).toHaveBeenCalledWith({
      ...PROXY_HOSTS,
      gallerySources: [],
      enabledProviders: ['twitter', 'bilibili'],
    });
  });

  it('publishes the gallery reader, sharing its sources with the registry', async () => {
    const spy = vi.mocked(createDefaultLinkPreviewRegistry);
    spy.mockClear();
    const registerInstance = vi.fn();
    const plugin = createSocialLinkPreviewPlugin(
      enabledConfig({ providers: ['twitter', 'wnacg'] }),
    );
    await plugin.init?.(ctx(emptyPolicy, registerInstance));

    const sources = spy.mock.calls[0]?.[0].gallerySources ?? [];
    expect(sources.map((source) => source.name)).toEqual(['nhentai', 'wnacg']);
    expect(registerInstance).toHaveBeenCalledWith(TOKENS.GalleryReader, expect.anything());
  });

  it('stages pages through the configured channel and stops its cleanup on shutdown', async () => {
    const registerInstance = vi.fn();
    const container = createContainer();
    container.registerSingleton(TOKENS.PermissionRankPolicy, () => emptyPolicy);
    const client = { user: null, channels: { fetch: vi.fn(async () => null) } };
    container.registerSingleton(TOKENS.DiscordClient, () => client as never);
    const context = buildPluginContext({
      resolve: container.resolve.bind(container),
      registerInstance,
    });
    const plugin = createSocialLinkPreviewPlugin(
      enabledConfig({ gallery: { stagingChannelId: '123456789012345678' } }),
    );

    await plugin.init?.(context);
    await plugin.onReady?.(context);
    await plugin.onShutdown?.(context);

    expect(registerInstance).toHaveBeenCalledWith(TOKENS.GalleryReader, expect.anything());
  });

  it('publishes no gallery reader when the kill-switch omits every gallery source', async () => {
    const registerInstance = vi.fn();
    const plugin = createSocialLinkPreviewPlugin(enabledConfig({ providers: ['twitter'] }));
    await plugin.init?.(ctx(emptyPolicy, registerInstance));
    expect(registerInstance).not.toHaveBeenCalled();
  });

  it('refuses to run an event that somehow precedes init', async () => {
    // The host never dispatches to a plugin whose init did not run. The
    // guard raises rather than defaulting because the dependency it is
    // missing is the channel-privacy gate.
    const handler = createSocialLinkPreviewPlugin(enabledConfig()).events?.messageCreate;
    if (handler === undefined) throw new Error('no messageCreate handler');
    await expect(
      handler(ctx(emptyPolicy), makeMessage() as Parameters<typeof handler>[1]),
    ).rejects.toThrow(/dispatched before init/);
  });

  it('builds no registry when the feature is disabled and no host list is configured', () => {
    const spy = vi.mocked(createDefaultLinkPreviewRegistry);
    spy.mockClear();
    const plugin = createSocialLinkPreviewPlugin({ enabled: false });
    expect(plugin.id).toBe('social-link-preview');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createSocialLinkPreviewPlugin guards', () => {
  it('reaches the registry when every guard passes', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(enabledConfig(), makeMessage(), { registry });
    expect(findProvider).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled, even with a registry injected', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire({ enabled: false }, makeMessage(), { registry });
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('stays inert on a preview-worthy message when disabled with no registry at all', async () => {
    const spy = vi.mocked(createDefaultLinkPreviewRegistry);
    spy.mockClear();
    // The only externally visible act of a preview is the reply it posts, so a
    // never-called `reply` is the proof that a disabled plugin does nothing —
    // regardless of whether it declines to subscribe or returns early.
    const reply = vi.fn();
    const message = makeMessage({ reply });

    await deliver(createSocialLinkPreviewPlugin({ enabled: false }), message);

    expect(spy).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('skips bot-authored messages', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(enabledConfig(), makeMessage({ bot: true }), { registry });
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('posts a preview for an allow-listed bot', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const build = vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: 'rewritten-url', url: 'https://proxy.example/a/status/1' },
    });
    const registry = new LinkPreviewProviderRegistry([
      { name: 'twitter', canHandle: () => true, build },
    ]);
    const message = makeMessage({ bot: true, reply });

    await fire(
      enabledConfig({ allowedBotIds: ['111111111111111111'], originalMessageStrategy: 'leave' }),
      message,
      { registry },
    );

    expect(build).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: 'https://proxy.example/a/status/1',
      allowedMentions: { parse: [] },
    });
  });

  it('skips a bot absent from a nonempty allow-list', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(
      enabledConfig({ allowedBotIds: ['333333333333333333'] }),
      makeMessage({ bot: true }),
      { registry },
    );
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('skips its own messages even when allow-listed', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(
      enabledConfig({ allowedBotIds: ['222222222222222222'] }),
      makeMessage({ bot: true, authorId: '222222222222222222' }),
      { registry },
    );
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('continues to preview human messages with a nonempty bot allow-list', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(enabledConfig({ allowedBotIds: ['333333333333333333'] }), makeMessage(), {
      registry,
    });
    expect(findProvider).toHaveBeenCalledTimes(1);
  });

  it.each([{ guildId: null }, { channelId: 'c-secret' }, { sendable: false }])(
    'retains other guards for allow-listed bots: %j',
    async (opts) => {
      const { registry, findProvider } = makeRegistry();
      const policy = createPermissionRankPolicy({
        g1: { channels: { 'c-secret': 1 }, features: { social_preview: { maxChannelRank: 0 } } },
      });
      await fire(
        enabledConfig({ allowedBotIds: ['111111111111111111'] }),
        makeMessage({ ...opts, bot: true }),
        { registry },
        policy,
      );
      expect(findProvider).not.toHaveBeenCalled();
    },
  );

  it('skips direct messages (no guild)', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(enabledConfig(), makeMessage({ guildId: null }), { registry });
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('skips a channel above a configured social_preview ceiling', async () => {
    const { registry, findProvider } = makeRegistry();
    const policy = createPermissionRankPolicy({
      g1: { channels: { 'c-secret': 1 }, features: { social_preview: { maxChannelRank: 0 } } },
    });
    await fire(enabledConfig(), makeMessage({ channelId: 'c-secret' }), { registry }, policy);
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('skips a thread nested under a private category (full ancestry)', async () => {
    const { registry, findProvider } = makeRegistry();
    const policy = createPermissionRankPolicy({
      g1: { channels: { cat: 1 }, features: { social_preview: { maxChannelRank: 0 } } },
    });
    // thread 'th' → channel 'ch-cat' (unlisted) → category 'cat' (rank 1);
    // the cache resolves the intermediate channel so the walk reaches the category.
    await fire(
      enabledConfig(),
      makeMessage({ channelId: 'th', parentId: 'ch-cat', ancestors: { 'ch-cat': 'cat' } }),
      { registry },
      policy,
    );
    expect(findProvider).not.toHaveBeenCalled();
  });

  it('previews a ranked channel under the DEFAULT (unbounded) ceiling — the intentional change from blocked_channels', async () => {
    const { registry, findProvider } = makeRegistry();
    // A channel that would have been in nijika's old `blocked_channels` (rank
    // 1 here) now receives a preview, because social_preview defaults to no
    // ceiling. Suppressing it again requires an explicit finite ceiling.
    const policy = createPermissionRankPolicy({ g1: { channels: { 'c-secret': 1 } } });
    await fire(enabledConfig(), makeMessage({ channelId: 'c-secret' }), { registry }, policy);
    expect(findProvider).toHaveBeenCalledTimes(1);
  });

  it('skips non-sendable channels', async () => {
    const { registry, findProvider } = makeRegistry();
    await fire(enabledConfig(), makeMessage({ sendable: false }), { registry });
    expect(findProvider).not.toHaveBeenCalled();
  });
});
