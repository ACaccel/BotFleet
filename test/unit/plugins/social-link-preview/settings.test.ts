import { describe, expect, it, vi } from 'vitest';
import { createSocialLinkPreviewPlugin } from '../../../../src/plugins/social-link-preview';
import { renderPreview } from '../../../../src/plugins/social-link-preview/internal/render';
import {
  LinkPreviewProviderRegistry,
  type LinkPreviewProvider,
  type LinkPreviewResult,
} from '../../../../src/infra/link-preview';
import {
  defaultGuildSettings,
  FEATURES,
  type GuildSettingsSnapshot,
  type GuildSettingsRuntime,
} from '../../../../src/core/guild-settings';
import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { TOKENS } from '../../../../src/bot/tokens';
import { ok } from '../../../../src/core/result';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { buildPluginContext, echoTranslator } from '../../../fixtures/runtime';

const snapshot = (guildId: string): GuildSettingsSnapshot => ({
  botId: 'bot',
  guildId,
  revision: 1,
  audit: [],
  lastOperationId: 'seed',
  settings: defaultGuildSettings({
    features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<
      (typeof FEATURES)[number],
      boolean
    >,
    socialProviders: ['twitter', 'instagram'],
    maxRandomProbability: 1,
    minCooldownSeconds: 0,
    maxPreviewUrls: 5,
  }),
});
const configured = {
  enabled: true,
  twitterProxyHosts: ['tw.example'],
  instagramProxyHosts: ['ig.example'],
  threadsProxyHosts: ['th.example'],
  facebookProxyHosts: ['fb.example'],
  redditProxyHosts: ['rd.example'],
  bilibiliProxyHosts: ['bili.example'],
  maxUrlsPerMessage: 2,
  providers: ['twitter'],
};
const rewritten: LinkPreviewResult = {
  kind: 'rewritten-url',
  sourceUrl: 'https://x.com/a/status/1',
  url: 'https://proxy.example/1',
};
const setup = async (snapshots: GuildSettingsSnapshot[], enabled = true) => {
  const provider: LinkPreviewProvider = {
    name: 'twitter',
    canHandle: () => true,
    build: vi.fn(async () => ok(rewritten)),
  };
  const settings: GuildSettingsRuntime = {
    get: (guildId) => snapshots.find((value) => value.guildId === guildId),
    isEnabled: vi.fn(
      (_guildId, _feature, _channelId, ancestors) => enabled && !ancestors?.includes('excluded'),
    ),
  };
  const registry = new LinkPreviewProviderRegistry([provider]);
  const plugin = createSocialLinkPreviewPlugin(configured, { registry, settings });
  const ctx = buildPluginContext({
    services: [[TOKENS.PermissionRankPolicy, createPermissionRankPolicy({})]],
  });
  await plugin.init?.(ctx);
  const deliver = async (guildId: string, fields: Record<string, unknown> = {}) => {
    const reply = vi.fn(async (_payload: unknown) => undefined);
    const message = buildMessage({
      content: 'https://x.com/a/status/1 https://x.com/a/status/2 https://x.com/a/status/3',
      guildId,
      reply,
      client: { user: { id: 'bot' } },
      channel: { isSendable: () => true },
      ...fields,
    });
    const handler = plugin.events!.messageCreate!;
    await handler(ctx, message as Parameters<typeof handler>[1]);
    return reply;
  };
  return { deliver, provider, settings };
};

describe('guild social-preview preferences', () => {
  it('fails closed for disabled, excluded and unknown guilds before provider build', async () => {
    const disabled = await setup([snapshot('a')], false);
    await disabled.deliver('a');
    expect(disabled.provider.build).not.toHaveBeenCalled();
    const scoped = await setup([snapshot('a')]);
    await scoped.deliver('missing');
    await scoped.deliver('a', {
      channel: { isSendable: () => true, parentId: 'parent' },
      guild: { channels: { cache: { get: () => ({ parentId: 'excluded' }) } } },
    });
    expect(scoped.provider.build).not.toHaveBeenCalled();
    expect(scoped.settings.isEnabled).toHaveBeenLastCalledWith(
      'a',
      'social_preview',
      'c1',
      expect.arrayContaining(['parent', 'excluded']),
    );
  });

  it('isolates provider subsets and clamps a guild URL count to the operator cap', async () => {
    const a = snapshot('a');
    const b = snapshot('b');
    a.settings.socialPreview.providers = ['instagram'];
    b.settings.socialPreview.maxUrlsPerMessage = 5;
    b.settings.socialPreview.originalMessageStrategy = 'leave';
    const { deliver, provider } = await setup([a, b]);
    expect(await deliver('a')).not.toHaveBeenCalled();
    expect(provider.build).not.toHaveBeenCalled();
    const reply = await deliver('b');
    expect(provider.build).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledTimes(2);
    b.settings.socialPreview.maxUrlsPerMessage = 1;
    expect(await deliver('b')).toHaveBeenCalledOnce();
  });

  it('does not call an operator-disabled provider even when an injected registry offers it', async () => {
    const value = snapshot('a');
    value.settings.socialPreview.providers = ['instagram'];
    const provider: LinkPreviewProvider = {
      name: 'instagram',
      canHandle: () => true,
      build: vi.fn(async () => ok(rewritten)),
    };
    const settings: GuildSettingsRuntime = { get: () => value, isEnabled: () => true };
    const plugin = createSocialLinkPreviewPlugin(configured, {
      settings,
      registry: new LinkPreviewProviderRegistry([provider]),
    });
    const ctx = buildPluginContext({
      services: [[TOKENS.PermissionRankPolicy, createPermissionRankPolicy({})]],
    });
    await plugin.init?.(ctx);
    const handler = plugin.events!.messageCreate!;
    await handler(
      ctx,
      buildMessage({
        content: 'https://instagram.com/p/a',
        client: { user: { id: 'bot' } },
        channel: { isSendable: () => true },
      }) as Parameters<typeof handler>[1],
    );
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('applies each guild original-message strategy only after posting its preview', async () => {
    const a = snapshot('a');
    const b = snapshot('b');
    a.settings.socialPreview.originalMessageStrategy = 'leave';
    b.settings.socialPreview.originalMessageStrategy = 'suppress';
    a.settings.socialPreview.maxUrlsPerMessage = b.settings.socialPreview.maxUrlsPerMessage = 1;
    const { deliver } = await setup([a, b]);
    const suppressEmbeds = vi.fn(async () => undefined);
    const fields = {
      inGuild: () => true,
      suppressEmbeds,
      channel: { isSendable: () => true, permissionsFor: () => ({ has: () => true }) },
    };
    await deliver('a', fields);
    expect(suppressEmbeds).not.toHaveBeenCalled();
    await deliver('b', fields);
    expect(suppressEmbeds).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['card', 'post'] as const)(
    'video opt-out preserves a %s preview without calling the downloader',
    async (kind) => {
      const result: LinkPreviewResult =
        kind === 'card'
          ? {
              kind,
              sourceUrl: 'https://facebook.com/a',
              card: {
                url: 'https://facebook.com/a',
                siteName: 'Facebook',
                title: 'post',
                imageUrl: 'https://image.example/1.png',
              },
              media: { url: 'https://video.example/1.mp4', fallbackUrl: 'https://facebook.com/a' },
            }
          : {
              kind,
              sourceUrl: 'https://x.com/a/status/1',
              post: {
                url: 'https://x.com/a/status/1',
                text: 'post',
                createdAt: Date.now(),
                author: { name: 'A', handle: 'a', url: 'https://x.com/a' },
                images: [],
                stats: {},
                video: {
                  thumbnailUrl: 'https://image.example/1.png',
                  durationSeconds: 1,
                  variants: [{ url: 'https://video.example/1.mp4', bitrate: 100 }],
                },
              },
            };
      const downloadVideo = vi.fn(async () => ({ data: Buffer.from('video'), name: 'video.mp4' }));
      const reply = vi.fn(async (_payload: unknown) => undefined);
      await renderPreview(buildMessage({ reply }), result, echoTranslator(), {
        videoEnabled: false,
        downloadVideo,
      });
      expect(downloadVideo).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledOnce();
      const payload = reply.mock.calls[0]?.[0] as { embeds: unknown[]; files?: unknown[] };
      expect(payload.embeds).toHaveLength(1);
      expect(payload.files).toBeUndefined();
    },
  );
});
