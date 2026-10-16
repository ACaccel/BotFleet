import { describe, expect, it, vi } from 'vitest';
import type { ArchiveSnapshot } from '../../../src/core/archive/types';
import { ArchivePipelineBudget } from '../../../src/plugins/message-backup/flow/pipeline';
import { ProgressTracker } from '../../../src/plugins/message-backup/flow/progress';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import { ReactionRefresher } from '../../../src/plugins/message-backup/runtime/reaction-refresh';
import type { ArchiveGuildState } from '../../../src/plugins/message-backup/runtime/worker-context';

/** A refresher over one message with one reaction and the fields a refresh reaches. */
const setup = () => {
  const progress = new ProgressTracker({
    cutoff: new Date(1000),
    work: 'full-backup',
    jobId: '1:job',
    runId: 'run',
  });
  const state = {
    conn: { guildId: '1' },
    signal: new AbortController(),
    reactions: { generations: new Map() },
    repos: {
      reactions: {
        markReactionsStale: vi.fn(async () => undefined),
        stageReactions: vi.fn(async () => undefined),
        finalizeReactionRefresh: vi.fn(async () => undefined),
      },
    },
    storage: {
      withReservation: (_bytes: number, _bulk: boolean, run: () => unknown) => run(),
    },
    writer: { run: (operation: () => unknown) => operation() },
    dirty: { pin: () => () => undefined, current: 0 },
    continuity: { gapVersion: 0 },
    progress,
  } as unknown as ArchiveGuildState;
  const observations = {
    get: () => undefined,
    unchanged: () => true,
    read: (_state: unknown, operation: () => unknown) => operation(),
    release: () => undefined,
  };
  const get = vi.fn(async () => [{ id: '1' }, { id: '2' }]);
  const refresher = new ReactionRefresher(
    {
      options: { client: { rest: { get } }, config: { concurrency: 2 } },
      scheduler: new ArchiveScheduler({ concurrency: 2 }),
      pipelineBudget: new ArchivePipelineBudget(),
    } as never,
    observations as never,
  );
  const raw = {
    id: '100',
    channel_id: '10',
    reactions: [{ emoji: { name: 'x' }, count: 2, count_details: { normal: 2, burst: 0 } }],
  };
  const snapshot = { _id: '100', channelId: '10' } as unknown as ArchiveSnapshot;
  return { refresher, state, progress, raw, snapshot, get };
};

describe('reaction refresh activity', () => {
  it('leaves the shared full-backup progress untouched for a live refresh', async () => {
    const f = setup();
    const activity = vi.spyOn(f.progress, 'activity');
    await f.refresher.refresh(f.state, f.raw, f.snapshot);
    expect(f.get).toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(f.progress.snapshot().activityCount).toBe(0);
  });

  it('reports staged membership to the history source that owns the refresh', async () => {
    const f = setup();
    const onActivity = vi.fn();
    await f.refresher.refresh(f.state, f.raw, f.snapshot, undefined, undefined, undefined, {
      onActivity,
    });
    expect(onActivity).toHaveBeenCalledWith({ reactionUsers: 0, reactionPages: 0 });
    expect(onActivity).toHaveBeenLastCalledWith({ reactionUsers: 4, reactionPages: 2 });
  });
});
