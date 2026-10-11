import { describe, expect, it } from 'vitest';
import { FakeDiscordRest, fakeMessages, type FakeChannel } from './discord-fake';

const channels = new Map<string, FakeChannel>([
  ['100000000000000001', { id: '100000000000000001', name: 'a', bucketId: '100000000000000001' }],
  ['100000000000000002', { id: '100000000000000002', name: 'b', bucketId: '100000000000000001' }],
]);
const rest = () =>
  new FakeDiscordRest(
    channels,
    fakeMessages({
      channels: [{ id: '100000000000000001', messages: 3 }],
      reactionRate: 1,
      endAt: Date.UTC(2026, 0, 1),
    }),
    5,
  );
const history = (channelId: string) => `/channels/${channelId}/messages` as const;

describe('synthetic Discord REST', () => {
  it('runs one request at a time per route and shared channel handler, routes in parallel', async () => {
    const serial = rest();
    const before = new URLSearchParams({ before: '9'.repeat(19), limit: '100' });
    await Promise.all([
      serial.get(history('100000000000000001'), { query: before }),
      // A segment sharing the handler of the first channel waits for it.
      serial.get(history('100000000000000002'), { query: before }),
    ]);
    expect(serial.peakActive).toBe(1);
    const parallel = rest();
    const [page] = (await Promise.all([
      parallel.get(history('100000000000000001'), { query: before }),
      parallel.get('/channels/100000000000000001'),
    ])) as [{ id: string }[], unknown];
    expect(parallel.peakActive).toBe(2);
    expect(page).toHaveLength(3);
    expect(parallel.requests).toMatchObject({ messages: 1, channel: 1 });
  });
});
