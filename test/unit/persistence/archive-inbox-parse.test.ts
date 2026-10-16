/**
 * `parseInboxEntry`: the contract check a stored inbox event passes
 * before the reducer sees it. A failure must be an
 * `ArchiveInboxInvalidError` naming the event, because that is what the
 * worker dead-letters so the events behind it can proceed.
 */
import { describe, expect, it } from 'vitest';

import { ARCHIVE_SCHEMA_VERSION } from '../../../src/core/archive/types';
import {
  ArchiveInboxInvalidError,
  ArchiveInboxOversizedError,
  isArchiveInboxUnclaimable,
  parseInboxEntry,
  type RawInboxDocument,
} from '../../../src/persistence/repositories/archive-inbox.parse';

const MESSAGE_ID = '200000000000000001';
const CHANNEL_ID = '300000000000000001';

const event = (fields: Partial<RawInboxDocument> & Pick<RawInboxDocument, 'kind'>) =>
  ({
    eventId: 'evt-1',
    observedAt: 1_000,
    state: 'processing',
    attempts: 0,
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    payload: {},
    ...fields,
  }) satisfies RawInboxDocument;

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  _id: MESSAGE_ID,
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  channelId: CHANNEL_ID,
  createdTimestamp: 500,
  observedAt: 1_000,
  ...overrides,
});

/** The parser's rejection, so a test can assert both its type and its detail. */
const rejection = (document: RawInboxDocument): unknown => {
  try {
    parseInboxEntry(document);
  } catch (error) {
    return error;
  }
  throw new Error('expected parseInboxEntry to reject the document');
};

describe('parseInboxEntry', () => {
  it.each([
    ['a snapshot', event({ kind: 'snapshot', payload: { snapshot: snapshot() } })],
    [
      'a create snapshot with a channel hint',
      event({
        kind: 'snapshot',
        payload: { snapshot: snapshot(), channel: { name: 'general' }, create: true },
      }),
    ],
    ['a delete', event({ kind: 'delete' })],
    ['a reaction without a target', event({ kind: 'reaction' })],
    [
      'a reaction on every list',
      event({ kind: 'reaction', payload: { target: { scope: 'all' } } }),
    ],
    ['a poll vote', event({ kind: 'reaction', payload: { target: { scope: 'poll' } } })],
    [
      'a reaction on one emoji of one type',
      event({ kind: 'reaction', payload: { target: { scope: 'emoji', emojiKey: 'e', type: 1 } } }),
    ],
    ['a gap', event({ kind: 'gap', messageId: undefined, payload: { reason: 'restart' } })],
    ['a gap without a reason', event({ kind: 'gap', messageId: undefined })],
  ])('passes %s through unchanged', (_case, document) => {
    expect(parseInboxEntry(document)).toBe(document);
  });

  it.each([
    ['payload is not an object', event({ kind: 'delete', payload: null })],
    ['payload is not an object', event({ kind: 'delete', payload: [] })],
    ['snapshot identity or payload', event({ kind: 'snapshot', payload: {} })],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', payload: { snapshot: snapshot({ _id: '999' }) } }),
    ],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', payload: { snapshot: snapshot({ schemaVersion: 2 }) } }),
    ],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', payload: { snapshot: snapshot({ observedAt: '1000' }) } }),
    ],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', payload: { snapshot: snapshot(), create: false } }),
    ],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', payload: { snapshot: snapshot(), channel: 'general' } }),
    ],
    [
      'snapshot identity or payload',
      event({ kind: 'snapshot', channelId: 'general', payload: { snapshot: snapshot() } }),
    ],
    ['delete identity', event({ kind: 'delete', messageId: 'abc' })],
    ['delete identity', event({ kind: 'delete', channelId: undefined })],
    ['reaction identity', event({ kind: 'reaction', messageId: 42 })],
    ['reaction target', event({ kind: 'reaction', payload: { target: { scope: 'some' } } })],
    [
      'reaction target',
      event({ kind: 'reaction', payload: { target: { scope: 'emoji', emojiKey: '' } } }),
    ],
    [
      'reaction target',
      event({ kind: 'reaction', payload: { target: { scope: 'emoji', emojiKey: 'e', type: 2 } } }),
    ],
    ['reaction target', event({ kind: 'reaction', payload: { target: 'all' } })],
    ['gap reason', event({ kind: 'gap', payload: { reason: 7 } })],
    ['unknown kind edit', event({ kind: 'edit' })],
  ])('dead-letters an event whose %s', (detail, document) => {
    const error = rejection(document);

    expect(error).toBeInstanceOf(ArchiveInboxInvalidError);
    expect(error).toMatchObject({
      eventId: 'evt-1',
      message: `Archive inbox event is invalid: ${detail}`,
    });
    expect(isArchiveInboxUnclaimable(error)).toBe(true);
  });
});

describe('isArchiveInboxUnclaimable', () => {
  it('recognises both unclaimable kinds and nothing else', () => {
    const oversized = new ArchiveInboxOversizedError('evt-2');

    expect(isArchiveInboxUnclaimable(oversized)).toBe(true);
    expect(oversized.eventId).toBe('evt-2');
    expect(isArchiveInboxUnclaimable(new Error('Archive inbox event is invalid'))).toBe(false);
  });
});
