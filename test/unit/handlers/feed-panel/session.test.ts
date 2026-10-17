import { describe, expect, it } from 'vitest';
import {
  FeedPanelError,
  FeedPanelSessions,
  feedPanelId,
  feedPanelSessions,
  parseFeedPanelId,
} from '../../../../src/handlers/feed-panel/session';
import { actor } from './helpers';

const draft = () => ({
  kind: 'filter' as const,
  platformId: 'x',
  accounts: ['someone'],
  channelId: 'c-1',
  filter: { media: 'any' as const },
});

describe('private feed panel sessions', () => {
  it('expires at ten minutes and rejects an unbound message', () => {
    let now = 1000;
    const store = new FeedPanelSessions(() => now);
    const session = store.open(actor, draft());
    expect(session.expiresAt).toBe(now + 600000);
    expect(() => store.get(session.id, actor)).toThrow(FeedPanelError);
    session.messageId = actor.messageId;
    now += 599999;
    expect(store.get(session.id, actor)).toBe(session);
    now += 1;
    expect(() => store.get(session.id, actor)).toThrow('expired');
  });

  it.each(['applicationId', 'guildId', 'userId', 'messageId'] as const)(
    'binds the session to %s',
    (field) => {
      const store = new FeedPanelSessions();
      const session = store.open(actor, draft());
      session.messageId = actor.messageId;
      expect(() => store.get(session.id, { ...actor, [field]: 'other' })).toThrow('forbidden');
      expect(store.get(session.id, actor)).toBe(session);
    },
  );

  it('keeps a saving session locked even across expiry', () => {
    let now = 0;
    const store = new FeedPanelSessions(() => now);
    const session = store.open(actor, draft());
    session.messageId = actor.messageId;
    session.saving = true;
    now = 600000;
    expect(() => store.get(session.id, actor)).toThrow('busy');
    session.saving = false;
    expect(() => store.get(session.id, actor)).toThrow('expired');
  });

  it('releases capacity after cancellation or pruning', () => {
    let now = 0;
    const store = new FeedPanelSessions(() => now, 1);
    const first = store.open(actor, draft());
    expect(() => store.open(actor, draft())).toThrow('capacity');
    store.close(first.id);
    store.open(actor, draft());
    now = 600000;
    expect(store.open(actor, draft()).expiresAt).toBe(1200000);
  });

  it('isolates stores by bot instance', () => {
    const bot = {};
    expect(feedPanelSessions(bot)).toBe(feedPanelSessions(bot));
    expect(feedPanelSessions({})).not.toBe(feedPanelSessions(bot));
  });

  it('roundtrips bounded component and modal IDs', () => {
    expect(parseFeedPanelId(feedPanelId('abc_123-A', 'keyword_submit', 'nonce'))).toEqual({
      sessionId: 'abc_123-A',
      action: 'keyword_submit',
      detail: 'nonce',
    });
  });

  it.each([
    'wrong|abc|save|',
    'feed_panel||save|',
    'feed_panel|abc||',
    'feed_panel|abc|save|a|b',
    'feed_panel|a.b|save|',
    'feed_panel|abc|save|!',
    'feed_panel|' + 'a'.repeat(100) + '|save|',
  ])('refuses malformed custom ID %s', (raw) => {
    expect(parseFeedPanelId(raw)).toBeUndefined();
  });
});
