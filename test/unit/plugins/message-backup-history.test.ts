import type { Client, Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  incrementalLowerBound,
  scanArchiveHistory,
  type HistoryHooks,
} from '../../../src/plugins/message-backup/runtime/history-scan';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';
import { createLogger } from '../../../src/core/logger';
vi.mock('../../../src/plugins/message-backup/internal/collect-channels', () => ({
  collectChannels: vi.fn(),
}));
const channel = { id: '100', name: 'history' };
const hooks = (): HistoryHooks => ({
  runId: 'run',
  cutoff: 1700000000000,
  full: true,
  overlapMinutes: 60,
  concurrency: 2,
  signal: new AbortController().signal,
  load: vi.fn(async () => ({})),
  checkpoint: vi.fn(async () => {}),
  consume: vi.fn(async () => {}),
  afterPage: vi.fn(async () => {}),
  request: async (_key, operation) => operation(),
  progress: vi.fn(async () => {}),
});
const setup = () => {
  vi.mocked(collectChannels).mockResolvedValue({
    channels: [channel],
    liveChannelIds: new Set(['100']),
  } as unknown as Awaited<ReturnType<typeof collectChannels>>);
  const get = vi.fn(async () => [{ id: '101' }]);
  return {
    get,
    client: { rest: { get } } as unknown as Client,
    guild: {} as Guild,
    logger: createLogger({ level: 'silent', pretty: false }),
  };
};
describe('bounded archive history', () => {
  it('persists the fixed cutoff and acknowledges only consumed pages', async () => {
    const f = setup();
    const h = hooks();
    const result = await scanArchiveHistory(f.guild, f.client, f.logger, h);
    expect(result).toEqual({ scanned: 1, channels: 1, issues: [], gaps: [] });
    expect(h.checkpoint).toHaveBeenLastCalledWith(
      channel,
      expect.objectContaining({ cutoff: h.cutoff, complete: true, latest: '101' }),
    );
    expect(f.get.mock.calls).toHaveLength(1);
    expect(collectChannels).toHaveBeenCalled();
  });
  it('does not advance a page checkpoint when membership/persistence fails', async () => {
    const f = setup();
    const h = hooks();
    vi.mocked(h.consume).mockRejectedValue(new Error('membership unavailable'));
    const result = await scanArchiveHistory(f.guild, f.client, f.logger, h);
    expect(result.issues.join()).toContain('membership unavailable');
    for (const call of vi.mocked(h.checkpoint).mock.calls) expect(call[1].complete).toBe(false);
  });
  it('resumes with the original before cursor and rejects a changed cutoff', async () => {
    const f = setup();
    const h = hooks();
    vi.mocked(h.load).mockResolvedValue({
      checkpoint: { runId: h.runId, cutoff: h.cutoff - 1, before: '200', complete: false },
    });
    const result = await scanArchiveHistory(f.guild, f.client, f.logger, h);
    expect(result.issues.join()).toContain('cutoff mismatch');
    expect(f.get).not.toHaveBeenCalled();
  });
});

describe('incremental history lower bound', () => {
  const epoch = 1420070400000;
  const snowflakeAt = (timestamp: number) => (BigInt(timestamp - epoch) << 22n).toString();
  const watermarkAt = 1_700_000_000_000;
  const watermark = snowflakeAt(watermarkAt);
  const hour = 3_600_000;

  it('starts the overlap window before the watermark or an earlier rescan time', () => {
    expect(incrementalLowerBound(watermark, 60)).toBe(snowflakeAt(watermarkAt - hour));
    expect(incrementalLowerBound(watermark, 60, watermarkAt + hour)).toBe(
      snowflakeAt(watermarkAt - hour),
    );
    expect(incrementalLowerBound(watermark, 60, watermarkAt - 5 * hour)).toBe(
      snowflakeAt(watermarkAt - 6 * hour),
    );
  });

  it.each([
    { name: 'an incremental source', full: false, fullChannelIds: [], lower: true },
    { name: 'a carried full source', full: false, fullChannelIds: ['100'], lower: false },
    { name: 'a full run', full: true, fullChannelIds: [], lower: false },
  ])('applies the rescan bound to $name', async ({ full, fullChannelIds, lower }) => {
    const f = setup();
    const h = {
      ...hooks(),
      full,
      fullChannelIds,
      rescanFrom: watermarkAt - 5 * hour,
      load: vi.fn(async () => ({ lastMessageId: watermark })),
    };
    await scanArchiveHistory(f.guild, f.client, f.logger, h);
    const first = vi.mocked(h.checkpoint).mock.calls[0]?.[1];
    expect(first?.lower).toBe(lower ? snowflakeAt(watermarkAt - 6 * hour) : undefined);
  });
});
