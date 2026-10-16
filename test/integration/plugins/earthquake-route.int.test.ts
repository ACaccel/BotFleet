/**
 * HTTP contract of the earthquake alert API, driven through the plugin's real
 * `start` hook on an OS-assigned loopback port with a fake Discord client and
 * a fixed clock. `onShutdown` releases the socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Client } from 'discord.js';

import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { TOKENS } from '../../../src/bot/tokens';
import { createContainer } from '../../../src/core/ioc';
import { createFakeClock } from '../../../src/core/time';
import { createEarthquakePlugin } from '../../../src/plugins/earthquake';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

const KEY = 'e'.repeat(32);
const NOW_SECONDS = 1_800_000_000;

// A live alert; deliberately not the warning app's test-button values.
const BODY = {
  epicenterLat: 23.77,
  epicenterLon: 121.67,
  depthKm: 15.5,
  magnitude: 7.2,
  maxIntensity: '6+',
  localIntensity: '5-',
  arrivalTime: NOW_SECONDS + 18,
  remainingSeconds: 18,
};

/** What the app's test button sends: fixed values stamped with the current clock. */
const APP_TEST_BODY = {
  epicenterLat: 23.85,
  epicenterLon: 120.82,
  depthKm: 10,
  magnitude: 7.3,
  maxIntensity: '7',
  localIntensity: '5+',
  arrivalTime: NOW_SECONDS + 20,
  remainingSeconds: 20,
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

const start = async (options: { ready?: boolean; broken?: boolean } = {}): Promise<Harness> => {
  const edit = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({ edit, reply: vi.fn(async () => ({})) }));
  const channel = { isSendable: () => true, send } as unknown as Channel;
  const client = {
    isReady: () => options.ready ?? true,
    guilds: options.broken === true ? undefined : { cache: new Map([['g1', { id: 'g1' }]]) },
  } as unknown as Client;
  const registry = {
    getChannel: () => channel,
    getRole: () => ({ id: 'role-1' }),
  } as unknown as GuildRegistry;

  const container = createContainer();
  container.registerSingleton(TOKENS.DiscordClient, () => client);
  container.registerSingleton(TOKENS.GuildRegistry, () => registry);
  const logger = silentLogger();
  const lines: unknown[][] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  const ctx = buildPluginContext({
    logger,
    clock: createFakeClock(NOW_SECONDS * 1000),
    resolve: container.resolve.bind(container),
  });
  const plugin = createEarthquakePlugin({ alertPort: 0, alertKey: KEY });
  await plugin.start?.(ctx);
  shutdown = async () => {
    await plugin.onShutdown?.(ctx);
  };
  const logLines = (): string => JSON.stringify(lines);
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(logLines())?.[1];
  if (port === undefined) throw new Error('listen log line not found');
  return { base: `http://127.0.0.1:${port}`, send, edit, logLines };
};

const post = (
  h: Harness,
  body: unknown = BODY,
  /** `null` sends no `Authorization` header. */
  auth: string | null = `Bearer ${KEY}`,
  path = '/alerts',
): Promise<Response> =>
  fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth === null ? {} : { authorization: auth }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('earthquake alert HTTP API', () => {
  it('posts a live alert and edits it for an update of the same quake', async () => {
    const h = await start();

    const first = await post(h);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: 'created', pinged: true, guilds: 1 });

    const second = await post(h, { ...BODY, magnitude: 7.1, remainingSeconds: 15 });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ result: 'updated', pinged: false, guilds: 1 });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.edit).toHaveBeenCalledOnce();
    expect(h.logLines()).toContain('"result":"updated"');
  });

  it("acknowledges the app's test-button values as a test without posting", async () => {
    const h = await start();

    const res = await post(h, APP_TEST_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'test' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logLines()).toContain('"result":"test"');
  });

  it('posts an alert that differs from the test-button values in any field', async () => {
    const h = await start();

    const res = await post(h, { ...APP_TEST_BODY, remainingSeconds: 19 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'created' });
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('acknowledges an alert that arrived over 10 minutes ago as a replay without posting', async () => {
    const h = await start();

    const res = await post(h, { ...BODY, arrivalTime: 1_717_142_400 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'test' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logLines()).toContain('"result":"test"');
  });

  it('treats exactly 10 minutes either side as live', async () => {
    const h = await start();

    expect((await post(h, { ...BODY, arrivalTime: NOW_SECONDS - 600 })).status).toBe(200);
    expect((await post(h, { ...BODY, arrivalTime: NOW_SECONDS + 600 })).status).toBe(200);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('rejects an arrival time more than 10 minutes ahead', async () => {
    const h = await start();

    const res = await post(h, { ...BODY, arrivalTime: NOW_SECONDS + 601 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'arrival time out of range' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing header', null],
    ['a wrong token', `Bearer ${'w'.repeat(32)}`],
    ['another scheme', `Basic ${KEY}`],
  ])('answers 401 to %s before looking at anything else', async (_label, auth) => {
    const h = await start();

    for (const path of ['/alerts', '/discord/earthquake', '/elsewhere']) {
      const res = await post(h, '{not json', auth, path);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logLines()).not.toContain(KEY);
  });

  it('answers 404 to other paths once authorized', async () => {
    const h = await start();

    expect((await post(h, BODY, `Bearer ${KEY}`, '/discord/earthquake')).status).toBe(404);
    const get = await fetch(`${h.base}/alerts`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(get.status).toBe(404);
  });

  it('rejects unknown fields, invalid values and malformed JSON with 400', async () => {
    const h = await start();

    const unknownField = await post(h, { ...BODY, mention: '@everyone' });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toEqual({ error: 'invalid body', fields: ['(root)'] });

    const badValues = await post(h, {
      ...BODY,
      localIntensity: '5',
      epicenterLat: 91,
      depthKm: '10',
    });
    expect(await badValues.json()).toEqual({
      error: 'invalid body',
      fields: ['epicenterLat', 'depthKm', 'localIntensity'],
    });

    expect((await post(h, { ...BODY, arrivalTime: NOW_SECONDS + 0.5 })).status).toBe(400);
    expect((await post(h, '{not json')).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('answers 413 to a body over 4 KB', async () => {
    const h = await start();

    const res = await post(h, { ...BODY, padding: 'x'.repeat(5 * 1024) });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body too large' });
  });

  it('answers 503 until the Discord client is ready', async () => {
    const h = await start({ ready: false });

    const res = await post(h);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'discord client not ready' });
  });

  it('answers 500 without detail when delivery throws unexpectedly', async () => {
    const h = await start({ broken: true });

    const res = await post(h);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});
