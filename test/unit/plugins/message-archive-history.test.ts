import { ChannelType, type Client, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger';
import { collectChannels } from '../../../src/plugins/message-backup/internal/collect-channels';
import type { ArchiveHistoryCheckpoint as HistoryCheckpoint } from '../../../src/core/archive/types';
import {
  scanArchiveHistory,
  type HistoryHooks,
} from '../../../src/plugins/message-backup/runtime/history-scan';
import { historyBefore } from '../../../src/plugins/message-backup/flow/history-boundary';
import { ArchivePipelineBudget } from '../../../src/plugins/message-backup/flow/pipeline';

vi.mock('../../../src/plugins/message-backup/internal/collect-channels', () => ({
  collectChannels: vi.fn(),
}));
const channel = (id: string) => ({ id, name: id, parentId: null, type: ChannelType.GuildText });
function fixture(ids = ['10']) {
  const checkpoints = new Map<string, HistoryCheckpoint>();
  const inventory = ids.map(channel);
  vi.mocked(collectChannels).mockResolvedValue({
    channels: inventory,
    gaps: [],
    liveChannelIds: new Set(ids),
  } as any);
  const get = vi.fn(async () => [] as Record<string, unknown>[]);
  const client = {
    rest: { get },
    channels: { fetch: vi.fn(async () => null) },
  } as unknown as Client;
  const signal = new AbortController();
  const consume = vi.fn(async () => undefined);
  const progress = vi.fn(async () => undefined);
  const hooks: { -readonly [P in keyof HistoryHooks]: HistoryHooks[P] } = {
    runId: 'run',
    cutoff: new Date('2026-01-01').getTime(),
    full: true,
    overlapMinutes: 60,
    concurrency: 1,
    signal: signal.signal,
    load: async (id) => ({ checkpoint: checkpoints.get(id) }),
    checkpoint: async (ch, value) => {
      checkpoints.set(ch.id, structuredClone(value));
    },
    consume,
    afterPage: async () => undefined,
    request: async (_key, read) => read(),
    progress,
  };
  const run = () => scanArchiveHistory({ id: 'guild' } as Guild, client, {} as Logger, hooks);
  return { run, hooks, get, consume, progress, checkpoints, signal, client };
}

describe('shared bounded history scan', () => {
  it('runs initial and final inventory, scans newly discovered threads to fixed cutoff', async () => {
    const f = fixture();
    vi.mocked(collectChannels)
      .mockResolvedValueOnce({
        channels: [channel('10')],
        gaps: [],
        liveChannelIds: new Set(['10']),
      } as any)
      .mockResolvedValueOnce({
        channels: [channel('10'), channel('20')],
        gaps: [],
        liveChannelIds: new Set(['10', '20']),
      } as any);
    f.get.mockResolvedValue([{ id: '101' }]);
    const result = await f.run();
    expect(result.channels).toBe(2);
    expect(result.scanned).toBe(2);
    expect(f.get).toHaveBeenCalledTimes(2);
    for (const call of f.get.mock.calls as unknown as [string, { query: URLSearchParams }][])
      expect(call[1].query.get('before')).toBe(historyBefore(new Date(f.hooks.cutoff)));
    expect(collectChannels).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      request: expect.any(Function),
      concurrency: f.hooks.concurrency,
      signal: f.hooks.signal,
    });
  });
  it('does not advance past failed writes/memberships and resumes the same page', async () => {
    const f = fixture();
    f.get.mockResolvedValue([{ id: '101' }]);
    f.consume.mockRejectedValue(new Error('membership not complete'));
    const result = await f.run();
    expect(result.issues).toContain('10: Error: membership not complete');
    expect(f.checkpoints.get('10')?.complete).toBe(false);
    expect(f.checkpoints.get('10')?.before).toBe(historyBefore(new Date(f.hooks.cutoff)));
    expect(f.progress).not.toHaveBeenCalled();
  });
  it('stops admitting later channels after per-job cancellation', async () => {
    const f = fixture(['10', '20', '30']);
    f.get.mockResolvedValue([{ id: '101' }]);
    (f.hooks as { afterPage: () => Promise<void> }).afterPage = async () => {
      if (f.consume.mock.calls.length > 0) {
        f.signal.abort();
        throw new Error('cancelled');
      }
    };
    const result = await f.run();
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(result.channels).toBe(0);
    expect(f.checkpoints.has('20')).toBe(false);
  });
  it('keeps resume bounds and monotonically acknowledges the next page sequence', async () => {
    const f = fixture();
    f.checkpoints.set('10', {
      runId: 'run',
      cutoff: f.hooks.cutoff,
      before: '200',
      complete: false,
      scanned: 100,
      pageSequence: 5,
      startedAt: 100,
    });
    f.get.mockResolvedValue([{ id: '101' }]);
    await f.run();
    expect(
      (f.get.mock.calls[0] as unknown as [string, { query: URLSearchParams }])[1].query.get(
        'before',
      ),
    ).toBe('200');
    expect(f.checkpoints.get('10')?.scanned).toBe(101);
    expect(f.checkpoints.get('10')?.pageSequence).toBe(6);
  });
  it('checks cancellation before initial discovery without aborting the shared client', async () => {
    const f = fixture();
    vi.mocked(collectChannels).mockClear();
    (f.hooks as { afterPage: () => Promise<void> }).afterPage = async () => {
      f.signal.abort();
      throw new Error('cancelled');
    };
    const result = await f.run();
    expect(result.channels).toBe(0);
    expect(collectChannels).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
});

describe('historical location reconciliation', () => {
  it('recovers a known archived thread omitted by fresh inventories and preserves its checkpoint', async () => {
    const f = fixture();
    const restored = {
      ...channel('20'),
      type: ChannelType.PrivateThread,
      guild: { id: 'guild', members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: vi.fn() },
    };
    vi.mocked(f.client.channels.fetch).mockResolvedValue(restored as any);
    f.hooks.knownChannelIds = ['20'];
    const revalidated = vi.fn(async () => undefined);
    f.hooks.revalidated = revalidated;
    f.get.mockResolvedValue([{ id: '101' }]);
    const result = await f.run();
    expect(result.channels).toBe(2);
    expect(result.issues).toEqual([]);
    expect(revalidated).toHaveBeenCalledWith('20', 'readable', restored);
    expect(f.checkpoints.get('20')?.complete).toBe(true);
  });
  it.each([
    { code: 10003, access: 'deleted', issue: false, known: false },
    { code: 50001, status: 403, access: 'denied', issue: false, known: true },
    { code: 123, access: 'unknown', issue: true, known: false },
  ])(
    'distinguishes revalidation $access from unknown absence',
    async ({ code, status, access, issue, known }) => {
      const f = fixture();
      f.hooks.knownChannelIds = ['20'];
      vi.mocked(f.client.channels.fetch).mockRejectedValue({ code, status });
      const revalidated = vi.fn(async () => undefined);
      f.hooks.revalidated = revalidated;
      const result = await f.run();
      expect(result.issues.length > 0).toBe(issue);
      expect(result.gaps.length > 0).toBe(known);
      expect(revalidated).toHaveBeenCalledWith('20', access, undefined, expect.any(String));
      expect(f.checkpoints.has('20')).toBe(false);
    },
  );
  it.each([
    {
      name: 'an unsupported known channel type',
      type: 999,
      me: {},
      allowed: true,
      access: 'unknown',
      gap: '20: unsupported-known-channel-type',
    },
    {
      name: 'a known channel the bot cannot view',
      type: ChannelType.GuildVoice,
      me: {},
      allowed: false,
      access: 'denied',
      gap: '20: missing-view-channel',
      reason: 'missing-view-channel',
    },
    {
      name: 'an uncached bot member',
      type: ChannelType.GuildVoice,
      me: null,
      allowed: true,
      access: 'denied',
      issue: '20: bot-member-unavailable',
      reason: 'bot-member-unavailable',
    },
  ])('classifies $name during known-channel revalidation', async (row) => {
    const f = fixture();
    const known = {
      ...channel('20'),
      type: row.type,
      guild: { id: 'guild', members: { me: row.me } },
      permissionsFor: () => ({ has: () => row.allowed }),
      messages: { fetch: vi.fn() },
    };
    vi.mocked(f.client.channels.fetch).mockResolvedValue(known as any);
    f.hooks.knownChannelIds = ['20'];
    const revalidated = vi.fn(async () => undefined);
    f.hooks.revalidated = revalidated;
    const result = await f.run();
    expect(result.gaps).toEqual(row.gap === undefined ? [] : [row.gap]);
    expect(result.issues).toEqual(row.issue === undefined ? [] : [row.issue]);
    expect(revalidated).toHaveBeenCalledWith(
      '20',
      row.access,
      known,
      ...(row.reason === undefined ? [] : [row.reason]),
    );
    expect(f.checkpoints.has('20')).toBe(false);
  });
  it('persists inventory gaps without skipping successful locations', async () => {
    const f = fixture();
    vi.mocked(collectChannels).mockResolvedValue({
      channels: [channel('10')],
      locations: [{ id: '10', type: ChannelType.GuildText }],
      gaps: [{ pass: 'private', channelId: '10', reason: '403' }],
    } as any);
    const inventory = vi.fn(async () => undefined);
    f.hooks.inventory = inventory;
    const result = await f.run();
    expect(inventory).toHaveBeenCalledWith(
      [{ id: '10', type: ChannelType.GuildText }],
      [{ pass: 'private', channelId: '10', reason: '403' }],
      ['10'],
    );
    expect(result.channels).toBe(1);
    expect(result.issues).toEqual(['10: 403']);
    expect(result.gaps).toEqual([]);
  });
  it('reports permission and channel-type limits as known gaps instead of blocking issues', async () => {
    const f = fixture();
    vi.mocked(collectChannels).mockResolvedValue({
      channels: [channel('10')],
      locations: [{ id: '10', type: ChannelType.GuildText }],
      gaps: [
        { pass: 'history', channelId: '11', reason: 'missing-view-channel' },
        { pass: 'channels', channelId: '12', reason: 'unsupported-channel-type:999' },
        { pass: 'private', channelId: '10', reason: 'DiscordAPIError[50001]', forbidden: true },
        { pass: 'channels', reason: 'sdk-inventory:Error: offline' },
      ],
    } as any);
    const result = await f.run();
    expect(result.channels).toBe(1);
    expect(result.gaps).toEqual([
      '11: missing-view-channel',
      '12: unsupported-channel-type:999',
      '10: DiscordAPIError[50001]',
    ]);
    expect(result.issues).toEqual(['sdk-inventory:Error: offline']);
  });
  it('scans carried-over sources fully inside an incremental run', async () => {
    const f = fixture(['10', '20']);
    (f.hooks as { full: boolean }).full = false;
    f.hooks.fullChannelIds = ['20'];
    (f.hooks as { load: HistoryHooks['load'] }).load = async () => ({
      lastMessageId: '1000000000000000000',
    });
    await f.run();
    expect(f.checkpoints.get('10')?.lower).toBeDefined();
    expect(f.checkpoints.get('20')?.lower).toBeUndefined();
  });
  it('falls back to full history for a malformed legacy cursor', async () => {
    const f = fixture();
    (f.hooks as { full: boolean }).full = false;
    (f.hooks as { load: HistoryHooks['load'] }).load = async () => ({
      lastMessageId: 'not-a-snowflake',
    });
    f.get.mockResolvedValue([{ id: '101' }]);
    const result = await f.run();
    expect(result.issues).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(f.checkpoints.get('10')?.lower).toBeUndefined();
  });
});

it('separates scanned from policy-admitted work and retains both in the checkpoint', async () => {
  const f = fixture();
  f.get.mockResolvedValue([{ id: '102' }, { id: '101' }]);
  f.hooks.consume = async (raw) => raw.id === '101';
  await f.run();
  expect(f.checkpoints.get('10')?.scanned).toBe(2);
  expect(f.checkpoints.get('10')?.admitted).toBe(1);
  expect(f.checkpoints.get('10')?.pageAdmitted).toBe(1);
});

describe('speculative page barriers', () => {
  it('rejects duplicated source IDs before writes rather than inflating acknowledged counts', async () => {
    const f = fixture();
    f.get.mockResolvedValue([{ id: '101' }, { id: '101' }]);
    const result = await f.run();
    expect(result.scanned).toBe(0);
    expect(result.issues.some((issue) => issue.includes('Duplicate history message id'))).toBe(
      true,
    );
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.checkpoints.get('10')?.complete).toBe(false);
  });
  it('reclaims unused page capacity to prefetch during a slow consumer without advancing its checkpoint', async () => {
    const f = fixture();
    const budget = new ArchivePipelineBudget(16 * 1024 * 1024);
    f.hooks.pipelineBudget = budget;
    const first = Array.from({ length: 100 }, (_, index) => ({ id: String(200 - index) }));
    f.get.mockResolvedValueOnce(first).mockResolvedValueOnce([{ id: '100' }]);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.hooks.afterPage = vi.fn(async () => undefined);
    const consumePage = vi.fn(async (messages: readonly Record<string, unknown>[]) => {
      if (consumePage.mock.calls.length === 1) await blocked;
      return messages.map(() => true);
    });
    f.hooks.consumePage = consumePage;
    const run = f.run();
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
    expect(consumePage).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().reservedBytes).toBeLessThan(16 * 1024);
    expect(f.checkpoints.get('10')?.before).toBe(historyBefore(new Date(f.hooks.cutoff)));
    expect(f.checkpoints.get('10')?.pageSequence).toBe(0);
    expect(f.progress).not.toHaveBeenCalled();
    finish();
    expect((await run).scanned).toBe(101);
    expect(f.checkpoints.get('10')?.before).toBe('100');
    expect(f.checkpoints.get('10')?.pageSequence).toBe(2);
    // Two inventories, one initial channel boundary, and one boundary after each committed page.
    expect(f.hooks.afterPage).toHaveBeenCalledTimes(5);
    expect(budget.snapshot().reservedBytes).toBe(0);
    expect(f.consume).not.toHaveBeenCalled();
  });

  it('discards speculative pages after cancellation and preserves the predecessor for resume', async () => {
    const f = fixture();
    const budget = new ArchivePipelineBudget();
    f.hooks.pipelineBudget = budget;
    f.get
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => ({ id: String(200 - index) })),
      )
      .mockResolvedValueOnce([{ id: '100' }]);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.hooks.consumePage = async (messages) => {
      await blocked;
      return messages.map(() => true);
    };
    const run = f.run();
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
    f.signal.abort();
    finish();
    expect((await run).scanned).toBe(0);
    expect(f.checkpoints.get('10')?.before).toBe(historyBefore(new Date(f.hooks.cutoff)));
    expect(f.checkpoints.get('10')?.complete).toBe(false);
    expect(f.progress).not.toHaveBeenCalled();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('surfaces oversized returned pages as gaps and never acknowledges them', async () => {
    const f = fixture();
    const budget = new ArchivePipelineBudget();
    f.hooks.pipelineBudget = budget;
    f.get.mockResolvedValue([{ id: '101', content: 'x'.repeat(4 * 1024 * 1024) }]);
    const result = await f.run();
    expect(result.issues.some((issue) => issue.includes('byte budget'))).toBe(true);
    expect(result.scanned).toBe(0);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.checkpoints.get('10')?.complete).toBe(false);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('reports source completion from a restored complete checkpoint without another history request', async () => {
    const f = fixture();
    f.checkpoints.set('10', {
      runId: 'run',
      cutoff: f.hooks.cutoff,
      before: '100',
      complete: true,
    });
    const completed = vi.fn();
    f.hooks.completed = completed;
    await f.run();
    expect(completed).toHaveBeenCalledWith('10', expect.objectContaining({ complete: true }));
    expect(f.get).not.toHaveBeenCalled();
  });
});
