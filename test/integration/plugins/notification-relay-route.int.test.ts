/**
 * HTTP contract of the notification relay API, driven through the plugin's
 * real `start` hook on an OS-assigned loopback port with a fake Discord
 * client and an in-memory thread store. `onShutdown` releases the socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { TOKENS } from '../../../src/bot/tokens';
import { createContainer } from '../../../src/core/ioc';
import { ok } from '../../../src/core/result';
import type {
  NotificationThreadMessage,
  NotificationThreadRepo,
} from '../../../src/persistence/repositories/notification-thread.repo';
import { createNotificationRelayPlugin } from '../../../src/plugins/notification-relay';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

const KEY = 'test-notify-key-0123456789abcdefghij';
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const ROUTES = { 'card-together-deploy': { guildId: GUILD, channelId: CHANNEL } };

const BODY = {
  title: 'Deploy b5ffd42',
  description: 'feat(chat): restack messages',
  stages: [
    { label: 'Build', state: 'done' },
    { label: 'Restart', state: 'running' },
  ],
  status: 'running',
};

interface Harness {
  readonly base: string;
  readonly send: ReturnType<typeof vi.fn>;
  readonly edit: ReturnType<typeof vi.fn>;
  readonly logLines: () => string;
}

let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
});

const start = async (
  options: { ready?: boolean; guildId?: string; storeThrows?: boolean } = {},
): Promise<Harness> => {
  let sent = 0;
  const send = vi.fn(async () => ({ id: `message-${(sent += 1)}` }));
  const edit = vi.fn(async () => ({}));
  const channel = {
    id: CHANNEL,
    guildId: options.guildId ?? GUILD,
    isTextBased: () => true,
    isDMBased: () => false,
    send,
    messages: { edit },
  };
  const client = {
    isReady: () => options.ready ?? true,
    channels: { fetch: async () => channel },
  } as unknown as Client;
  const rows = new Map<string, NotificationThreadMessage>();
  const repo: NotificationThreadRepo = {
    find: async (id) => {
      if (options.storeThrows === true) throw new Error('driver bug');
      return ok(rows.get(id.threadKey));
    },
    save: async (id, message) => {
      rows.set(id.threadKey, message);
      return ok(undefined);
    },
  };

  const container = createContainer();
  container.registerSingleton(TOKENS.DiscordClient, () => client);
  const logger = silentLogger();
  const lines: unknown[][] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  const ctx = buildPluginContext({ logger, resolve: container.resolve.bind(container) });
  const plugin = createNotificationRelayPlugin(
    { botId: 'konata', port: 0, apiKey: KEY, routes: ROUTES },
    { store: async () => repo },
  );
  await plugin.start?.(ctx);
  shutdown = async () => {
    await plugin.onShutdown?.(ctx);
  };
  const logLines = (): string => JSON.stringify(lines);
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(logLines())?.[1];
  if (port === undefined) throw new Error('listen log line not found');
  return { base: `http://127.0.0.1:${port}`, send, edit, logLines };
};

const put = (
  h: Harness,
  path: string,
  body: unknown = BODY,
  /** `null` sends no `Authorization` header. */
  auth: string | null = `Bearer ${KEY}`,
): Promise<Response> =>
  fetch(`${h.base}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(auth === null ? {} : { authorization: auth }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const DEPLOY = '/notifications/card-together-deploy/b5ffd42abc12-1760500000';

describe('notification relay HTTP API', () => {
  it('posts on the first PUT and edits the same message on the next', async () => {
    const h = await start();

    const first = await put(h, DEPLOY);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ messageId: 'message-1', created: true });

    const second = await put(h, DEPLOY, { ...BODY, status: 'succeeded', summary: 'Took 2m' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ messageId: 'message-1', created: false });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.edit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing header', null],
    ['a wrong token', 'Bearer wrong-token-wrong-token-wrong-token'],
    ['another scheme', `Basic ${KEY}`],
  ])('answers 401 to %s before looking at anything else', async (_label, auth) => {
    const h = await start();

    for (const path of [DEPLOY, '/notifications/unknown-route/k', '/notifications/x/bad key!']) {
      const res = await put(h, path, '{not json', auth);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('unknown');
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logLines()).not.toContain(KEY);
  });

  it('answers 404 for route names that cannot exist, even without a token', async () => {
    const h = await start();

    expect((await put(h, '/notifications/Bad_Route/k', BODY, null)).status).toBe(404);
    expect((await put(h, '/elsewhere', BODY, null)).status).toBe(404);
  });

  it('answers 404 for an unknown route and 400 for a bad key once authorized', async () => {
    const h = await start();

    const unknown = await put(h, '/notifications/other-route/k');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown route' });

    const badKey = await put(h, `/notifications/card-together-deploy/${'k'.repeat(101)}`);
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toEqual({ error: 'invalid key' });
    expect((await put(h, '/notifications/card-together-deploy/a%20b')).status).toBe(400);
  });

  it('rejects unknown fields, invalid values and malformed JSON with 400', async () => {
    const h = await start();

    const unknownField = await put(h, DEPLOY, { ...BODY, mention: '@everyone' });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toEqual({ error: 'invalid body', fields: ['(root)'] });

    const badState = await put(h, DEPLOY, { ...BODY, stages: [{ label: 'a', state: 'x' }] });
    expect(await badState.json()).toEqual({ error: 'invalid body', fields: ['stages.0.state'] });

    expect((await put(h, DEPLOY, '{not json')).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('answers 413 to a body over 16 KB', async () => {
    const h = await start();

    const res = await put(h, DEPLOY, { ...BODY, description: 'x'.repeat(17 * 1024) });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body too large' });
  });

  it('answers 503 until the Discord client is ready', async () => {
    const h = await start({ ready: false });

    const res = await put(h, DEPLOY);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'discord client not ready' });
  });

  it('answers 500 when the route channel belongs to another guild', async () => {
    const h = await start({ guildId: '999999999999999999' });

    const res = await put(h, DEPLOY);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'route misconfigured' });
  });

  it('answers 502 when Discord rejects the message', async () => {
    const h = await start();
    h.send.mockRejectedValueOnce(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

    const res = await put(h, DEPLOY);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'discord request failed' });
  });

  it('answers 500 without detail when delivery throws unexpectedly', async () => {
    const h = await start({ storeThrows: true });

    const res = await put(h, DEPLOY);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(h.send).not.toHaveBeenCalled();
  });
});
