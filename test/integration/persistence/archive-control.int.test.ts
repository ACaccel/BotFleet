import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mongoose';
import { asGuildId } from '../../../src/core/ids';
import type {
  ArchiveChannel,
  ArchiveFullBackupJob,
  ArchiveJob,
} from '../../../src/core/archive/types';
import type { ArchiveControlError } from '../../../src/core/errors';
import { unwrap, type Result } from '../../../src/core/result';
import {
  ARCHIVE_CONFIRMATION_TTL_MS,
  type ArchiveControl,
} from '../../../src/application/archive/control';
import { archiveControlFor } from '../../helpers/archive-control';
import { StaticConnectionManager } from '../../../src/infra/mongo/connection-manager';
import { MongoArchiveStorageUsageRepo } from '../../../src/persistence/repositories/archive-storage-usage.repo';
import { withFreshConnection } from '../helpers/mongo';

afterEach(() => vi.restoreAllMocks());

const GUILD = '1';
const actor = { userId: '11', channelId: '22', messageId: '33' };
const build = (connection: Connection): Promise<ArchiveControl> =>
  archiveControlFor(connection, GUILD);
/** The worker creates archive indexes after ownership; tests create the job indexes directly. */
const open = async (connection: Connection): Promise<ArchiveControl> => {
  const conn = await new StaticConnectionManager(connection).getConnection(asGuildId(GUILD));
  await conn.models.ArchiveJob.createCollection();
  await conn.models.ArchiveJob.createIndexes();
  return build(connection);
};
const jobs = (connection: Connection) =>
  connection.collection<ArchiveJob & { _id: string }>('archive_jobs');
const panelOf = async (connection: Connection, jobId: string) =>
  (
    await connection
      .collection<ArchiveFullBackupJob & { _id: string }>('archive_jobs')
      .findOne({ jobId })
  )?.notification;
/** The value of an accepted control request; fails the test on a rejection. */
const accepted = async <T>(result: Promise<Result<T, ArchiveControlError>>): Promise<T> =>
  unwrap(await result);
const rejection = (code: ArchiveControlError['code']) => ({
  ok: false,
  error: expect.objectContaining({ name: 'ArchiveControlError', code }),
});

describe('archive control service', () => {
  it('creates one full backup per approval with a fixed cutoff, idempotently', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const { token } = await control.requestConfirmation(actor);
      const [first, replay] = await Promise.all([
        accepted(control.confirm(token, actor)),
        accepted(control.confirm(token, actor)),
      ]);
      expect(replay.jobId).toBe(first.jobId);
      expect(await jobs(connection).countDocuments()).toBe(1);
      expect(first).toMatchObject({
        command: 'full-backup',
        status: 'queued',
        activeSlot: 'full-backup',
        options: { cutoff: expect.any(Number) },
        runId: expect.stringMatching(/^full:/),
        notification: { channelId: '22', messageId: '33', view: 'progress' },
      });
    }));

  it('binds approval to the operator, channel and panel, and expires it after five minutes', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const { token, expiresAt } = await control.requestConfirmation(actor);
      for (const other of [
        { ...actor, userId: '12' },
        { ...actor, channelId: '23' },
        { ...actor, messageId: '34' },
      ])
        expect(await control.confirm(token, other)).toEqual(
          rejection('ARCHIVE_CONFIRMATION_ACTOR'),
        );
      const now = Date.now();
      expect(expiresAt - now).toBeLessThanOrEqual(ARCHIVE_CONFIRMATION_TTL_MS);
      vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      expect(await control.confirm(token, actor)).toEqual(
        rejection('ARCHIVE_CONFIRMATION_EXPIRED'),
      );
      expect(await control.confirm('A'.repeat(24), actor)).toEqual(
        rejection('ARCHIVE_CONFIRMATION_UNKNOWN'),
      );
      expect(await jobs(connection).countDocuments()).toBe(0);
    }));

  it('allows one active full backup per guild and rejects a cancelled approval', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const first = await control.requestConfirmation(actor);
      const second = await control.requestConfirmation({ ...actor, messageId: '44' });
      const cancelled = await control.requestConfirmation({ ...actor, messageId: '55' });
      await accepted(control.confirm(first.token, actor));
      expect(await control.confirm(second.token, { ...actor, messageId: '44' })).toEqual(
        rejection('ARCHIVE_BACKUP_ACTIVE'),
      );
      await accepted(control.cancelConfirmation(cancelled.token, { ...actor, messageId: '55' }));
      expect(await control.confirm(cancelled.token, { ...actor, messageId: '55' })).toEqual(
        rejection('ARCHIVE_CONFIRMATION_EXPIRED'),
      );
      expect(await jobs(connection).countDocuments()).toBe(1);
    }));

  it('stops a queued backup at once and resumes only the newest unfinished one', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const { token } = await control.requestConfirmation(actor);
      const job = await accepted(control.confirm(token, actor));
      const stopped = await accepted(control.stop(job.jobId));
      expect(stopped).toMatchObject({ status: 'cancelled', cancelRequested: true });
      expect(stopped.activeSlot).toBeUndefined();
      const resumed = await accepted(
        control.resume(job.jobId, { channelId: '22', messageId: '66' }),
      );
      expect(resumed).toMatchObject({
        status: 'queued',
        cancelRequested: false,
        activeSlot: 'full-backup',
        options: job.options,
        runId: job.runId,
        notification: { messageId: '66', view: 'progress' },
      });
      expect(await control.resume(job.jobId, { channelId: '22', messageId: '66' })).toEqual(
        rejection('ARCHIVE_JOB_NOT_RESUMABLE'),
      );
      await accepted(control.stop(job.jobId));
      const restart = await control.requestConfirmation({ ...actor, messageId: '77' });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
      const replacement = await accepted(
        control.confirm(restart.token, { ...actor, messageId: '77' }),
      );
      expect(replacement.options['cutoff']).not.toBe(job.options['cutoff']);
      // A newer backup makes the older stopped one final.
      await accepted(control.stop(replacement.jobId));
      expect(await control.resume(job.jobId, { channelId: '22', messageId: '66' })).toEqual(
        rejection('ARCHIVE_JOB_NOT_RESUMABLE'),
      );
    }));

  it('pages gap channels by reason and summarizes coverage', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const channels: ArchiveChannel[] = [
        ...Array.from({ length: 12 }, (_, index) => ({
          channelId: String(100 + index),
          name: `denied-${String(index).padStart(2, '0')}`,
          type: 0,
          observedAt: 1,
          access: 'denied' as const,
        })),
        { channelId: '200', name: 'gone', type: 0, observedAt: 1, access: 'deleted' },
        { channelId: '300', name: 'open', type: 0, observedAt: 1, access: 'readable' },
        { channelId: 'guild:1', name: '', type: -1, observedAt: 1, access: 'denied' },
      ];
      await connection.collection('archive_channels').insertMany(channels);
      const first = await control.gapChannels(1);
      expect(first).toMatchObject({ total: 13, page: 1, pages: 2 });
      expect(first.rows.map((row) => row.access)).toEqual(['deleted', ...Array(9).fill('denied')]);
      const last = await control.gapChannels(5);
      expect(last.page).toBe(2);
      expect(last.rows).toHaveLength(3);
      expect(await control.coverage()).toEqual({
        readable: 1,
        gaps: { denied: 12, deleted: 1, unknown: 0 },
      });
    }));

  it('reports status from durable records without a running worker', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      await connection.collection('archive_inbox').insertMany([
        { eventId: 'a', state: 'pending', observedAt: 1, attempts: 0, payload: {}, kind: 'delete' },
        { eventId: 'b', state: 'dead', observedAt: 1, attempts: 11, payload: {}, kind: 'delete' },
      ]);
      await connection.collection<{ _id: string }>('archive_gateway_continuity').insertOne({
        _id: 'current',
        bootId: 'boot',
        continuousSince: 123,
        confirmedAt: 123,
        fullRequired: false,
        gapVersion: 0,
        breakIndex: 0,
        breaks: [],
      } as never);
      await connection
        .collection<{ _id: string }>('archive_storage_usage')
        .insertOne({ _id: 'host', usedBytes: 5, budgetBytes: 10, measuredAt: 1 } as never);
      const status = await control.status();
      expect(status).toMatchObject({
        inbox: { pending: 1, dead: 1 },
        continuity: { continuousSince: 123 },
        host: { usedBytes: 5, budgetBytes: 10 },
        schedule: { enabled: false, intervalMs: 60_000 },
      });
      expect(status.fullBackup).toBeUndefined();
      expect(await control.archiveBytes()).toBeGreaterThan(0);
      // The worker's report keeps when the reused stable roots were walked.
      const report = new MongoArchiveStorageUsageRepo(connection);
      await report.write({ usedBytes: 6, budgetBytes: 10, measuredAt: 2, stableMeasuredAt: 1 });
      expect(await report.read()).toEqual({
        usedBytes: 6,
        budgetBytes: 10,
        measuredAt: 2,
        stableMeasuredAt: 1,
      });
    }));

  it('accepts an approval until five minutes after it was shown, and not after', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const shown = 1_700_000_000_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(shown);
      const early = await control.requestConfirmation(actor);
      const late = await control.requestConfirmation({ ...actor, messageId: '44' });
      clock.mockReturnValue(shown + ARCHIVE_CONFIRMATION_TTL_MS - 1);
      const job = await accepted(control.confirm(early.token, actor));
      expect(job.options.cutoff).toBe(shown + ARCHIVE_CONFIRMATION_TTL_MS - 1);
      await accepted(control.stop(job.jobId));
      clock.mockReturnValue(shown + ARCHIVE_CONFIRMATION_TTL_MS + 1);
      expect(await control.confirm(late.token, { ...actor, messageId: '44' })).toEqual(
        rejection('ARCHIVE_CONFIRMATION_EXPIRED'),
      );
    }));

  it('returns the same job to a replay inside the window, from any service instance', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const { token } = await control.requestConfirmation(actor);
      const job = await accepted(control.confirm(token, actor));
      const other = await build(connection);
      expect((await accepted(other.confirm(token, actor))).jobId).toBe(job.jobId);
      expect(await jobs(connection).countDocuments()).toBe(1);
    }));

  it('never recreates a pruned job from a replayed approval after the window', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const consumedAt = 1_700_000_000_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(consumedAt);
      const { token } = await control.requestConfirmation(actor);
      const job = await accepted(control.confirm(token, actor));
      await jobs(connection).deleteOne({ jobId: job.jobId });
      clock.mockReturnValue(consumedAt + ARCHIVE_CONFIRMATION_TTL_MS - 1);
      // Within the window a lost creation is completed.
      expect((await accepted(control.confirm(token, actor))).jobId).toBe(job.jobId);
      await jobs(connection).deleteOne({ jobId: job.jobId });
      clock.mockReturnValue(consumedAt + ARCHIVE_CONFIRMATION_TTL_MS + 1);
      expect(await control.confirm(token, actor)).toEqual(
        rejection('ARCHIVE_CONFIRMATION_EXPIRED'),
      );
      expect(await jobs(connection).countDocuments()).toBe(0);
    }));

  it('expires approval records through a TTL index and ensures the active-slot index itself', async () =>
    withFreshConnection(async (connection) => {
      // No worker or model index creation: the service must create both indexes.
      const control = await build(connection);
      const { token } = await control.requestConfirmation(actor);
      const stored = await connection
        .collection<{
          _id: string;
          purgeAt: Date;
          createdAt: number;
        }>('archive_control_confirmations')
        .findOne({ _id: token });
      expect(stored?.purgeAt.getTime()).toBe(stored!.createdAt + 24 * 60 * 60_000);
      const confirmationIndexes = await connection
        .collection('archive_control_confirmations')
        .indexes();
      expect(confirmationIndexes).toContainEqual(
        expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }),
      );
      await accepted(control.confirm(token, actor));
      const second = await control.requestConfirmation({ ...actor, messageId: '44' });
      expect(await control.confirm(second.token, { ...actor, messageId: '44' })).toEqual(
        rejection('ARCHIVE_BACKUP_ACTIVE'),
      );
    }));

  it('detaches the panel only from the newest stopped backup when starting over', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      const first = await control.requestConfirmation(actor);
      const job = await accepted(control.confirm(first.token, actor));
      await accepted(control.stop(job.jobId));
      const panel = { channelId: '22', messageId: '33' };
      expect(await control.prepareRestart(job.jobId, panel)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await panelOf(connection, job.jobId)).toEqual({
        channelId: '22',
        view: 'progress',
      });
      // A newer backup makes the stopped one final; its panel stays attached.
      await accepted(control.resume(job.jobId, panel));
      await accepted(control.stop(job.jobId));
      const second = await control.requestConfirmation({ ...actor, messageId: '55' });
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
      const newer = await accepted(control.confirm(second.token, { ...actor, messageId: '55' }));
      expect(await control.prepareRestart(job.jobId, panel)).toEqual(
        rejection('ARCHIVE_JOB_NOT_RESUMABLE'),
      );
      expect((await panelOf(connection, job.jobId))?.messageId).toBe('33');
      // A queued backup cannot be restarted either.
      expect(
        await control.prepareRestart(newer.jobId, { channelId: '22', messageId: '55' }),
      ).toEqual(rejection('ARCHIVE_JOB_NOT_RESUMABLE'));
      expect((await panelOf(connection, newer.jobId))?.messageId).toBe('55');
    }));

  it('reports the current periodic run in status', async () =>
    withFreshConnection(async (connection) => {
      const control = await open(connection);
      await connection.collection<{ _id: string }>('archive_periodic_runs').insertOne({
        _id: 'current',
        runId: 'run-1',
        cutoff: 5,
        full: false,
        status: 'running',
      } as never);
      expect((await control.status()).periodicRun).toMatchObject({
        runId: 'run-1',
        status: 'running',
      });
    }));
});
