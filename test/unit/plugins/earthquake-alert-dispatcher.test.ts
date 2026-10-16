/**
 * Early-warning delivery: a new quake posts to every guild with an
 * `earthquake` channel, pinging the role only from the configured local
 * intensity (default 4); updates
 * for the same quake edit those messages, and the first update to reach the
 * threshold pings once through a reply. Racing alerts are serialized, a
 * deleted message is posted anew, and per-guild failures stay isolated.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { RESTJSONErrorCodes, type Channel, type Client } from 'discord.js';

import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createFakeClock } from '../../../src/core/time';
import { EARTHQUAKE_REPORT_COLORS } from '../../../src/infra/discord/presentation-colors';
import {
  createAlertDispatcher,
  distanceKm,
  EVENT_WINDOW_MS,
} from '../../../src/plugins/earthquake/internal/alert-dispatcher';
import type {
  EarthquakeAlert,
  Intensity,
} from '../../../src/plugins/earthquake/internal/alert-request';
import { echoTranslatorWithParams } from '../../fixtures/discord/bot-fake';
import { spyLogger } from '../../fixtures/runtime';

const ALERT: EarthquakeAlert = {
  epicenterLat: 23.85,
  epicenterLon: 120.82,
  depthKm: 10,
  magnitude: 5.1,
  maxIntensity: '4',
  localIntensity: '3',
  arrivalTime: 1_800_000_000,
  remainingSeconds: 20,
};

interface FakeMessage {
  readonly edit: Mock;
  readonly reply: Mock;
}

interface FakeGuild {
  readonly send: Mock;
  readonly messages: FakeMessage[];
}

const buildGuildChannel = (): { channel: Channel; guild: FakeGuild } => {
  const messages: FakeMessage[] = [];
  const send = vi.fn(async () => {
    const message = { edit: vi.fn(async () => ({})), reply: vi.fn(async () => ({})) };
    messages.push(message);
    return message;
  });
  return {
    channel: { isSendable: () => true, send } as unknown as Channel,
    guild: { send, messages },
  };
};

interface Harness {
  readonly dispatcher: ReturnType<typeof createAlertDispatcher>;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly guilds: Record<string, FakeGuild>;
  readonly logger: ReturnType<typeof spyLogger>;
  readonly client: { ready: boolean };
}

/** Guild `a` has the channel and role, `b` the channel only, `c` neither. */
const setup = (pingThreshold: Intensity = '4'): Harness => {
  const a = buildGuildChannel();
  const b = buildGuildChannel();
  const channels: Record<string, Channel> = { a: a.channel, b: b.channel };
  const registry: Pick<GuildRegistry, 'getChannel' | 'getRole'> = {
    getChannel: (guildId) => channels[guildId],
    getRole: (guildId) => (guildId === 'a' ? ({ id: 'role-a' } as never) : undefined),
  };
  const clock = createFakeClock(1_800_000_000_000);
  const logger = spyLogger();
  const state = { ready: true };
  const client = {
    isReady: () => state.ready,
    guilds: { cache: new Map(['a', 'b', 'c'].map((id) => [id, { id }])) },
  } as unknown as Client;
  const dispatcher = createAlertDispatcher({
    client,
    registry,
    translator: echoTranslatorWithParams(),
    clock,
    logger,
    pingThreshold,
  });
  return { dispatcher, clock, logger, guilds: { a: a.guild, b: b.guild }, client: state };
};

const lastPayload = (mock: Mock): Record<string, unknown> =>
  mock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('distanceKm', () => {
  it('measures great-circle distance', () => {
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    // One degree of latitude is about 111 km.
    expect(distanceKm({ lat: 23, lon: 121 }, { lat: 24, lon: 121 })).toBeCloseTo(111.2, 0);
    expect(distanceKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })).toBeCloseTo(111.2, 0);
  });
});

describe('alert dispatcher', () => {
  it('posts a new quake to every guild with the channel and pings nobody below 4', async () => {
    const h = setup();

    const outcome = await h.dispatcher.dispatch(ALERT);

    expect(outcome).toEqual({ kind: 'delivered', created: true, pinged: false, guilds: 2 });
    for (const guild of Object.values(h.guilds)) {
      const payload = lastPayload(guild.send);
      expect(payload['allowedMentions']).toEqual({ parse: [] });
      expect(String(payload['content'])).not.toContain('<@&');
      expect(payload['embeds']).toHaveLength(1);
    }
  });

  it('pings only the role of guilds that configure one from local intensity 4', async () => {
    const h = setup();

    const outcome = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });

    expect(outcome).toEqual({ kind: 'delivered', created: true, pinged: true, guilds: 2 });
    const a = lastPayload(h.guilds['a']!.send);
    expect(a['allowedMentions']).toEqual({ roles: ['role-a'] });
    expect(String(a['content'])).toMatch(/^<@&role-a> /);
    expect(lastPayload(h.guilds['b']!.send)['allowedMentions']).toEqual({ parse: [] });
  });

  it('edits the same messages for an update of the same quake, without pinging', async () => {
    const h = setup();
    await h.dispatcher.dispatch({ ...ALERT, localIntensity: '5-' });
    h.clock.advance(30_000);

    const outcome = await h.dispatcher.dispatch({
      ...ALERT,
      epicenterLat: 24.1,
      localIntensity: '5+',
    });

    expect(outcome).toEqual({ kind: 'delivered', created: false, pinged: false, guilds: 2 });
    const a = h.guilds['a']!;
    expect(a.send).toHaveBeenCalledOnce();
    const edit = lastPayload(a.messages[0]!.edit);
    expect(edit['allowedMentions']).toEqual({ parse: [] });
    // The role stays in the text of a message that pinged, but the edit cannot ping.
    expect(String(edit['content'])).toMatch(/^<@&role-a> /);
    expect(JSON.stringify(edit['embeds'])).toContain('footer_updated');
    expect(a.messages[0]!.reply).not.toHaveBeenCalled();
  });

  it('pings once by reply when an update first reaches the threshold', async () => {
    const h = setup();
    await h.dispatcher.dispatch(ALERT);
    h.clock.advance(10_000);

    const first = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    h.clock.advance(10_000);
    const second = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '5-' });

    expect(first).toEqual({ kind: 'delivered', created: false, pinged: true, guilds: 2 });
    expect(second).toEqual({ kind: 'delivered', created: false, pinged: false, guilds: 2 });
    const message = h.guilds['a']!.messages[0]!;
    expect(message.reply).toHaveBeenCalledOnce();
    expect(lastPayload(message.reply)['allowedMentions']).toEqual({
      roles: ['role-a'],
      repliedUser: false,
    });
    expect(String(lastPayload(message.reply)['content'])).toMatch(/^<@&role-a> .*upgraded/);
    // The guild without a role is never pinged.
    expect(h.guilds['b']!.messages[0]!.reply).not.toHaveBeenCalled();
  });

  it.each([
    ['after the event window', EVENT_WINDOW_MS + 1, ALERT.epicenterLat],
    ['for an epicenter more than 100 km away', 1_000, ALERT.epicenterLat + 1],
  ])('starts a new event %s', async (_label, delay, lat) => {
    const h = setup();
    await h.dispatcher.dispatch(ALERT);
    h.clock.advance(delay);

    const outcome = await h.dispatcher.dispatch({ ...ALERT, epicenterLat: lat });

    expect(outcome).toMatchObject({ created: true });
    expect(h.guilds['a']!.send).toHaveBeenCalledTimes(2);
  });

  it('measures the window from the latest alert of the event', async () => {
    const h = setup();
    await h.dispatcher.dispatch(ALERT);
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(EVENT_WINDOW_MS - 1_000);
      await h.dispatcher.dispatch(ALERT);
    }
    expect(h.guilds['a']!.send).toHaveBeenCalledOnce();
  });

  it('serializes racing alerts so one quake posts once', async () => {
    const h = setup();

    const outcomes = await Promise.all([
      h.dispatcher.dispatch(ALERT),
      h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' }),
    ]);

    expect(outcomes.map((o) => o.kind === 'delivered' && o.created)).toEqual([true, false]);
    expect(h.guilds['a']!.send).toHaveBeenCalledOnce();
    expect(h.guilds['a']!.messages[0]!.reply).toHaveBeenCalledOnce();
  });

  it('posts anew for a guild whose alert message was deleted', async () => {
    const h = setup();
    await h.dispatcher.dispatch(ALERT);
    h.guilds['a']!.messages[0]!.edit.mockRejectedValueOnce(
      Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage }),
    );

    const outcome = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });

    expect(outcome).toEqual({ kind: 'delivered', created: false, pinged: true, guilds: 2 });
    // The new post carries the ping itself instead of a reply.
    expect(h.guilds['a']!.send).toHaveBeenCalledTimes(2);
    expect(lastPayload(h.guilds['a']!.send)['allowedMentions']).toEqual({ roles: ['role-a'] });
    expect(h.guilds['a']!.messages[0]!.reply).not.toHaveBeenCalled();

    // Later updates edit the replacement.
    await h.dispatcher.dispatch(ALERT);
    expect(h.guilds['a']!.messages[1]!.edit).toHaveBeenCalledOnce();
  });

  it('does not repost when an edit fails for another reason', async () => {
    const h = setup();
    await h.dispatcher.dispatch(ALERT);
    h.guilds['a']!.messages[0]!.edit.mockRejectedValueOnce(new Error('Missing Access'));

    const outcome = await h.dispatcher.dispatch(ALERT);

    expect(outcome).toMatchObject({ guilds: 1 });
    expect(h.guilds['a']!.send).toHaveBeenCalledOnce();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('isolates a guild that cannot be posted to', async () => {
    const h = setup();
    h.guilds['a']!.send.mockRejectedValueOnce(new Error('Missing Permissions'));

    const outcome = await h.dispatcher.dispatch(ALERT);

    expect(outcome).toEqual({ kind: 'delivered', created: true, pinged: false, guilds: 1 });
    expect(h.guilds['b']!.send).toHaveBeenCalledOnce();

    // The next update posts the guild that missed the first alert.
    await h.dispatcher.dispatch(ALERT);
    expect(h.guilds['a']!.send).toHaveBeenCalledTimes(2);
  });

  it('pings, colours and upgrades from a configured threshold of 5-', async () => {
    const h = setup('5-');

    const first = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '4' });
    expect(first).toEqual({ kind: 'delivered', created: true, pinged: false, guilds: 2 });
    const posted = lastPayload(h.guilds['a']!.send);
    expect(posted['allowedMentions']).toEqual({ parse: [] });
    expect(JSON.stringify(posted['embeds'])).toContain(
      `"color":${EARTHQUAKE_REPORT_COLORS.orange}`,
    );

    h.clock.advance(10_000);
    const upgraded = await h.dispatcher.dispatch({ ...ALERT, localIntensity: '5-' });

    expect(upgraded).toEqual({ kind: 'delivered', created: false, pinged: true, guilds: 2 });
    const message = h.guilds['a']!.messages[0]!;
    expect(message.reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(lastPayload(message.edit)['embeds'])).toContain(
      `"color":${EARTHQUAKE_REPORT_COLORS.red}`,
    );
  });

  it('reports a client that is not ready without touching any channel', async () => {
    const h = setup();
    h.client.ready = false;

    await expect(h.dispatcher.dispatch(ALERT)).resolves.toEqual({ kind: 'not_ready' });
    expect(h.guilds['a']!.send).not.toHaveBeenCalled();
  });
});
