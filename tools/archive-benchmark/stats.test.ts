import { describe, expect, it } from 'vitest';

import { snowflakeAt } from '../../src/persistence/repositories/archive-stats.pipelines';
import { statsChannels, statsMessages } from './stats';

describe('synthetic statistics dataset', () => {
  const sample = [...statsMessages({ messages: 5_000, days: 10 })];

  it('is deterministic and dates every message by its snowflake', () => {
    expect([...statsMessages({ messages: 5_000, days: 10 })]).toEqual(sample);
    expect(new Set(sample.map((message) => message._id)).size).toBe(sample.length);
    for (const message of sample) {
      const id = BigInt(message._id);
      expect(id >= snowflakeAt(message.createdTimestamp)).toBe(true);
      expect(id < snowflakeAt(message.createdTimestamp + 1)).toBe(true);
    }
  });

  it('mixes the message kinds the statistics count and exclude', () => {
    const count = (predicate: (message: (typeof sample)[number]) => boolean): number =>
      sample.filter(predicate).length;
    expect(count((message) => message.type === 19)).toBeGreaterThan(0);
    expect(count((message) => message.interactionMetadata !== undefined)).toBeGreaterThan(0);
    expect(
      count((message) => message.author?.bot === true && !message.interactionMetadata),
    ).toBeGreaterThan(0);
    expect(count((message) => (message.reactions?.length ?? 0) > 0)).toBeGreaterThan(0);
    expect(count((message) => message.content?.includes('<:e:') === true)).toBeGreaterThan(0);
  });

  it('places threads under text channels and posts under forums', () => {
    const channels = statsChannels();
    const byId = new Map(channels.map((channel) => [channel.channelId, channel]));
    for (const channel of channels.filter((entry) => entry.type === 11))
      expect([0, 15]).toContain(byId.get(channel.parentId ?? '')?.type);
    expect(new Set(sample.map((message) => message.channelId)).size).toBeGreaterThan(1);
  });
});
