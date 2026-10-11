import { describe, expect, it } from 'vitest';
import {
  ArchiveGatewayDecoder,
  type ArchiveGatewayEvent,
  type ArchiveInboxEvent,
} from '../../../src/plugins/message-backup/runtime/gateway-event';

const inbox = (events: readonly ArchiveGatewayEvent[]): ArchiveInboxEvent[] =>
  events.flatMap((event): ArchiveInboxEvent[] => {
    switch (event.kind) {
      case 'session':
      case 'discovery':
        return [];
      default:
        return [event];
    }
  });

describe('archive raw event decoder', () => {
  it('preserves absent content and session-scoped identities', () => {
    const decoder = new ArchiveGatewayDecoder('process');
    decoder.decode({ t: 'READY', d: { session_id: 'session' } }, 0, 1);
    const event = inbox(
      decoder.decode(
        { t: 'MESSAGE_UPDATE', s: 2, d: { id: '1', guild_id: '2', channel_id: '3', embeds: [] } },
        0,
        5,
      ),
    )[0];
    if (event?.kind !== 'snapshot') throw new Error('expected a snapshot event');
    expect(event.raw).not.toHaveProperty('content');
    expect(event.raw.embeds).toEqual([]);
    expect(event?.eventId).toBe('session:00000000000000000002:MESSAGE_UPDATE');
  });
  it('marks creations and names what a reaction or poll vote changed', () => {
    const decoder = new ArchiveGatewayDecoder('process');
    const base = { guild_id: '2', channel_id: '3' };
    const decode = (t: string, d: Record<string, unknown>) =>
      inbox(decoder.decode({ t, s: 1, d: { ...base, ...d } }, 0, 5))[0];
    expect(decode('MESSAGE_CREATE', { id: '1' })).toMatchObject({
      kind: 'snapshot',
      created: true,
    });
    expect(decode('MESSAGE_UPDATE', { id: '1' })).not.toHaveProperty('created');
    const target = (t: string, d: Record<string, unknown> = {}) => {
      const event = decode(t, { message_id: '1', ...d });
      if (event?.kind !== 'reaction') throw new Error('expected a reaction event');
      return event.target;
    };
    expect(
      target('MESSAGE_REACTION_ADD', { emoji: { id: null, name: '👍' }, type: 1, burst: false }),
    ).toEqual({ scope: 'emoji', emojiKey: '👍', type: 1 });
    expect(
      target('MESSAGE_REACTION_REMOVE', { emoji: { id: '9', name: 'x' }, burst: true }),
    ).toEqual({ scope: 'emoji', emojiKey: '9', type: 1 });
    expect(target('MESSAGE_REACTION_ADD', { emoji: { id: '9', name: 'x' } })).toEqual({
      scope: 'emoji',
      emojiKey: '9',
    });
    expect(target('MESSAGE_REACTION_REMOVE_EMOJI', { emoji: { name: '👍' }, type: 0 })).toEqual({
      scope: 'emoji',
      emojiKey: '👍',
    });
    expect(target('MESSAGE_REACTION_REMOVE_ALL')).toEqual({ scope: 'all' });
    expect(target('MESSAGE_REACTION_ADD', { emoji: {} })).toEqual({ scope: 'all' });
    expect(target('MESSAGE_POLL_VOTE_ADD', { answer_id: 1 })).toEqual({ scope: 'poll' });
  });
  it('emits uncached bulk tombstones without body and excludes DMs', () => {
    const decoder = new ArchiveGatewayDecoder('p');
    const events = inbox(
      decoder.decode(
        { t: 'MESSAGE_DELETE_BULK', s: 1, d: { guild_id: '2', channel_id: '3', ids: ['4', '5'] } },
        0,
        5,
      ),
    );
    expect(events.map((e) => (e.kind === 'gap' ? undefined : e.messageId))).toEqual(['4', '5']);
    expect(events.every((e) => e.kind === 'delete' && !('raw' in e))).toBe(true);
    expect(decoder.decode({ t: 'MESSAGE_CREATE', d: { id: '1', channel_id: '3' } }, 0, 5)).toEqual(
      [],
    );
  });
  it.each([
    'MESSAGE_REACTION_ADD',
    'MESSAGE_REACTION_REMOVE',
    'MESSAGE_REACTION_REMOVE_ALL',
    'MESSAGE_REACTION_REMOVE_EMOJI',
    'MESSAGE_POLL_VOTE_ADD',
    'MESSAGE_POLL_VOTE_REMOVE',
  ])('invalidates membership for %s', (t) => {
    expect(
      new ArchiveGatewayDecoder('p').decode(
        { t, s: 1, d: { guild_id: '2', channel_id: '3', message_id: '4' } },
        0,
        5,
      )[0]?.kind,
    ).toBe('reaction');
  });
  it.each([
    'CHANNEL_CREATE',
    'CHANNEL_UPDATE',
    'CHANNEL_DELETE',
    'THREAD_CREATE',
    'THREAD_UPDATE',
    'THREAD_DELETE',
  ])('reports %s as discovery for the changed channel, never as a gap', (t) => {
    expect(
      new ArchiveGatewayDecoder('p').decode(
        { t, s: 1, d: { id: '30', guild_id: '2', parent_id: '3', name: 'topic', type: 11 } },
        0,
        5,
      ),
    ).toEqual([
      {
        eventId: 'p:0:00000000000000000001:' + t,
        guildId: '2',
        channelId: '30',
        observedAt: 5,
        kind: 'discovery',
        change: t.endsWith('_DELETE') ? 'delete' : t.endsWith('_CREATE') ? 'create' : 'update',
        channel: { name: 'topic', type: 11, parentId: '3' },
      },
    ]);
  });
  it('drops channel events without a channel ID and message events without a channel', () => {
    const decoder = new ArchiveGatewayDecoder('p');
    expect(decoder.decode({ t: 'CHANNEL_DELETE', s: 1, d: { guild_id: '2' } }, 0, 5)).toEqual([]);
    expect(
      decoder.decode({ t: 'MESSAGE_DELETE', s: 2, d: { id: '9', guild_id: '2' } }, 0, 5),
    ).toEqual([]);
  });
  it('carries a cleared parent and omits channel details the event lacks', () => {
    const [moved] = new ArchiveGatewayDecoder('p').decode(
      { t: 'CHANNEL_UPDATE', s: 1, d: { id: '30', guild_id: '2', parent_id: null } },
      0,
      5,
    );
    expect(moved).toMatchObject({ change: 'update', channel: { parentId: null } });
    const [bare] = new ArchiveGatewayDecoder('p').decode(
      { t: 'CHANNEL_DELETE', s: 1, d: { id: '30', guild_id: '2' } },
      0,
      5,
    );
    expect(bare).toMatchObject({ change: 'delete', channel: {} });
  });
  it('reports a replaced session for each guild on that shard only, never as a gap', () => {
    const decoder = new ArchiveGatewayDecoder('p');
    const ready = (session: string, guilds: unknown[]) => ({
      t: 'READY',
      s: 1,
      d: { session_id: session, guilds },
    });
    // Without a seeded session the first one cannot be told apart from a replacement.
    expect(decoder.decode(ready('one', [{ id: '2' }]), 0, 1)).toEqual([
      {
        eventId: 'one:00000000000000000001:READY:2',
        guildId: '2',
        observedAt: 1,
        kind: 'session',
        unseeded: true,
      },
    ]);
    expect(decoder.decode(ready('other', [{ id: '4' }]), 1, 1)).toMatchObject([
      { guildId: '4', unseeded: true },
    ]);
    expect(decoder.decode({ t: 'RESUMED', s: 7, d: {} }, 0, 2)).toEqual([]);
    expect(decoder.decode(ready('one', [{ id: '2' }]), 0, 3)).toEqual([]);
    expect(
      decoder.decode(ready('two', [{ id: '2', unavailable: true }, { id: 3 }, null]), 0, 4),
    ).toEqual([
      {
        eventId: 'two:00000000000000000001:READY:2',
        guildId: '2',
        observedAt: 4,
        kind: 'session',
      },
    ]);
    expect(
      decoder.decode(
        { t: 'MESSAGE_DELETE', s: 2, d: { id: '9', guild_id: '2', channel_id: '3' } },
        0,
        5,
      )[0],
    ).toMatchObject({ eventId: 'two:00000000000000000002:MESSAGE_DELETE' });
    expect(decoder.decode(ready('three', [{ id: '4' }]), 1, 6)).toMatchObject([
      { guildId: '4', kind: 'session' },
    ]);
    expect(decoder.decode({ t: 'READY', s: 1, d: { guilds: [{ id: '2' }] } }, 0, 7)).toEqual([]);
  });
  it('recognizes the first decoded READY as a replacement of a seeded session', () => {
    const decoder = new ArchiveGatewayDecoder('p');
    // Login delivered the shard's first READY before the listener existed.
    decoder.seed(0, 'login');
    expect(
      decoder.decode({ t: 'READY', s: 1, d: { session_id: 'login', guilds: [{ id: '2' }] } }, 0, 1),
    ).toEqual([]);
    expect(
      decoder.decode({ t: 'READY', s: 1, d: { session_id: 'next', guilds: [{ id: '2' }] } }, 0, 2),
    ).toMatchObject([{ guildId: '2', kind: 'session' }]);
    // A later seed never overrides a decoded session.
    decoder.seed(0, 'stale');
    expect(
      decoder.decode({ t: 'READY', s: 1, d: { session_id: 'next', guilds: [{ id: '2' }] } }, 0, 3),
    ).toEqual([]);
  });
});
