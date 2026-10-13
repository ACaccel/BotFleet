/* eslint-disable import/first */
/**
 * The guild-events plugin driven against a REAL attachment cache.
 *
 * `guild-events-attachment-cache.test.ts` mocks the cache to pin the
 * plugin's decisions; `attachment-cache.test.ts` exercises the cache in
 * isolation. Neither covers the seam between them, and that seam is
 * where a hit is decided — two mocks agreeing with each other is exactly
 * how "any non-zero count means a full hit" would slip through.
 *
 * So this file wires the real `createAttachmentCache` (over a tmpdir)
 * into the real plugin and walks the whole path: post a message, delete
 * it, and check the bytes landed in the archive with no download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logGuildEvent: vi.fn(),
}));

vi.mock('axios');

vi.mock('../../../src/infra/discord', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  archiveDeletedAttachments: vi.fn(async () => undefined),
}));

import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message } from 'discord.js';
import { Readable } from 'node:stream';

import { archiveDeletedAttachments, createAttachmentCache } from '../../../src/infra/discord';
import { createGuildEventsPlugin } from '../../../src/plugins/guild-events';
import {
  createPermissionRankPolicy,
  type PluginEventContext,
  type PluginInitContext,
} from '../../../src/core/plugin';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { createLogger } from '../../../src/core/logger';
import { systemClock } from '../../../src/core/time';

const silent = createLogger({ level: 'silent', pretty: false });

const emptyRegistry: GuildRegistry = {
  getRepos: () => undefined,
  getChannel: () => undefined,
  getRole: () => undefined,
  listGuildIds: () => [],
};

const buildCtx = (): PluginEventContext => {
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
    clock: systemClock,
    resolve: container.resolve.bind(container),
  } as unknown as PluginEventContext;
};

type AttachmentStub = { id: string; name: string; url: string; contentType: string | null };

const attachmentCollection = (items: readonly AttachmentStub[]): unknown => ({
  size: items.length,
  map: (fn: (a: AttachmentStub) => unknown): unknown[] => items.map(fn),
  forEach: (fn: (a: AttachmentStub) => void): void => items.forEach(fn),
  values: (): IterableIterator<AttachmentStub> => items[Symbol.iterator](),
});

const attachment = (id: string, name: string): AttachmentStub => ({
  id,
  name,
  url: `https://cdn.invalid/${id}/${name}`,
  contentType: 'image/png',
});

const message = (attachments: readonly AttachmentStub[]): Message =>
  ({
    id: 'm-1',
    content: 'hello',
    author: {
      bot: false,
      id: 'u1',
      username: 'user',
      displayName: 'User',
      displayAvatarURL: () => 'https://example.test/a.png',
    },
    guild: { id: 'g1', name: 'Guild', channels: { cache: { get: () => undefined } } },
    guildId: 'g1',
    channel: { id: 'public', parentId: null },
    partial: false,
    attachments: attachmentCollection(attachments),
  }) as unknown as Message;

const A1 = '1300000000000000001';
const A2 = '1300000000000000002';

describe('guild-events attachment cache round trip', () => {
  let root: string;
  let cacheRoot: string;
  let archiveRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-events-roundtrip-'));
    cacheRoot = path.join(root, 'attachment_cache');
    archiveRoot = path.join(root, 'deleted_attachments');
    (axios.get as unknown as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
      data: Readable.from(['payload']),
    }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const initedPlugin = async (): Promise<{
    plugin: ReturnType<typeof createGuildEventsPlugin>;
    ctx: PluginEventContext;
  }> => {
    const plugin = createGuildEventsPlugin(undefined, {
      cache: createAttachmentCache({
        ttlHours: 24,
        minFreeDiskMb: 1,
        cacheRoot,
        archiveRoot,
        logger: silent,
        // A stub volume, so the round trip asserts the archival flow
        // rather than how much room the machine running it has left.
        statfs: () => Promise.resolve({ bavail: 1024 * 1024, bsize: 4096 }),
      }),
    });
    const ctx = buildCtx();
    await plugin.init?.(ctx as unknown as PluginInitContext);
    return { plugin, ctx };
  };

  // Files land under <guild>/<messageId>/; the message directory is the
  // id the audit line carries.
  const archived = (): string[] => {
    const dir = path.join(archiveRoot, 'g1', 'm-1');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('archives from disk on delete, with no download and no cache left behind', async () => {
    const { plugin, ctx } = await initedPlugin();
    const attachments = [attachment(A1, 'one.png'), attachment(A2, 'two.png')];

    await plugin.events?.messageCreate?.(ctx, message(attachments) as never);
    // `messageCreate` is fire-and-forget; wait for the bytes to land the
    // way a real delete arriving seconds later would find them.
    await vi.waitFor(() => {
      expect(fs.readdirSync(path.join(cacheRoot, 'g1', 'm-1'))).toHaveLength(2);
    });

    await plugin.events?.messageDelete?.(ctx, message(attachments) as never);

    expect(archived()).toHaveLength(2);
    expect(archiveDeletedAttachments).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cacheRoot, 'g1', 'm-1'))).toBe(false);
  });

  it('falls back to the download for a message it never saw created', async () => {
    const { plugin, ctx } = await initedPlugin();

    await plugin.events?.messageDelete?.(ctx, message([attachment(A1, 'one.png')]) as never);

    expect(archived()).toEqual([]);
    expect(archiveDeletedAttachments).toHaveBeenCalledTimes(1);
  });

  it('archives a delete that lands while the downloads are still running', async () => {
    // The race the cache exists to win. Nothing here waits for the
    // store: the delete is dispatched immediately after the create.
    const { plugin, ctx } = await initedPlugin();
    const attachments = [attachment(A1, 'one.png'), attachment(A2, 'two.png')];

    await plugin.events?.messageCreate?.(ctx, message(attachments) as never);
    await plugin.events?.messageDelete?.(ctx, message(attachments) as never);

    expect(archived()).toHaveLength(2);
    expect(archiveDeletedAttachments).not.toHaveBeenCalled();
  });
});
