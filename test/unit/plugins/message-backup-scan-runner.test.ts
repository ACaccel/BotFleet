import type { GuildBasedChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import type {
  ArchiveChannel,
  ArchiveFullBackupJob,
  ArchiveHistoryCheckpoint,
  ArchiveInboxEntry,
} from '../../../src/core/archive/types';
import { snowflakeTimestamp } from '../../../src/core/archive/normalize';
import { historyBefore } from '../../../src/plugins/message-backup/flow/history-boundary';
import { createLogger } from '../../../src/core/logger';
import type { ArchiveChannelRepo } from '../../../src/persistence/repositories/archive-channel.repo';
import type { ArchiveInboxBacklog } from '../../../src/persistence/repositories/archive-inbox.repo';
import type { ArchiveWriterRepos } from '../../../src/persistence/repositories/archive-repos';
import type {
  StoredSourceWork,
  StoredSourceWorkQuery,
} from '../../../src/persistence/repositories/archive.repo';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchiveRestTelemetry } from '../../../src/plugins/message-backup/flow/rest-telemetry';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import {
  scanArchiveHistory,
  type HistoryHooks,
} from '../../../src/plugins/message-backup/runtime/history-scan';
import { ProgressTracker } from '../../../src/plugins/message-backup/flow/progress';
import type {
  ScanMode,
  ScanRunnerDependencies,
} from '../../../src/plugins/message-backup/runtime/scan-contract';
import { ScanRunner } from '../../../src/plugins/message-backup/runtime/scan-runner';
import { ArchiveSerialWriter } from '../../../src/plugins/message-backup/runtime/serial-writer';
import { ArchiveWorkSlot } from '../../../src/plugins/message-backup/runtime/work-slot';
import {
  ArchiveWorkerContext,
  type ArchiveGuildState,
  type ArchiveWorkerOptions,
} from '../../../src/plugins/message-backup/runtime/worker-context';

vi.mock('../../../src/plugins/message-backup/runtime/history-scan', () => ({
  scanArchiveHistory: vi.fn(),
}));

type HistoryResult = Awaited<ReturnType<typeof scanArchiveHistory>>;

/** In-memory `archive_channels` and `fetches`, merging checkpoints per scan kind like Mongo. */
class FakeChannelRepo implements ArchiveChannelRepo {
  public readonly channels = new Map<string, ArchiveChannel>();
  public readonly cursors = new Map<string, string>();

  public async upsertChannel(channel: ArchiveChannel): Promise<void> {
    const before = this.channels.get(channel.channelId);
    const checkpoints = { ...before?.checkpoints, ...channel.checkpoints };
    const after: ArchiveChannel = {
      ...before,
      ...channel,
      ...(Object.keys(checkpoints).length === 0 ? {} : { checkpoints }),
    };
    if (channel.parentId === undefined) delete after.parentId;
    this.channels.set(channel.channelId, after);
  }
  public async recordChannel(update: Parameters<ArchiveChannelRepo['recordChannel']>[0]) {
    const { parentId, initialAccess, ...fields } = update;
    const before = this.channels.get(update.channelId);
    this.channels.set(update.channelId, {
      ...(before ?? { access: initialAccess ?? 'unknown' }),
      ...fields,
      ...(parentId === null || parentId === undefined ? {} : { parentId }),
    } as ArchiveChannel);
  }
  public async listChannels(): Promise<ArchiveChannel[]> {
    return [...this.channels.values()];
  }
  public async findChannel(channelId: string): Promise<ArchiveChannel | null> {
    return this.channels.get(channelId) ?? null;
  }
  public async channelAccess(channelId: string) {
    const channel = this.channels.get(channelId);
    return channel === undefined ? null : { access: channel.access };
  }
  public async channelParent(channelId: string) {
    const channel = this.channels.get(channelId);
    return channel === undefined ? null : { parentId: channel.parentId };
  }
  public async listChannelIds(): Promise<string[]> {
    return [...this.channels.keys()];
  }
  public async fetchChannelIds(): Promise<string[]> {
    return [...this.cursors.keys()];
  }
  public async fetchCursor(channelId: string): Promise<string | undefined> {
    return this.cursors.get(channelId);
  }
  public async advanceFetchCursor(channelId: string, _name: string, latest: string) {
    const old = this.cursors.get(channelId);
    if (old === undefined || BigInt(old) < BigInt(latest)) this.cursors.set(channelId, latest);
  }
}

/** The inbox, message and job reads a scan makes. */
interface FakeStores {
  readonly channels: FakeChannelRepo;
  backlog: ArchiveInboxBacklog;
  deadLetters: Pick<ArchiveInboxEntry, 'channelId'>[];
  stopRequested: boolean;
  messageChannelIds: string[];
  storedWork: StoredSourceWork[];
  storedQueries: StoredSourceWorkQuery[];
}

const CUTOFF = Date.parse('2026-01-01T00:00:00Z');
const channel = { id: '10', name: 'general', type: 0, parentId: null } as GuildBasedChannel;
/** A fetched source whose `@everyone` visibility cannot be told. */
const fetchedChannel = {
  ...channel,
  isThread: () => false,
  permissionsFor: () => null,
  guild: { roles: { everyone: {} } },
} as unknown as GuildBasedChannel;
const checkpoint = (
  runId: string,
  extra: Partial<ArchiveHistoryCheckpoint> = {},
): ArchiveHistoryCheckpoint => ({
  runId,
  cutoff: CUTOFF,
  before: '999',
  complete: true,
  scanned: 2,
  pageSequence: 1,
  latest: '500',
  ...extra,
});

const setup = () => {
  const stores: FakeStores = {
    channels: new FakeChannelRepo(),
    backlog: { pending: 0, live: 0 },
    deadLetters: [],
    stopRequested: false,
    messageChannelIds: [],
    storedWork: [],
    storedQueries: [],
  };
  // Only the reads a scan makes; the other repository methods are never reached.
  const repos = {
    channels: stores.channels,
    messages: {
      messageChannelIds: async () => stores.messageChannelIds,
      storedSourceWork: async (query: StoredSourceWorkQuery) => {
        stores.storedQueries.push(query);
        return stores.storedWork;
      },
    },
    inbox: {
      inboxBacklog: async () => stores.backlog,
      tracedDeadLetters: async () => stores.deadLetters,
    },
    jobs: {
      getJob: async (jobId: string) =>
        ({ jobId, cancelRequested: stores.stopRequested }) as ArchiveFullBackupJob,
    },
  } as unknown as ArchiveWriterRepos;
  // The fields a scan reads or writes; the rest of the guild state is never reached.
  const state = {
    conn: { guildId: '1' },
    repos,
    writer: new ArchiveSerialWriter(),
    storage: { withReservation: (_bytes: number, _bulk: boolean, run: () => unknown) => run() },
    signal: new AbortController(),
    continuity: { gapVersion: 0, breaks: [] },
    inbox: {},
    work: new ArchiveWorkSlot(),
  } as unknown as ArchiveGuildState;
  const options = {
    client: { guilds: { fetch: async () => ({ id: '1' }) } },
    logger: createLogger({ level: 'silent', pretty: false }),
    guildIds: ['1'],
    config: archiveRuntimeSchema.parse({}),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
  } as unknown as ArchiveWorkerOptions;
  const ctx = new ArchiveWorkerContext(
    options,
    new ArchiveScheduler({ concurrency: 1 }),
    new ArchiveRestTelemetry(Date.now, () => undefined),
    async () => state,
  );
  const deps = {
    continuity: { recordChannelBreak: vi.fn(async () => undefined) },
    locator: { locationVisibility: vi.fn(() => undefined) },
    ingestor: { ingest: vi.fn(async () => true), ingestPage: vi.fn() },
    observations: {
      read: async <T>(_state: ArchiveGuildState, operation: () => Promise<T>) => operation(),
    },
    progress: { notify: vi.fn(async () => undefined) },
    inbox: {
      beginPass: vi.fn(),
      drainInboxSafely: vi.fn(async () => undefined),
    },
  } satisfies ScanRunnerDependencies;
  const runner = new ScanRunner(ctx, deps);
  const scan = (mode: ScanMode, runId = mode.kind === 'periodic' ? 'periodic:1' : 'full:1') =>
    runner.scan(state, { runId, cutoff: CUTOFF, mode });
  return { stores, state, deps, runner, scan };
};

/** Replaces the history scan with `run`, which drives the hooks the runner passes. */
const history = (run: (hooks: HistoryHooks) => Promise<Partial<HistoryResult> | void>) => {
  vi.mocked(scanArchiveHistory).mockImplementation(async (_guild, _client, _logger, hooks) => ({
    scanned: 0,
    channels: 0,
    issues: [],
    gaps: [],
    ...(await run(hooks)),
  }));
};

const PERIODIC: ScanMode = { kind: 'periodic', full: false };
const FULL_PERIODIC: ScanMode = { kind: 'periodic', full: true };
const FULL_BACKUP: ScanMode = { kind: 'full-backup', jobId: '1:job' };
const general = { id: '10', type: 0, name: 'general' };
const readable = (access: ArchiveChannel['access'], extra: Partial<ArchiveChannel> = {}) => ({
  channelId: '10',
  name: 'general',
  type: 0,
  observedAt: 1,
  access,
  ...extra,
});

describe('ScanRunner', () => {
  beforeEach(() => {
    vi.mocked(scanArchiveHistory).mockReset();
  });

  it('completes a periodic scan, recording channels, checkpoints and the fetch cursor', async () => {
    const { stores, state, deps, scan } = setup();
    history(async (hooks) => {
      await hooks.inventory?.([general], [], ['10']);
      await hooks.checkpoint(channel, checkpoint(hooks.runId));
      return { scanned: 2, channels: 1 };
    });
    const result = await scan(PERIODIC);
    expect(result).toMatchObject({
      status: 'complete',
      issues: [],
      gaps: [],
      counts: { scanned: 2, channels: 1, pendingEvents: 0, deadLetters: 0 },
    });
    expect(result.interruption).toBeUndefined();
    const stored = stores.channels.channels.get('10');
    expect(stored).toMatchObject({ name: 'general', access: 'readable' });
    expect(stored?.checkpoints?.periodic).toMatchObject({ runId: 'periodic:1', complete: true });
    expect(stores.channels.cursors.get('10')).toBe('500');
    expect(deps.inbox.beginPass).toHaveBeenCalledWith(state);
    expect(deps.inbox.drainInboxSafely).toHaveBeenCalledTimes(1);
    expect(state.progress?.snapshot().state).toBe('complete');
  });

  it('judges the live backlog only after one inbox round', async () => {
    const { stores, deps, scan } = setup();
    stores.backlog = { pending: 3, live: 0 };
    deps.inbox.drainInboxSafely.mockImplementation(async () => {
      stores.backlog = { pending: 0, live: 0 };
    });
    history(async () => undefined);
    expect((await scan(PERIODIC)).status).toBe('complete');
  });

  it('keeps the fetch cursor until a source completes', async () => {
    const { stores, scan } = setup();
    history(async (hooks) => {
      await hooks.checkpoint(channel, checkpoint(hooks.runId, { complete: false }));
    });
    await scan(PERIODIC);
    expect(stores.channels.cursors.has('10')).toBe(false);
    expect(stores.channels.channels.get('10')?.checkpoints?.periodic).toMatchObject({
      complete: false,
    });
  });

  it('keeps full-backup checkpoints apart from periodic ones', async () => {
    const { stores, scan } = setup();
    const periodic = checkpoint('periodic:old', { complete: false, before: '700' });
    await stores.channels.upsertChannel(readable('readable', { checkpoints: { periodic } }));
    let loaded: Awaited<ReturnType<HistoryHooks['load']>> | undefined;
    history(async (hooks) => {
      loaded = await hooks.load('10');
      await hooks.checkpoint(channel, checkpoint(hooks.runId));
    });
    const result = await scan(FULL_BACKUP);
    expect(result.status).toBe('complete');
    // A full backup never resumes from, or reports, periodic work.
    expect(loaded?.checkpoint).toBeUndefined();
    expect(result.counts).not.toHaveProperty('deadLetters');
    const stored = stores.channels.channels.get('10');
    expect(stored?.checkpoints?.periodic).toEqual(periodic);
    expect(stored?.checkpoints?.['full-backup']).toMatchObject({ runId: 'full:1' });
  });

  it('orders a full backup by stored work and leaves periodic discovery order alone', async () => {
    const { stores, scan } = setup();
    stores.storedWork = [{ channelId: '20', messages: 500 }];
    const sources = ['10', '20'].map((id) => ({ ...channel, id }) as GuildBasedChannel);
    const orders: (string[] | undefined)[] = [];
    history(async (hooks) => {
      orders.push((await hooks.order?.(sources))?.map(({ id }) => id));
    });
    await scan(PERIODIC);
    await scan(FULL_BACKUP);
    expect(orders).toEqual([undefined, ['20', '10']]);
    expect(stores.storedQueries[0]).toMatchObject({ before: CUTOFF });
  });

  it('recounts a resumed full backup source below its own cursor', async () => {
    const { stores, scan } = setup();
    const cursor = historyBefore(new Date(CUTOFF - 86_400_000));
    await stores.channels.upsertChannel(
      readable('readable', {
        checkpoints: {
          'full-backup': checkpoint('full:1', { complete: false, before: cursor, pageSequence: 2 }),
        },
      }),
    );
    stores.storedWork = [{ channelId: '10', messages: 500 }];
    history(async (hooks) => {
      await hooks.order?.([channel]);
    });
    await scan(FULL_BACKUP);
    expect(stores.storedQueries.map(({ sources }) => sources)).toEqual([
      undefined,
      new Map([['10', snowflakeTimestamp(cursor)]]),
    ]);
  });

  it('restores the progress of a resumed run from its checkpoints', async () => {
    const { stores, state, scan } = setup();
    const statistics = {
      messages: {
        fetched: 0,
        scanned: 40,
        admitted: 30,
        excluded: 10,
        inserted: 25,
        updated: 5,
        unchanged: 0,
        durable: 30,
      },
      reactions: 4,
      staleReactions: 1,
    };
    const resumed = checkpoint('periodic:1', { scanned: 40, admitted: 30, statistics });
    await stores.channels.upsertChannel(
      readable('readable', { checkpoints: { periodic: resumed } }),
    );
    history(async () => undefined);
    await scan(PERIODIC);
    const snapshot = state.progress!.snapshot();
    expect(snapshot.phases.history.committed).toBe(40);
    expect(snapshot.messages).toMatchObject({ inserted: 25, updated: 5 });
    expect(snapshot.reactions).toMatchObject({ completed: 4, stale: 1 });
  });

  it('continues the progress a full backup started before its scan', async () => {
    const { state, scan } = setup();
    const tracker = new ProgressTracker({
      cutoff: new Date(CUTOFF),
      work: 'full-backup',
      jobId: '1:job',
      runId: 'full:1',
    });
    state.progress = tracker;
    history(async () => undefined);
    await scan(FULL_BACKUP);
    expect(state.progress).toBe(tracker);
  });

  it.each([
    ['an incremental', PERIODIC, CUTOFF],
    ['a full', FULL_PERIODIC, CUTOFF - 3_600_000],
  ] as const)(
    'carries the periodic estimate forward after %s scan',
    async (_label, mode, lastCutoff) => {
      const { stores, scan } = setup();
      const baseline = {
        version: 2 as const,
        lastCutoff: CUTOFF - 3_600_000,
        windowMs: 3_600_000,
        scanned: 10,
        elapsedMs: 100,
        samples: 1,
      };
      const old = checkpoint('periodic:old', { estimatePrevious: baseline });
      await stores.channels.upsertChannel(readable('readable', { checkpoints: { periodic: old } }));
      history(async (hooks) => {
        await hooks.checkpoint(channel, checkpoint(hooks.runId, { startedAt: Date.now() - 50 }));
      });
      await scan(mode);
      const saved = stores.channels.channels.get('10')?.checkpoints?.periodic;
      expect(saved?.estimatePrevious?.lastCutoff).toBe(lastCutoff);
    },
  );

  it('stays partial while live events observed before the cutoff remain unprocessed', async () => {
    const { stores, scan } = setup();
    stores.backlog = { pending: 2, live: 5, oldestLiveAt: Date.now() };
    history(async () => undefined);
    const result = await scan(PERIODIC);
    expect(result.status).toBe('partial');
    expect(result.issues).toEqual([
      '2 live archive event(s) observed before the cutoff remain unprocessed',
    ]);
    // Later events are live backlog, not part of the pass.
    expect(result.counts).toMatchObject({ pendingEvents: 2, liveBacklog: 5 });
  });

  it('stays partial when a Gateway gap occurs during the scan', async () => {
    const { state, scan } = setup();
    history(async () => {
      state.continuity.gapVersion += 1;
    });
    const result = await scan(PERIODIC);
    expect(result.status).toBe('partial');
    expect(result.issues).toEqual([
      'Gateway gap during scan; full reconciliation remains required',
    ]);
  });

  it('reports dead letters traced to a periodic run as known gaps', async () => {
    const { stores, scan } = setup();
    stores.deadLetters = [{ channelId: '10' }, { channelId: '10' }, {}];
    history(async () => ({ gaps: ['20: missing-access'] }));
    const result = await scan(PERIODIC);
    expect(result.status).toBe('complete');
    expect(result.gaps).toEqual([
      '20: missing-access',
      '10: live-event-dead-lettered',
      'unknown: live-event-dead-lettered',
    ]);
    expect(result.counts).toMatchObject({ deadLetters: 3 });
  });

  it('ends a stopped full backup cancelled without stopping the guild', async () => {
    const { stores, state, deps, scan } = setup();
    stores.stopRequested = true;
    let boundary: unknown;
    history(async (hooks) => {
      boundary = await hooks.afterPage().catch((error: unknown) => error);
    });
    const result = await scan(FULL_BACKUP);
    expect(boundary).toMatchObject({ name: 'ArchiveJobStoppedError' });
    expect(result).toMatchObject({ status: 'cancelled', interruption: 'cancelled' });
    expect(deps.ingestor.ingestPage).not.toHaveBeenCalled();
    // The stop belongs to the job: the guild keeps running and later passes complete.
    expect(state.signal.signal.aborted).toBe(false);
    history(async () => undefined);
    expect((await scan(PERIODIC)).status).toBe('complete');
  });

  it('ends cancelled when the worker shuts down during the scan', async () => {
    const { state, scan } = setup();
    let signal: AbortSignal | undefined;
    history(async (hooks) => {
      signal = hooks.signal;
      state.signal.abort();
    });
    const result = await scan(PERIODIC);
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'cancelled', interruption: 'cancelled' });
  });

  it.each(['10: storage headroom exhausted', 'archive capacity is unknown'])(
    'pauses on storage pressure (%s) without treating it as a stop',
    async (reason) => {
      const { state, scan } = setup();
      let boundary: unknown;
      history(async (hooks) => {
        hooks.failed?.(reason);
        boundary = await hooks.afterPage().catch((error: unknown) => error);
      });
      const result = await scan(FULL_BACKUP);
      expect(boundary).toMatchObject({ message: reason });
      expect(result).toMatchObject({ status: 'partial', interruption: reason, issues: [reason] });
      expect(state.progress?.snapshot().state).toBe('partial');
    },
  );

  it('ignores other source failures, which the history result reports', async () => {
    const { scan } = setup();
    history(async (hooks) => {
      hooks.failed?.('10: transient read failure');
      await hooks.afterPage();
    });
    expect((await scan(PERIODIC)).status).toBe('complete');
  });

  it('pauses a periodic pass its schedule no longer allows', async () => {
    const { scan } = setup();
    let boundary: unknown;
    history(async (hooks) => {
      boundary = await hooks.afterPage().catch((error: unknown) => error);
    });
    const result = await scan({ kind: 'periodic', full: false, shouldContinue: async () => false });
    expect(boundary).toMatchObject({ message: 'Periodic archive disabled' });
    expect(result).toMatchObject({ status: 'partial', interruption: 'Periodic archive disabled' });
  });

  it('yields a periodic pass to a queued backup at its next boundary', async () => {
    const { state, scan } = setup();
    let signal: AbortSignal | undefined;
    history(async (hooks) => {
      signal = hooks.signal;
      state.work.preemptPeriodic();
    });
    const result = await state.work.startPeriodic(
      () => scan(PERIODIC),
      async () => undefined,
    );
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: 'partial',
      interruption: 'Queued archive maintenance',
      issues: ['Queued archive maintenance'],
    });
  });

  it.each([
    ['inventory', 'denied', true],
    ['inventory', 'unknown', true],
    ['inventory', 'readable', false],
    ['inventory', undefined, false],
    ['revalidation', 'denied', true],
    ['revalidation', 'readable', false],
    ['revalidation', undefined, false],
  ] as const)(
    'records a continuity break when %s finds a source readable again (previously %s: %s)',
    async (through, previous, breaks) => {
      const { stores, state, deps, scan } = setup();
      if (previous !== undefined) await stores.channels.upsertChannel(readable(previous));
      history(async (hooks) => {
        if (through === 'inventory') await hooks.inventory?.([general], [], ['10']);
        else await hooks.revalidated?.('10', 'readable', fetchedChannel);
      });
      await scan(PERIODIC);
      expect(stores.channels.channels.get('10')?.access).toBe('readable');
      if (breaks)
        expect(deps.continuity.recordChannelBreak).toHaveBeenCalledWith(
          state,
          '10',
          expect.any(Number),
        );
      else expect(deps.continuity.recordChannelBreak).not.toHaveBeenCalled();
    },
  );

  it('records no break for a source that stays unreadable', async () => {
    const { stores, deps, scan } = setup();
    await stores.channels.upsertChannel(readable('denied'));
    history(async (hooks) => {
      await hooks.revalidated?.('10', 'denied', undefined, 'missing-view-channel');
    });
    const result = await scan(PERIODIC);
    expect(deps.continuity.recordChannelBreak).not.toHaveBeenCalled();
    expect(stores.channels.channels.get('10')).toMatchObject({
      access: 'denied',
      discovery: { gaps: ['missing-view-channel'] },
    });
    expect(result.status).toBe('complete');
  });
});
