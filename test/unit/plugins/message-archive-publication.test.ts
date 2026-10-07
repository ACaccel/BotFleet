import { describe, expect, it, vi } from 'vitest';
import type { ArchiveJob } from '../../../src/core/archive/types';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import { createLogger } from '../../../src/core/logger';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ProgressTracker } from '../../../src/plugins/message-backup/flow/progress';
import { ArchiveJobNotifier } from '../../../src/plugins/message-backup/runtime/job-notification';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';

type WorkerState = Awaited<ReturnType<ArchiveWorker['initialize']>>;
type Publication = {
  publishProgress(
    guildId: string,
    state: WorkerState,
    jobId: string,
    force?: boolean,
  ): Promise<void>;
  closeProgressPublication(state: WorkerState, deliverFinal?: boolean): Promise<void>;
};

describe('independent public archive heartbeat', () => {
  it('refreshes unchanged progress every ten seconds through long work and a blocked observation, then stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const publish = vi.spyOn(ArchiveJobNotifier.prototype, 'publish').mockResolvedValue();
    let release!: () => void;
    const observation = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const countDocuments = vi.fn(() => observation);
    const job: ArchiveJob = {
      jobId: '1:long-work',
      requestId: 'long-work',
      guildId: '1',
      command: 'audit',
      options: {},
      status: 'running',
      cancelRequested: false,
      createdAt: Date.now(),
    };
    const collection = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) };
    const progress = new ProgressTracker({ cutoff: new Date(), work: 'audit', jobId: job.jobId });
    const state = {
      progress,
      repo: { getJob: async () => job },
      conn: {
        guildId: '1',
        connection: { collection: () => collection },
        models: { ArchiveInbox: { collection: { countDocuments, findOne: async () => null } } },
      },
      signal: new AbortController(),
    } as unknown as WorkerState;
    const worker = new ArchiveWorker({
      client: { rest: {} },
      logger: createLogger({ level: 'silent', pretty: false }),
      guildIds: ['1'],
      config: archiveRuntimeSchema.parse({}),
      policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    } as unknown as ConstructorParameters<typeof ArchiveWorker>[0]);
    const publication = worker as unknown as Publication;
    try {
      await publication.publishProgress('1', state, job.jobId, true);
      await state.notifications?.drain();
      expect(publish).toHaveBeenCalledOnce();
      const initial = publish.mock.calls[0]![1]!;
      await vi.advanceTimersByTimeAsync(9999);
      expect(publish).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await state.notifications?.drain();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]![1]).toMatchObject({
        updatedAt: initial.updatedAt + 10000,
        elapsedMs: initial.elapsedMs + 10000,
        lastProgressAt: initial.lastProgressAt,
        messages: initial.messages,
      });
      await vi.advanceTimersByTimeAsync(10000);
      await state.notifications?.drain();
      expect(publish).toHaveBeenCalledTimes(3);
      expect(countDocuments).toHaveBeenCalledOnce();

      progress.setPhase('history');
      await publication.publishProgress('1', state, job.jobId);
      await state.notifications?.drain();
      expect(publish).toHaveBeenCalledTimes(4);
      expect(publish.mock.calls[3]![1]?.phase).toBe('history');

      progress.finish('partial');
      release();
      await publication.closeProgressPublication(state, true);
      expect(publish.mock.calls.at(-1)?.[1]?.state).toBe('partial');
      const deliveries = publish.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(publish).toHaveBeenCalledTimes(deliveries);
    } finally {
      release();
      await publication.closeProgressPublication(state);
      await worker.stop();
      publish.mockRestore();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
});
