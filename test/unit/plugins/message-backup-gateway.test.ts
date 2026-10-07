import { describe, expect, it } from 'vitest';
import { ArchiveGatewayDecoder } from '../../../src/plugins/message-backup/runtime/gateway-event';

describe('archive raw event decoder', () => {
  it('preserves absent content and session-scoped identities', () => {
    const decoder = new ArchiveGatewayDecoder('process');
    decoder.decode({ t: 'READY', d: { session_id: 'session' } }, 0, 1);
    const event = decoder.decode(
      { t: 'MESSAGE_UPDATE', s: 2, d: { id: '1', guild_id: '2', channel_id: '3', embeds: [] } },
      0,
      5,
    )[0];
    expect(event?.raw).not.toHaveProperty('content');
    expect(event?.raw?.embeds).toEqual([]);
    expect(event?.eventId).toBe('session:00000000000000000002:MESSAGE_UPDATE');
  });
  it('emits uncached bulk tombstones without body and excludes DMs', () => {
    const decoder = new ArchiveGatewayDecoder('p');
    const events = decoder.decode(
      { t: 'MESSAGE_DELETE_BULK', s: 1, d: { guild_id: '2', channel_id: '3', ids: ['4', '5'] } },
      0,
      5,
    );
    expect(events.map((e) => e.messageId)).toEqual(['4', '5']);
    expect(events.every((e) => e.kind === 'delete' && e.raw === undefined)).toBe(true);
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
});
