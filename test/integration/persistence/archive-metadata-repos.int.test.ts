import { describe, expect, it } from 'vitest';
import type { Connection } from 'mongoose';
import type { ArchiveFullBackupJob, ArchiveJob } from '../../../src/core/archive/types';
import { MongoArchiveControlRepo } from '../../../src/persistence/repositories/archive-control.repo';
import { MongoArchivePeriodicRunRepo } from '../../../src/persistence/repositories/archive-periodic-run.repo';
import { MongoArchiveStorageUsageRepo } from '../../../src/persistence/repositories/archive-storage-usage.repo';
import { withFreshConnection } from '../helpers/mongo';

const jobs = (connection: Connection) =>
  connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
const backup = (
  jobId: string,
  guildId: string,
  createdAt: number,
): ArchiveFullBackupJob & {
  _id: string;
} => ({
  _id: jobId,
  jobId,
  requestId: jobId,
  guildId,
  command: 'full-backup',
  options: { cutoff: createdAt },
  status: 'complete',
  cancelRequested: false,
  createdAt,
  notification: { channelId: '22', messageId: '33', view: 'progress' },
});

describe('archive control repository', () => {
  it('releases and marks only the panel the job still follows', async () =>
    withFreshConnection(async (connection) => {
      const repo = new MongoArchiveControlRepo(connection, '1');
      await jobs(connection).insertOne(backup('1:a', '1', 1));
      // A stale panel message changes nothing.
      await repo.markPanelDelivered('1:a', '99', 'complete');
      await repo.releasePanel('1:a', '99');
      expect((await repo.findFullBackup('1:a'))?.notification).toEqual({
        channelId: '22',
        messageId: '33',
        view: 'progress',
      });
      await repo.markPanelDelivered('1:a', '33', 'complete');
      expect((await repo.findFullBackup('1:a'))?.notification?.deliveredStatus).toBe('complete');
      await repo.releasePanel('1:a', '33');
      expect((await repo.findFullBackup('1:a'))?.notification).toEqual({
        channelId: '22',
        view: 'progress',
        deliveredStatus: 'complete',
      });
    }));

  it('lists records newest first up to the limit and scopes every query to its guild', async () =>
    withFreshConnection(async (connection) => {
      await jobs(connection).insertMany([
        backup('1:a', '1', 1),
        backup('1:c', '1', 3),
        backup('1:b', '1', 2),
        backup('2:d', '2', 4),
      ]);
      const repo = new MongoArchiveControlRepo(connection, '1');
      expect((await repo.recentRecords(2)).map((job) => job.jobId)).toEqual(['1:c', '1:b']);
      expect((await repo.latestFullBackup())?.jobId).toBe('1:c');
      expect(await repo.findJobById('2:d')).toBeUndefined();
      expect(await repo.findFullBackup('2:d')).toBeUndefined();
    }));

  it('refuses a closed database', () => {
    expect(
      () => new MongoArchiveControlRepo({ db: undefined } as unknown as Connection, '1'),
    ).toThrow(TypeError);
  });
});

describe('archive periodic run repository', () => {
  it('replaces the current run and updates it only while it is still that run', async () =>
    withFreshConnection(async (connection) => {
      const repo = new MongoArchivePeriodicRunRepo(connection);
      expect(await repo.current()).toBeNull();
      const origin = { bootId: 'boot', gapVersion: 2, breakIndex: 1 };
      await repo.replace({
        _id: 'current',
        runId: 'old',
        cutoff: 1,
        full: true,
        status: 'running',
        origin,
      });
      await repo.replace({
        _id: 'current',
        runId: 'new',
        cutoff: 2,
        full: false,
        status: 'running',
      });
      expect(await repo.currentOrigin()).toEqual({ _id: 'current' });
      await repo.update('old', { status: 'complete' });
      expect(await repo.current()).toMatchObject({ runId: 'new', status: 'running' });
      await repo.update('new', { status: 'partial', blockedPasses: 1 });
      expect(await repo.current()).toMatchObject({
        runId: 'new',
        status: 'partial',
        blockedPasses: 1,
      });
    }));
});

describe('archive storage usage repository', () => {
  it('reads back the latest sample and treats a missing or malformed one as unknown', async () =>
    withFreshConnection(async (connection) => {
      const repo = new MongoArchiveStorageUsageRepo(connection);
      expect(await repo.read()).toBeUndefined();
      await repo.write({ usedBytes: 5, budgetBytes: 10, measuredAt: 1 });
      expect(await repo.read()).toEqual({ usedBytes: 5, budgetBytes: 10, measuredAt: 1 });
      await connection
        .collection<{ _id: string }>('archive_storage_usage')
        .updateOne({ _id: 'host' }, { $set: { budgetBytes: 0 } });
      expect(await repo.read()).toBeUndefined();
    }));

  it('sums message and archive collections only', async () =>
    withFreshConnection(async (connection) => {
      const repo = new MongoArchiveStorageUsageRepo(connection);
      await connection.collection('unrelated').insertOne({ value: 'x'.repeat(10_000) });
      expect(await repo.archiveBytes()).toBe(0);
      await connection.collection('archive_inbox').insertOne({ value: 1 });
      expect(await repo.archiveBytes()).toBeGreaterThan(0);
      expect(
        await new MongoArchiveStorageUsageRepo({
          db: undefined,
        } as unknown as Connection).archiveBytes(),
      ).toBeUndefined();
    }));
});
