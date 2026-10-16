/**
 * Notification relay delivery: the first update for a route and key posts a
 * message, later ones edit it (also across a restart through the store), a
 * deleted message is posted anew, and racing updates for one thread post
 * once. Failures map to outcomes the HTTP layer turns into status codes.
 * The HTTP contract itself is covered by
 * `test/integration/plugins/notification-relay-route.int.test.ts`.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Client } from 'discord.js';

import { err, ok } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import type {
  NotificationThreadId,
  NotificationThreadMessage,
  NotificationThreadRepo,
} from '../../../src/persistence/repositories/notification-thread.repo';
import { parseNotificationRoutes } from '../../../src/plugins/notification-relay/internal/config';
import {
  createNotificationRelay,
  type NotificationRelayDeps,
} from '../../../src/plugins/notification-relay/internal/relay';
import type { Notification } from '../../../src/plugins/notification-relay/internal/request';
import { echoTranslator, spyLogger } from '../../fixtures/runtime';
import { systemClock } from '../../../src/core/time';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const ROUTE = { guildId: GUILD, channelId: CHANNEL };

const NOTIFICATION: Notification = {
  title: 'Deploy b5ffd42',
  stages: [{ label: 'Build', state: 'running' }],
  status: 'running',
};

const discordError = (code: number): Error => Object.assign(new Error(`discord ${code}`), { code });

interface FakeChannel {
  readonly id: string;
  readonly guildId: string;
  readonly send: Mock;
  readonly edit: Mock;
}

const buildChannel = (
  id = CHANNEL,
  guildId = GUILD,
  sendDelayMs = 5,
): FakeChannel & Record<string, unknown> => {
  let sent = 0;
  const send = vi.fn(async () => {
    sent += 1;
    // Yield so racing callers would interleave without the per-thread lock.
    if (sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
    return { id: `${id}-message-${sent}` };
  });
  const edit = vi.fn(async () => ({}));
  return {
    id,
    guildId,
    send,
    edit,
    messages: { edit },
    isTextBased: () => true,
    isDMBased: () => false,
  };
};

const buildClient = (
  channels: Record<string, unknown>,
  ready = true,
): { client: Client; fetch: Mock } => {
  const fetch = vi.fn(async (id: string) => channels[id] ?? null);
  return { client: { isReady: () => ready, channels: { fetch } } as unknown as Client, fetch };
};

const keyOf = (id: NotificationThreadId): string => `${id.botId}/${id.route}/${id.threadKey}`;

const memoryStore = (): {
  readonly repo: NotificationThreadRepo & { find: Mock; save: Mock };
  readonly rows: Map<string, NotificationThreadMessage>;
} => {
  const rows = new Map<string, NotificationThreadMessage>();
  const repo = {
    find: vi.fn(async (id: NotificationThreadId) => ok(rows.get(keyOf(id)))),
    save: vi.fn(async (id: NotificationThreadId, message: NotificationThreadMessage) => {
      rows.set(keyOf(id), message);
      return ok(undefined);
    }),
  };
  return { repo, rows };
};

const buildRelay = (overrides: Partial<NotificationRelayDeps> & { client: Client }) => {
  const logger = spyLogger();
  const store = overrides.store ?? (async () => memoryStore().repo);
  const relay = createNotificationRelay({
    botId: 'konata',
    translator: echoTranslator(),
    clock: systemClock,
    logger,
    ...overrides,
    store,
  });
  return { relay, logger };
};

describe('notification relay delivery', () => {
  it('posts the first update and edits the same message afterwards', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo, rows } = memoryStore();
    const { relay } = buildRelay({ client, store: async () => repo });

    const first = await relay.deliver('deploy', ROUTE, 'b5ffd42-1', NOTIFICATION);
    const second = await relay.deliver('deploy', ROUTE, 'b5ffd42-1', {
      ...NOTIFICATION,
      status: 'succeeded',
    });

    expect(first).toEqual({ kind: 'delivered', messageId: `${CHANNEL}-message-1`, created: true });
    expect(second).toEqual({
      kind: 'delivered',
      messageId: `${CHANNEL}-message-1`,
      created: false,
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
    expect(channel.edit).toHaveBeenCalledWith(
      `${CHANNEL}-message-1`,
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
    expect(rows.get('konata/deploy/b5ffd42-1')).toEqual({
      channelId: CHANNEL,
      messageId: `${CHANNEL}-message-1`,
    });
    // Each delivery refreshes the record so its expiry restarts.
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('keeps editing after a restart through the stored record', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo } = memoryStore();

    await buildRelay({ client, store: async () => repo }).relay.deliver(
      'deploy',
      ROUTE,
      'k',
      NOTIFICATION,
    );
    const restarted = buildRelay({ client, store: async () => repo }).relay;
    const outcome = await restarted.deliver('deploy', ROUTE, 'k', NOTIFICATION);

    expect(outcome).toMatchObject({ kind: 'delivered', created: false });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.edit).toHaveBeenCalledTimes(1);
  });

  it('posts a new message when the stored one was deleted', async () => {
    const channel = buildChannel();
    channel.edit.mockRejectedValueOnce(discordError(10008));
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo, rows } = memoryStore();
    rows.set('konata/deploy/k', { channelId: CHANNEL, messageId: 'gone' });
    const { relay } = buildRelay({ client, store: async () => repo });

    const outcome = await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION);

    expect(outcome).toEqual({
      kind: 'delivered',
      messageId: `${CHANNEL}-message-1`,
      created: true,
    });
    expect(rows.get('konata/deploy/k')?.messageId).toBe(`${CHANNEL}-message-1`);
  });

  it('posts once when updates for one thread race', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo } = memoryStore();
    const { relay } = buildRelay({ client, store: async () => repo });

    const outcomes = await Promise.all([
      relay.deliver('deploy', ROUTE, 'k', NOTIFICATION),
      relay.deliver('deploy', ROUTE, 'k', NOTIFICATION),
      relay.deliver('deploy', ROUTE, 'other', NOTIFICATION),
    ]);

    expect(outcomes.map((o) => (o.kind === 'delivered' ? o.created : o.kind))).toEqual([
      true,
      false,
      true,
    ]);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.edit).toHaveBeenCalledTimes(1);
  });

  it('starts a new message when the route moved to another channel', async () => {
    const moved = buildChannel('323456789012345678');
    const { client } = buildClient({ '323456789012345678': moved });
    const { repo, rows } = memoryStore();
    rows.set('konata/deploy/k', { channelId: CHANNEL, messageId: 'old' });
    const { relay } = buildRelay({ client, store: async () => repo });

    const outcome = await relay.deliver(
      'deploy',
      { guildId: GUILD, channelId: '323456789012345678' },
      'k',
      NOTIFICATION,
    );

    expect(outcome).toMatchObject({ kind: 'delivered', created: true });
    expect(moved.edit).not.toHaveBeenCalled();
  });

  it('answers not_ready before the Discord client is ready', async () => {
    const { client, fetch } = buildClient({}, false);
    const { relay } = buildRelay({ client });

    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({ kind: 'not_ready' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a channel in another guild', buildChannel(CHANNEL, '999999999999999999')],
    ['a missing channel', null],
    ['a non-text channel', { ...buildChannel(), isTextBased: () => false, isDMBased: () => false }],
  ])('treats %s as a misconfigured route', async (_label, channel) => {
    const { client } = buildClient({ [CHANNEL]: channel });
    const { relay, logger } = buildRelay({ client });

    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'misconfigured',
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('separates an unknown channel from a failed fetch', async () => {
    const { client, fetch } = buildClient({});
    const { relay } = buildRelay({ client });

    fetch.mockRejectedValueOnce(discordError(10003));
    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'misconfigured',
    });
    fetch.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'discord_failed',
    });
  });

  it('reports a failed send or a failed edit other than a deleted message', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo } = memoryStore();
    const { relay } = buildRelay({ client, store: async () => repo });

    channel.send.mockRejectedValueOnce(discordError(50013));
    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'discord_failed',
    });

    await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION);
    channel.edit.mockRejectedValueOnce(discordError(50005));
    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'discord_failed',
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('answers storage_unavailable when the store cannot be opened or read', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });

    const unopened = buildRelay({
      client,
      store: async () => {
        throw new Error('guild database disabled');
      },
    }).relay;
    expect(await unopened.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'storage_unavailable',
    });

    const { repo } = memoryStore();
    repo.find.mockResolvedValueOnce(
      err(databaseErrorFrom(new Error('read failed'), { operation: 'test' })),
    );
    const unreadable = buildRelay({ client, store: async () => repo }).relay;
    expect(await unreadable.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toEqual({
      kind: 'storage_unavailable',
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('delivers despite a failed save and still edits the same message next time', async () => {
    const channel = buildChannel();
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo } = memoryStore();
    repo.save.mockResolvedValue(
      err(databaseErrorFrom(new Error('write failed'), { operation: 'test' })),
    );
    const { relay, logger } = buildRelay({ client, store: async () => repo });

    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toMatchObject({
      created: true,
    });
    expect(await relay.deliver('deploy', ROUTE, 'k', NOTIFICATION)).toMatchObject({
      created: false,
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('forgets the oldest in-process threads beyond its limit', async () => {
    const channel = buildChannel(CHANNEL, GUILD, 0);
    const { client } = buildClient({ [CHANNEL]: channel });
    const { repo } = memoryStore();
    const { relay } = buildRelay({ client, store: async () => repo });

    for (let i = 0; i <= 256; i += 1) {
      await relay.deliver('deploy', ROUTE, `k${i}`, NOTIFICATION);
    }
    repo.find.mockClear();
    await relay.deliver('deploy', ROUTE, 'k0', NOTIFICATION);
    await relay.deliver('deploy', ROUTE, 'k256', NOTIFICATION);

    // `k0` was evicted and is read back from the store; `k256` is still cached.
    expect(repo.find).toHaveBeenCalledTimes(1);
  });
});

describe('notificationRoutes config', () => {
  const route = { guildId: GUILD, channelId: CHANNEL };

  it('reads routes by name and treats an absent block as none', () => {
    expect(
      parseNotificationRoutes({ 'card-together-deploy': route }).get('card-together-deploy'),
    ).toEqual(route);
    expect(parseNotificationRoutes(undefined).size).toBe(0);
  });

  it.each([
    ['an uppercase name', { Deploy: route }],
    ['a leading hyphen', { '-deploy': route }],
    ['a name over 64 characters', { [`a${'b'.repeat(64)}`]: route }],
    ['a placeholder ID', { deploy: { ...route, guildId: 'YOUR_GUILD_ID' } }],
    ['an unknown field', { deploy: { ...route, webhook: 'x' } }],
    ['a missing channel', { deploy: { guildId: GUILD } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseNotificationRoutes(raw)).toThrow();
  });
});
