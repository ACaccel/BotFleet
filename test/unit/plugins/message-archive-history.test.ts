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
import { ArchiveBackpressureError, ArchiveCapacityError } from '../../../src/core/archive/errors';

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
  const get = vi.fn(async (_route: string) => [] as Record<string, unknown>[]);
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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = () =>
    scanArchiveHistory({ id: 'guild' } as Guild, client, logger as unknown as Logger, hooks);
  return { run, hooks, get, consume, progress, checkpoints, signal, client, logger };
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
    expect(result.issues).toEqual([
      expect.stringMatching(/^10: Error: membership not complete \[trace [0-9a-f]{8}\]$/),
    ]);
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

describe('history scan source order', () => {
  it('dispatches each sweep in the order hook returns, without the sources it completed', async () => {
    const f = fixture(['10', '20', '30']);
    vi.mocked(collectChannels)
      .mockResolvedValueOnce({
        channels: [channel('10'), channel('20'), channel('30')],
        gaps: [],
        liveChannelIds: new Set(['10', '20', '30']),
      } as any)
      .mockResolvedValueOnce({
        channels: [channel('10'), channel('20'), channel('30'), channel('40')],
        gaps: [],
        liveChannelIds: new Set(['10', '20', '30', '40']),
      } as any);
    const order = vi.fn(async (channels: readonly { id: string }[]) => [...channels].reverse());
    f.hooks.order = order as unknown as HistoryHooks['order'];
    await f.run();
    expect(order.mock.calls.map(([channels]) => channels.map(({ id }) => id))).toEqual([
      ['10', '20', '30'],
      ['40'],
    ]);
    const routes = (f.get.mock.calls as unknown as [string][]).map(([route]) => route);
    expect(routes).toEqual([
      '/channels/30/messages',
      '/channels/20/messages',
      '/channels/10/messages',
      '/channels/40/messages',
    ]);
  });

  it('keeps discovery order when the order hook rejects or drops a source', async () => {
    for (const order of [
      async () => {
        throw new Error('estimate failed');
      },
      async (channels: readonly { id: string }[]) => channels.slice(1).reverse(),
      async (channels: readonly { id: string }[]) => [channels[1], channels[1], channels[0]],
    ]) {
      const f = fixture(['10', '20', '30']);
      const warn = vi.fn();
      f.hooks.order = order as unknown as HistoryHooks['order'];
      await scanArchiveHistory(
        { id: 'guild' } as Guild,
        f.client,
        { warn } as unknown as Logger,
        f.hooks,
      );
      const routes = (f.get.mock.calls as unknown as [string][]).map(([route]) => route);
      expect(routes.slice(0, 3)).toEqual([
        '/channels/10/messages',
        '/channels/20/messages',
        '/channels/30/messages',
      ]);
      expect(warn).toHaveBeenCalled();
    }
  });
});

describe('failed source handling', () => {
  const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
  const routes = (get: { mock: { calls: unknown[][] } }) =>
    (get.mock.calls as unknown as [string][]).map(([route]) => route);
  const quickRetry = { attempts: 3, baseMs: 5, maxMs: 20 };

  it('logs a failed source with its step and a trace ID', async () => {
    const f = fixture();
    f.get.mockResolvedValue([{ id: '101' }]);
    f.consume.mockRejectedValue(new Error('membership not complete'));
    await f.run();
    expect(f.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 'guild',
        channelId: '10',
        step: 'processing',
        failure: 'defect',
        traceId: expect.stringMatching(/^[0-9a-f]{8}$/),
        err: expect.any(Error),
      }),
      'Archive source failed',
    );
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it('retries a transient failure in the same sweep while other sources keep the worker', async () => {
    const f = fixture(['10', '20']);
    f.hooks.sourceRetry = quickRetry;
    let failed = false;
    f.get.mockImplementation(async (route: string) => {
      if (route === '/channels/10/messages' && !failed) {
        failed = true;
        throw unavailable();
      }
      return [{ id: '101' }];
    });
    const result = await f.run();
    // One reader: source 20 runs while 10 waits, and 10 completes before the sweep ends.
    expect(routes(f.get)).toEqual([
      '/channels/10/messages',
      '/channels/20/messages',
      '/channels/10/messages',
    ]);
    expect(result.channels).toBe(2);
    expect(result.issues).toEqual([]);
    expect(f.checkpoints.get('10')?.complete).toBe(true);
    const warned = f.logger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(warned).toMatchObject({
      channelId: '10',
      step: 'fetching',
      failure: 'transient',
      attempt: 1,
      retryInMs: 5,
    });
    expect(f.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '10', attempts: 2, traceId: warned.traceId }),
      'Archive source recovered after a failed attempt',
    );
  });

  it('retries a backpressure failure from the page consumer', async () => {
    const f = fixture();
    f.hooks.sourceRetry = quickRetry;
    f.get.mockResolvedValue([{ id: '101' }]);
    f.consume.mockRejectedValueOnce(new ArchiveBackpressureError('archive-pipeline-queue-full'));
    const failed = vi.fn();
    f.hooks.failed = failed;
    const result = await f.run();
    expect(result.issues).toEqual([]);
    expect(f.checkpoints.get('10')?.complete).toBe(true);
    // The failed page is fetched again from the unchanged checkpoint.
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '10', failure: 'transient', retryInMs: 5 }),
      'Archive source failed; retrying from its checkpoint',
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it('fails a source that keeps failing transiently after the attempt budget of each sweep', async () => {
    const f = fixture();
    f.hooks.sourceRetry = quickRetry;
    const failed = vi.fn();
    f.hooks.failed = failed;
    f.get.mockRejectedValue(unavailable());
    const result = await f.run();
    // Three attempts in discovery and three in verification.
    expect(f.get).toHaveBeenCalledTimes(6);
    expect(f.checkpoints.get('10')?.complete).toBe(false);
    expect(f.logger.warn).toHaveBeenCalledTimes(4);
    expect(f.logger.error).toHaveBeenCalledTimes(2);
    expect(f.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '10', failure: 'transient', sweepAttempt: 3 }),
      'Archive source failed',
    );
    expect(failed).toHaveBeenCalledTimes(2);
    const traceIds = new Set(
      [...f.logger.warn.mock.calls, ...f.logger.error.mock.calls].map(
        ([fields]) => (fields as { traceId: string }).traceId,
      ),
    );
    expect(traceIds.size).toBe(1);
    // The issue names the trace of its log lines.
    expect(result.issues).toEqual([`10: Error: Service Unavailable [trace ${[...traceIds][0]}]`]);
  });

  it('does not retry a defect in the same sweep, and drops its issue once verification completes it', async () => {
    const f = fixture();
    f.hooks.sourceRetry = quickRetry;
    f.get.mockResolvedValueOnce([{ id: '101' }, { id: '101' }]).mockResolvedValue([{ id: '101' }]);
    const result = await f.run();
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(result.channels).toBe(1);
    expect(result.issues).toEqual([]);
    expect(f.checkpoints.get('10')?.complete).toBe(true);
  });

  it('drops a source waiting for its retry when the scan stops', async () => {
    const f = fixture(['10', '20']);
    f.hooks.sourceRetry = { attempts: 5, baseMs: 60_000, maxMs: 60_000 };
    f.get.mockImplementation(async (route: string) => {
      if (route === '/channels/10/messages') throw unavailable();
      f.signal.abort();
      return [{ id: '101' }];
    });
    const started = Date.now();
    const result = await f.run();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(routes(f.get).filter((route) => route.includes('/10/'))).toHaveLength(1);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/^10: Error: Service Unavailable \[trace /)]),
    );
    expect(f.logger.error).not.toHaveBeenCalled();
  });

  it('keeps a blocking issue without a trace for a source interrupted by a stop', async () => {
    const f = fixture();
    f.get.mockImplementation(async () => {
      f.signal.abort();
      throw new Error('Archive scan cancelled');
    });
    const failed = vi.fn();
    f.hooks.failed = failed;
    const result = await f.run();
    expect(result.issues).toEqual(['10: Error: Archive scan cancelled']);
    expect(failed).toHaveBeenCalledWith('Error: Archive scan cancelled');
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
  });

  it('keeps the issue of a source that never completes while another source recovers', async () => {
    const f = fixture(['10', '20']);
    f.hooks.concurrency = 2;
    f.hooks.sourceRetry = quickRetry;
    let reads10 = 0;
    f.get.mockImplementation(async (route: string) => {
      if (route === '/channels/10/messages') {
        reads10 += 1;
        return [{ id: '101' }, { id: '101' }];
      }
      // 20 completes only after 10 failed in the verification sweep, its last attempt.
      if (reads10 < 2) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      return [{ id: '201' }];
    });
    const result = await f.run();
    expect(reads10).toBe(2);
    expect(result.issues).toEqual([
      expect.stringMatching(/^10: Error: Duplicate history message id \[trace /),
    ]);
    expect(result.channels).toBe(1);
    expect(f.checkpoints.get('20')?.complete).toBe(true);
    expect(f.checkpoints.get('10')?.complete).toBe(false);
  });

  it.each([
    {
      failure: 'capacity',
      error: () => new ArchiveCapacityError('Archive backfill paused: storage headroom exhausted'),
    },
    {
      failure: 'inaccessible',
      error: () => Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }),
    },
  ])('does not retry a $failure failure in the same sweep', async ({ failure, error }) => {
    const f = fixture();
    f.hooks.sourceRetry = quickRetry;
    f.get.mockRejectedValue(error());
    await f.run();
    // Once per sweep: discovery and verification.
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failure, sweepAttempt: 1 }),
      'Archive source failed',
    );
    expect(f.logger.warn.mock.calls.some(([fields]) => 'retryInMs' in (fields as object))).toBe(
      false,
    );
  });

  it('turns a lost source into a known gap once verification confirms it', async () => {
    const f = fixture();
    vi.mocked(collectChannels)
      .mockResolvedValueOnce({
        channels: [channel('10')],
        gaps: [],
        liveChannelIds: new Set(['10']),
      } as any)
      .mockResolvedValueOnce({
        channels: [],
        locations: [{ id: '10', type: ChannelType.GuildText }],
        gaps: [{ pass: 'history', channelId: '10', reason: 'missing-view-channel' }],
      } as any);
    f.get.mockRejectedValue(
      Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }),
    );
    const result = await f.run();
    expect(result.issues).toEqual([]);
    expect(result.gaps).toEqual(['10: missing-view-channel']);
  });

  it('keeps a lost source blocking when verification still reads it', async () => {
    const f = fixture();
    vi.mocked(collectChannels).mockResolvedValue({
      channels: [channel('10')],
      gaps: [
        { pass: 'private', channelId: '10', reason: 'DiscordAPIError[50001]', forbidden: true },
      ],
      liveChannelIds: new Set(['10']),
    } as any);
    f.get.mockRejectedValue(
      Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }),
    );
    const result = await f.run();
    expect(result.issues).toEqual([expect.stringMatching(/^10: Error: Missing Access \[trace /)]);
  });

  it('turns a deleted source into a known deletion once verification confirms it', async () => {
    const f = fixture();
    f.hooks.knownChannelIds = ['10'];
    vi.mocked(collectChannels)
      .mockResolvedValueOnce({
        channels: [channel('10')],
        gaps: [],
        liveChannelIds: new Set(['10']),
      } as any)
      .mockResolvedValueOnce({ channels: [], gaps: [], liveChannelIds: new Set() } as any);
    vi.mocked(f.client.channels.fetch).mockRejectedValue({ code: 10003, status: 404 });
    f.get.mockRejectedValue(
      Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 }),
    );
    const result = await f.run();
    expect(result.issues).toEqual([]);
  });
});
