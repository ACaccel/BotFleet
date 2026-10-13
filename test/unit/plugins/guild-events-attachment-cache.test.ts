/* eslint-disable import/first */
/**
 * The guild-events plugin's pre-delete attachment cache wiring.
 *
 * `attachment-cache.test.ts` covers the cache itself over a tmpdir;
 * this file covers the plugin's use of it — that `messageCreate` fills
 * the cache, that `messageDelete` prefers a cache hit over the network
 * path that Discord's CDN purge race usually defeats, and that the TTL
 * sweep stops on shutdown instead of outliving the plugin.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cache: {
    store: vi.fn(async () => undefined),
    archiveCached: vi.fn(async () => 0),
    sweepExpired: vi.fn(async () => 0),
  },
}));

vi.mock('@core/logger', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logGuildEvent: vi.fn(),
}));

vi.mock('../../../src/infra/discord', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  archiveDeletedAttachments: vi.fn(async () => undefined),
  createAttachmentCache: vi.fn(() => mocks.cache),
}));

import type { Message, PartialMessage } from 'discord.js';

import { logGuildEvent } from '@core/logger';
import { archiveDeletedAttachments, createAttachmentCache } from '../../../src/infra/discord';
import { createGuildEventsPlugin } from '../../../src/plugins/guild-events';
import {
  createPermissionRankPolicy,
  type PluginEventContext,
  type PluginInitContext,
  type PluginRuntimeContext,
} from '../../../src/core/plugin';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { createLogger } from '../../../src/core/logger';
import { createFakeClock, systemClock, type Clock } from '../../../src/core/time';

const silent = createLogger({ level: 'silent', pretty: false });

const emptyRegistry: GuildRegistry = {
  getRepos: () => undefined,
  getChannel: () => undefined,
  getRole: () => undefined,
  listGuildIds: () => [],
};

const buildCtx = (clock: Clock = systemClock): PluginEventContext => {
  const container = createContainer();
  container.registerSingleton(TOKENS.Logger, () => silent);
  container.registerSingleton(TOKENS.GuildRegistry, () => emptyRegistry);
  container.registerSingleton(TOKENS.PermissionRankPolicy, () => createPermissionRankPolicy({}));
  container.registerSingleton(TOKENS.GuildOnboardingPort, () => ({
    onboardGuild: async () => ({
      guildId: 'g1',
      databaseConnected: true,
      commandsRegistered: true,
    }),
  }));
  return {
    logger: silent,
    translator: undefined,
    clock,
    resolve: container.resolve.bind(container),
  } as unknown as PluginEventContext;
};

/** The host resolves dependencies in `init` before attaching subscriptions. */
const initedPlugin = async (
  rawConfig?: unknown,
  clock: Clock = systemClock,
): Promise<{ plugin: ReturnType<typeof createGuildEventsPlugin>; ctx: PluginEventContext }> => {
  const plugin = createGuildEventsPlugin(rawConfig);
  const ctx = buildCtx(clock);
  await plugin.init?.(ctx as unknown as PluginInitContext);
  return { plugin, ctx };
};

type AttachmentStub = { id: string; name: string; url: string; contentType: string | null };

/** Minimal discord.js Collection surface the handlers touch. */
const attachmentCollection = (items: readonly AttachmentStub[]): unknown => ({
  size: items.length,
  map: (fn: (a: AttachmentStub) => unknown): unknown[] => items.map(fn),
  forEach: (fn: (a: AttachmentStub) => void): void => items.forEach(fn),
  values: (): IterableIterator<AttachmentStub> => items[Symbol.iterator](),
});

const attachment = (id: string): AttachmentStub => ({
  id,
  name: `${id}.png`,
  url: `https://cdn.invalid/${id}.png`,
  contentType: 'image/png',
});

const message = (
  overrides: {
    id?: string;
    bot?: boolean;
    guildId?: string | null;
    attachments?: readonly AttachmentStub[];
  } = {},
): Message =>
  ({
    id: overrides.id ?? 'm1',
    content: 'hello',
    author: {
      bot: overrides.bot ?? false,
      id: 'u1',
      username: 'user',
      displayName: 'User',
      displayAvatarURL: () => 'https://example.test/a.png',
    },
    guild: { id: 'g1', name: 'Guild', channels: { cache: { get: () => undefined } } },
    guildId: overrides.guildId === undefined ? 'g1' : overrides.guildId,
    channel: { id: 'public', parentId: null },
    partial: false,
    attachments: attachmentCollection(overrides.attachments ?? []),
  }) as unknown as Message;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cache.archiveCached.mockResolvedValue(0);
  mocks.cache.sweepExpired.mockResolvedValue(0);
});

describe('guild-events messageCreate caching', () => {
  const fire = async (msg: Message): Promise<void> => {
    const { plugin, ctx } = await initedPlugin();
    await plugin.events?.messageCreate?.(ctx, msg as never);
  };

  it('caches the attachments of a non-bot guild message', async () => {
    await fire(message({ attachments: [attachment('a1'), attachment('a2')] }));

    expect(mocks.cache.store).toHaveBeenCalledTimes(1);
    const [guildId, messageId] = mocks.cache.store.mock.calls[0] as unknown as [string, string];
    expect(guildId).toBe('g1');
    expect(messageId).toBe('m1');
  });

  it('ignores a bot author, matching what the archive ever records', async () => {
    await fire(message({ bot: true, attachments: [attachment('a1')] }));
    expect(mocks.cache.store).not.toHaveBeenCalled();
  });

  it('ignores a message with no attachments', async () => {
    await fire(message());
    expect(mocks.cache.store).not.toHaveBeenCalled();
  });

  it('ignores a DM, which has no guild to archive under', async () => {
    await fire(message({ guildId: null, attachments: [attachment('a1')] }));
    expect(mocks.cache.store).not.toHaveBeenCalled();
  });
});

describe('guild-events messageDelete archival source', () => {
  const fireDelete = async (msg: Message): Promise<void> => {
    const { plugin, ctx } = await initedPlugin();
    await plugin.events?.messageDelete?.(ctx, msg as never);
  };

  it('archives from the cache and never touches the network on a hit', async () => {
    mocks.cache.archiveCached.mockResolvedValue(2);

    await fireDelete(message({ attachments: [attachment('a1'), attachment('a2')] }));

    expect(mocks.cache.archiveCached).toHaveBeenCalledWith('g1', 'm1');
    // The download is exactly what the CDN purge race defeats; a cache
    // hit must not fall through to it.
    expect(archiveDeletedAttachments).not.toHaveBeenCalled();
  });

  it('falls back to the download when the cache never saw the message', async () => {
    mocks.cache.archiveCached.mockResolvedValue(0);

    await fireDelete(message({ attachments: [attachment('a1')] }));

    expect(archiveDeletedAttachments).toHaveBeenCalledTimes(1);
    // The message id is what names the archive directory, so the
    // fallback must receive it.
    expect(vi.mocked(archiveDeletedAttachments).mock.calls[0]?.slice(1, 3)).toEqual(['g1', 'm1']);
  });

  it('still downloads when the cache held only part of the message', async () => {
    mocks.cache.archiveCached.mockResolvedValue(1);

    await fireDelete(message({ attachments: [attachment('a1'), attachment('a2')] }));

    // Treating any non-zero count as a full hit would silently abandon
    // the attachments the cache never managed to download.
    expect(archiveDeletedAttachments).toHaveBeenCalledTimes(1);
  });

  it('records the audit line even when the cache read blows up', async () => {
    mocks.cache.archiveCached.mockRejectedValue(new Error('disk gone'));

    await expect(fireDelete(message({ attachments: [attachment('a1')] }))).resolves.toBeUndefined();

    // The local record is the one thing that must always survive; no
    // disk fault on the archival path may suppress it.
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('consults the cache before the download, so a purged URL is never the only chance', async () => {
    const order: string[] = [];
    mocks.cache.archiveCached.mockImplementation(async () => {
      order.push('cache');
      return 0;
    });
    vi.mocked(archiveDeletedAttachments).mockImplementation(async () => {
      order.push('network');
    });

    await fireDelete(message({ attachments: [attachment('a1')] }));

    expect(order).toEqual(['cache', 'network']);
  });
});

describe('guild-events messageDeleteBulk', () => {
  it('archives the cached attachments of every message in the batch', async () => {
    const { plugin, ctx } = await initedPlugin();
    const batch = new Map<string, Message | PartialMessage>([
      ['m1', message({ id: 'm1' })],
      ['m2', message({ id: 'm2' })],
    ]);

    await plugin.events?.messageDeleteBulk?.(ctx, batch as never, undefined as never);

    expect(mocks.cache.archiveCached.mock.calls).toEqual([
      ['g1', 'm1'],
      ['g1', 'm2'],
    ]);
  });

  it('skips an entry with no guild rather than keying the cache on "null"', async () => {
    const { plugin, ctx } = await initedPlugin();
    const batch = new Map<string, Message | PartialMessage>([
      ['m1', message({ id: 'm1', guildId: null })],
      ['m2', message({ id: 'm2' })],
    ]);

    await plugin.events?.messageDeleteBulk?.(ctx, batch as never, undefined as never);

    expect(mocks.cache.archiveCached.mock.calls).toEqual([['g1', 'm2']]);
  });

  it('records one audit line per rescued message, so the archive is reconcilable', async () => {
    const { plugin, ctx } = await initedPlugin();
    mocks.cache.archiveCached.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const batch = new Map<string, Message | PartialMessage>([
      ['m1', message({ id: 'm1' })],
      ['m2', message({ id: 'm2' })],
    ]);

    await plugin.events?.messageDeleteBulk?.(ctx, batch as never, undefined as never);

    // Only the message that actually yielded files: a line for a message
    // with nothing cached would claim an archive entry that is not there.
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
    const details = vi.mocked(logGuildEvent).mock.calls[0]?.[3] as Record<string, unknown>;
    expect(details).toMatchObject({ messageId: 'm1', source: 'bulk', archivedAttachments: 2 });
  });

  it('keeps going after one message fails, rather than abandoning the batch', async () => {
    const { plugin, ctx } = await initedPlugin();
    mocks.cache.archiveCached.mockRejectedValueOnce(new Error('disk gone'));
    const batch = new Map<string, Message | PartialMessage>([
      ['m1', message({ id: 'm1' })],
      ['m2', message({ id: 'm2' })],
      ['m3', message({ id: 'm3' })],
    ]);

    await expect(
      plugin.events?.messageDeleteBulk?.(ctx, batch as never, undefined as never),
    ).resolves.toBeUndefined();

    // A bulk delete carries up to a hundred messages; one bad entry must
    // not cost the other ninety-nine.
    expect(mocks.cache.archiveCached).toHaveBeenCalledTimes(3);
  });
});

describe('guild-events attachment cache construction', () => {
  it('hands the configured TTL and free-space floor to the cache', async () => {
    // The only place either field has a production effect. Without this
    // the schema tests and the cache tests both stay green while the
    // plugin passes a constant, or swaps the two values.
    await initedPlugin({ attachment_cache: { ttlHours: 6, minFreeDiskMb: 512 } });

    expect(createAttachmentCache).toHaveBeenCalledWith(
      expect.objectContaining({ ttlHours: 6, minFreeDiskMb: 512 }),
    );
  });

  it('falls back to the schema defaults when the block is absent', async () => {
    await initedPlugin(undefined);

    expect(createAttachmentCache).toHaveBeenCalledWith(
      expect.objectContaining({ ttlHours: 24, minFreeDiskMb: 5120 }),
    );
  });
});

describe('guild-events attachment cache disabled', () => {
  const disabled = { attachment_cache: { enabled: false } };

  it('builds no cache at all', async () => {
    await initedPlugin(disabled);
    expect(createAttachmentCache).not.toHaveBeenCalled();
  });

  it('keeps the download-on-delete behaviour exactly as it was', async () => {
    const { plugin, ctx } = await initedPlugin(disabled);

    await plugin.events?.messageCreate?.(
      ctx,
      message({ attachments: [attachment('a1')] }) as never,
    );
    await plugin.events?.messageDelete?.(
      ctx,
      message({ attachments: [attachment('a1')] }) as never,
    );

    expect(mocks.cache.store).not.toHaveBeenCalled();
    expect(mocks.cache.archiveCached).not.toHaveBeenCalled();
    expect(archiveDeletedAttachments).toHaveBeenCalledTimes(1);
  });
});

describe('guild-events TTL sweep lifecycle', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps once at ready against the injected clock, clearing the downtime backlog', async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const { plugin, ctx } = await initedPlugin(undefined, clock);
    await plugin.onReady?.(ctx as unknown as PluginRuntimeContext);

    expect(mocks.cache.sweepExpired).toHaveBeenCalledTimes(1);
    // Reading `Date.now()` instead of the injected clock would make the
    // TTL untestable and diverge from the rest of the bot's time source.
    expect(mocks.cache.sweepExpired).toHaveBeenCalledWith(clock.now());

    await plugin.onShutdown?.(ctx as unknown as PluginRuntimeContext);
  });

  it('reports a sweep that actually removed something', async () => {
    mocks.cache.sweepExpired.mockResolvedValue(3);
    const { plugin, ctx } = await initedPlugin();

    await expect(plugin.onReady?.(ctx as unknown as PluginRuntimeContext)).resolves.toBeUndefined();

    await plugin.onShutdown?.(ctx as unknown as PluginRuntimeContext);
  });

  it('reschedules itself hourly and stops on shutdown', async () => {
    vi.useFakeTimers();
    const { plugin, ctx } = await initedPlugin();
    await plugin.onReady?.(ctx as unknown as PluginRuntimeContext);

    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS);
    expect(mocks.cache.sweepExpired).toHaveBeenCalledTimes(2);

    await plugin.onShutdown?.(ctx as unknown as PluginRuntimeContext);

    // A timer that outlives the plugin keeps the process alive and
    // sweeps a tree nobody owns any more.
    await vi.advanceTimersByTimeAsync(3 * ONE_HOUR_MS);
    expect(mocks.cache.sweepExpired).toHaveBeenCalledTimes(2);
  });

  it('keeps sweeping after the boot pass fails', async () => {
    vi.useFakeTimers();
    mocks.cache.sweepExpired.mockRejectedValueOnce(new Error('disk gone'));
    const { plugin, ctx } = await initedPlugin();

    await plugin.onReady?.(ctx as unknown as PluginRuntimeContext);
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS);

    expect(mocks.cache.sweepExpired).toHaveBeenCalledTimes(2);
    await plugin.onShutdown?.(ctx as unknown as PluginRuntimeContext);
  });

  it('keeps sweeping after a scheduled pass fails', async () => {
    vi.useFakeTimers();
    // The boot pass succeeds and a later timer pass throws — the case
    // that could kill the reschedule loop and silently stop bounding
    // disk use forever.
    mocks.cache.sweepExpired.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('disk gone'));
    const { plugin, ctx } = await initedPlugin();

    await plugin.onReady?.(ctx as unknown as PluginRuntimeContext);
    await vi.advanceTimersByTimeAsync(2 * ONE_HOUR_MS);

    expect(mocks.cache.sweepExpired).toHaveBeenCalledTimes(3);
    await plugin.onShutdown?.(ctx as unknown as PluginRuntimeContext);
  });

  it('does nothing on ready when the cache is disabled', async () => {
    const { plugin, ctx } = await initedPlugin({ attachment_cache: { enabled: false } });
    await plugin.onReady?.(ctx as unknown as PluginRuntimeContext);
    expect(mocks.cache.sweepExpired).not.toHaveBeenCalled();
  });

  it('tolerates a shutdown that follows a failed init', async () => {
    // The contract in `core/plugin/types.ts`: onShutdown may run
    // without a successful init, so it must not touch resolved state.
    const plugin = createGuildEventsPlugin();
    await expect(
      plugin.onShutdown?.(buildCtx() as unknown as PluginRuntimeContext),
    ).resolves.toBeUndefined();
  });
});
