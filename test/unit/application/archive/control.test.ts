import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveControlService,
  type ArchiveControlStores,
} from '../../../../src/application/archive/control';
import type { ArchiveFullBackupJob, ArchiveJobStatus } from '../../../../src/core/archive/types';
import type { ArchiveControlError, ArchiveControlErrorCode } from '../../../../src/core/errors';
import { asGuildId } from '../../../../src/core/ids';
import type { Result } from '../../../../src/core/result';
import type {
  ArchiveConfirmation,
  ArchiveControlRepo,
  ArchiveRequeueOutcome,
} from '../../../../src/persistence/repositories/archive-control.repo';

const GUILD = '1';
const actor = { userId: '11', channelId: '22', messageId: '33' };
const panel = { channelId: '22', messageId: '44' };
const TOKEN = 'T'.repeat(24);

const backup = (jobId: string, status: ArchiveJobStatus, createdAt = 1): ArchiveFullBackupJob => ({
  jobId,
  requestId: jobId,
  guildId: GUILD,
  command: 'full-backup',
  options: { cutoff: 1 },
  status,
  cancelRequested: false,
  createdAt,
});

/** An in-memory control repository holding `jobs`; the newest is the latest backup. */
const controlRepo = (jobs: ArchiveFullBackupJob[] = []) => {
  const newest = (): ArchiveFullBackupJob | undefined =>
    [...jobs].sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    ensureIndexes: vi.fn(async () => undefined),
    latestFullBackup: vi.fn(async () => newest()),
    findFullBackup: vi.fn(async (jobId: string) => jobs.find((job) => job.jobId === jobId)),
    findJobById: vi.fn(async (id: string) => jobs.find((job) => job.jobId === id)),
    insertFullBackup: vi.fn(async () => true),
    requestStop: vi.fn(async () => undefined),
    requeueFullBackup: vi.fn(async (): Promise<ArchiveRequeueOutcome> => 'requeued'),
    setPanel: vi.fn(async () => undefined),
    releasePanel: vi.fn(async () => undefined),
    markPanelDelivered: vi.fn(async () => undefined),
    recentRecords: vi.fn(async () => []),
    insertConfirmation: vi.fn(async () => undefined),
    findConfirmation: vi.fn(async (): Promise<ArchiveConfirmation | undefined> => undefined),
    consumeConfirmation: vi.fn(async () => true),
    isConfirmationConsumed: vi.fn(async () => false),
    cancelConfirmation: vi.fn(async () => undefined),
    countGapChannels: vi.fn(async () => 0),
    listGapChannels: vi.fn(async () => []),
    coverage: vi.fn(async () => ({ readable: 0, gaps: { denied: 0, deleted: 0, unknown: 0 } })),
    openInboxCount: vi.fn(async () => 0),
    deadLetterCount: vi.fn(async () => 0),
  } satisfies ArchiveControlRepo;
};

const service = (control: ArchiveControlRepo) =>
  new ArchiveControlService(
    // Only the control repository takes part in these use cases.
    { control } as unknown as ArchiveControlStores,
    asGuildId(GUILD),
  );

const rejected = <T>(result: Result<T, ArchiveControlError>, code: ArchiveControlErrorCode) =>
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code }) });

describe('archive control use cases', () => {
  it('rejects an unknown job', async () => {
    rejected(await service(controlRepo()).job('1:missing'), 'ARCHIVE_JOB_UNKNOWN');
  });

  it('reports a taken active slot when another backup won the confirmation race', async () => {
    const control = controlRepo();
    control.findConfirmation.mockResolvedValue({
      _id: TOKEN,
      guildId: GUILD,
      ...actor,
      action: 'full-backup',
      requestId: 'request',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      purgeAt: new Date(),
    });
    control.insertFullBackup.mockResolvedValue(false);
    rejected(await service(control).confirm(TOKEN, actor), 'ARCHIVE_BACKUP_ACTIVE');
  });

  it.each([
    ['slot-taken', 'ARCHIVE_BACKUP_ACTIVE'],
    ['not-resumable', 'ARCHIVE_JOB_NOT_RESUMABLE'],
  ] as const)('maps a %s requeue to %s', async (outcome, code) => {
    const control = controlRepo([backup('1:a', 'cancelled')]);
    control.requeueFullBackup.mockResolvedValue(outcome);
    rejected(await service(control).resume('1:a', panel), code);
  });

  it('resumes only the newest stopped or failed backup', async () => {
    const control = controlRepo([backup('1:old', 'failed', 1), backup('1:new', 'cancelled', 2)]);
    rejected(await service(control).resume('1:old', panel), 'ARCHIVE_JOB_NOT_RESUMABLE');
    expect(control.requeueFullBackup).not.toHaveBeenCalled();
    expect(await service(control).resume('1:new', panel)).toMatchObject({ ok: true });
    expect(control.requeueFullBackup).toHaveBeenCalledWith('1:new', { ...panel, view: 'progress' });
  });

  it('detaches the panel from the newest stopped backup before a restart', async () => {
    const control = controlRepo([backup('1:a', 'cancelled')]);
    expect(await service(control).prepareRestart('1:a', panel)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(control.releasePanel).toHaveBeenCalledWith('1:a', '44');
  });

  it.each([
    ['an older stopped backup', [backup('1:a', 'cancelled', 1), backup('1:b', 'complete', 2)]],
    ['a running backup', [backup('1:a', 'running')]],
  ])('keeps the panel and refuses to restart from %s', async (_case, jobs) => {
    const control = controlRepo(jobs);
    rejected(await service(control).prepareRestart('1:a', panel), 'ARCHIVE_JOB_NOT_RESUMABLE');
    expect(control.releasePanel).not.toHaveBeenCalled();
  });
});
