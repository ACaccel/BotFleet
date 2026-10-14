import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_INVALID_REQUESTS } from '../../../src/core/archive/limits';
import { MongoArchiveScheduleRepo } from '../../../src/persistence/repositories/archive-schedule.repo';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import { ArchiveInvalidRequestMonitor } from '../../../src/plugins/message-backup/runtime/invalid-request-monitor';
import { NotificationRecovery } from '../../../src/plugins/message-backup/runtime/notification-recovery';
import { withFreshConnection } from '../helpers/mongo';
import { silentLogger } from '../../fixtures/runtime';
import { keyWithParamsTranslator } from '../../helpers/archive-worker-fixture';

const { warning, critical, windowMs } = ARCHIVE_INVALID_REQUESTS;

/** A worker process over one guild: its own scheduler, clock and in-memory count. */
const workerProcess = (connection: Connection, send: ReturnType<typeof vi.fn>, start: number) => {
  let now = start;
  let count = 0;
  const repo = new MongoArchiveScheduleRepo(connection, 3_600_000);
  const scheduler = new ArchiveScheduler({ concurrency: 8 });
  const logger = silentLogger();
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const isDisabled = vi.fn((_guildId: string): { traceId: string } | undefined => undefined);
  const ctx = {
    options: {
      config: { concurrency: 8 },
      logger,
      connections: { isDisabled },
      registry: { getChannel: () => ({ isSendable: () => true, send }) },
      translator: keyWithParamsTranslator(),
    },
    telemetry: { invalidLast10Minutes: () => count },
    scheduler,
    states: new Map([['1', { archive: { schedule: () => repo } }]]),
    stopped: false,
  };
  const monitor = new ArchiveInvalidRequestMonitor(
    ctx as never,
    new NotificationRecovery(ctx as never),
    () => now,
  );
  return {
    monitor,
    scheduler,
    repo,
    warn,
    error,
    isDisabled,
    at: (value: number, invalid: number) => {
      now = value;
      count = invalid;
      return monitor.check();
    },
  };
};

const titles = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([message]) => (message as { embeds: { title: string }[] }).embeds[0]!.title);

describe('invalid-request protection', () => {
  it('warns once per episode across restarts, slows background reads and recovers', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      const first = workerProcess(connection, send, 0);
      await first.at(1_000, warning - 1);
      expect(send).not.toHaveBeenCalled();
      expect(first.scheduler.snapshot().backgroundLimit).toBeUndefined();

      await first.at(2_000, warning);
      expect(titles(send)).toEqual(['replies:archive.notice_invalid_title']);
      expect(first.scheduler.snapshot().backgroundLimit).toBe(4);
      expect(first.warn).toHaveBeenCalledWith(
        expect.objectContaining({ invalidLast10Minutes: warning, level: 'warning' }),
        'Archive invalid Discord requests high; slowing background reads',
      );
      await first.at(3_000, critical);
      expect(first.scheduler.snapshot().backgroundLimit).toBe(1);
      expect(first.error).toHaveBeenCalledTimes(1);
      // Critical does not notify again.
      await first.at(70_000, critical);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await first.repo.readInvalidRequests()).toMatchObject({
        alerted: true,
        notice: { kind: 'invalid-requests', count: warning, deliveredAt: expect.any(Number) },
      });
      await first.monitor.stop();

      // A restart starts a new count and a new guard; the persisted episode is not resent.
      const second = workerProcess(connection, send, 100_000);
      await second.at(101_000, warning);
      expect(second.scheduler.snapshot().backgroundLimit).toBe(4);
      await second.at(102_000, 0);
      // Recovery waits for a whole observed window.
      await second.at(100_000 + windowMs - 1, 0);
      expect(send).toHaveBeenCalledTimes(1);
      await second.at(100_000 + windowMs, 0);
      expect(titles(send)).toEqual([
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_recovered_title',
      ]);
      await second.at(100_000 + windowMs + 70_000, 0);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await second.repo.readInvalidRequests()).toMatchObject({
        alerted: false,
        notice: { kind: 'invalid-requests-recovered', deliveredAt: expect.any(Number) },
      });
      await second.monitor.stop();

      // A later episode warns again.
      const third = workerProcess(connection, send, 1_000_000);
      await third.at(1_001_000, warning);
      expect(send).toHaveBeenCalledTimes(3);
      await third.monitor.stop();
    }));

  it('retries a warning whose send failed on a later check', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      send.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
      const worker = workerProcess(connection, send, 0);
      await worker.at(1_000, warning);
      expect(send).toHaveBeenCalledTimes(1);
      const deferred = await worker.repo.readInvalidRequests();
      expect(deferred.notice).toMatchObject({ attempts: 1, retryAt: expect.any(Number) });
      expect(deferred.notice?.deliveredAt).toBeUndefined();
      await connection
        .collection<{ _id: string }>('archive_schedule')
        .updateOne({ _id: 'invalid-requests' }, { $set: { 'notice.retryAt': 0 } });
      await worker.at(62_000, warning);
      expect(send).toHaveBeenCalledTimes(2);
      expect((await worker.repo.readInvalidRequests()).notice?.deliveredAt).toBeDefined();
      // The periodic-health record is untouched.
      expect(
        await connection
          .collection<{ _id: string }>('archive_schedule')
          .findOne({ _id: 'current' }),
      ).toBeNull();
      await worker.monitor.stop();
    }));

  it('raises a warning whose first record failed on the next check', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      const worker = workerProcess(connection, send, 0);
      vi.spyOn(worker.repo, 'raiseInvalidRequestNotice').mockRejectedValueOnce(
        new Error('database timeout'),
      );
      await worker.at(1_000, warning);
      expect(send).not.toHaveBeenCalled();
      expect(worker.scheduler.snapshot().backgroundLimit).toBe(4);
      await worker.at(6_000, warning);
      expect(titles(send)).toEqual(['replies:archive.notice_invalid_title']);
      await worker.at(11_000, warning);
      expect(send).toHaveBeenCalledTimes(1);
      await worker.monitor.stop();
    }));

  it('raises each notice only once under concurrent workers', async () =>
    withFreshConnection(async (connection) => {
      const repo = new MongoArchiveScheduleRepo(connection, 3_600_000);
      const raised = await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.raiseInvalidRequestNotice({ kind: 'invalid-requests', count: warning }),
        ),
      );
      expect(raised.filter((outcome) => outcome === 'raised')).toHaveLength(1);
      // An undelivered warning keeps its recovery waiting.
      expect(await repo.raiseInvalidRequestNotice({ kind: 'invalid-requests-recovered' })).toBe(
        'waiting',
      );
      const { notice } = await repo.readInvalidRequests();
      await repo.markNoticeDelivered(notice!.createdAt, 'invalid-requests');
      expect(await repo.raiseInvalidRequestNotice({ kind: 'invalid-requests-recovered' })).toBe(
        'raised',
      );
      expect(await repo.raiseInvalidRequestNotice({ kind: 'invalid-requests-recovered' })).toBe(
        'unchanged',
      );
    }));

  it('runs one episode after another in a single process', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      const worker = workerProcess(connection, send, 0);
      await worker.at(1_000, warning);
      await worker.at(2_000, 0);
      await worker.at(windowMs + 1, 0);
      expect(titles(send)).toEqual([
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_recovered_title',
      ]);
      // A second episode warns and recovers again; each notice is sent once.
      await worker.at(windowMs + 2_000, warning);
      expect(send).toHaveBeenCalledTimes(3);
      expect(await worker.repo.readInvalidRequests()).toMatchObject({
        alerted: true,
        notice: { kind: 'invalid-requests' },
      });
      // The process has observed a whole window, so its count is authoritative at once.
      await worker.at(2 * windowMs + 3_000, 0);
      await worker.at(2 * windowMs + 70_000, 0);
      expect(titles(send)).toEqual([
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_recovered_title',
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_recovered_title',
      ]);
      expect(await worker.repo.readInvalidRequests()).toMatchObject({
        alerted: false,
        notice: { kind: 'invalid-requests-recovered', deliveredAt: expect.any(Number) },
      });
      await worker.monitor.stop();
    }));

  it('sends a recovery only after its warning was delivered', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      send.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
      const worker = workerProcess(connection, send, 0);
      await worker.at(1_000, warning);
      // The count settles while the warning still waits for its retry.
      await worker.at(windowMs + 1, 0);
      expect(await worker.repo.readInvalidRequests()).toMatchObject({
        alerted: true,
        notice: { kind: 'invalid-requests', attempts: 1 },
      });
      expect(
        await worker.repo.raiseInvalidRequestNotice({ kind: 'invalid-requests-recovered' }),
      ).toBe('waiting');
      await connection
        .collection<{ _id: string }>('archive_schedule')
        .updateOne({ _id: 'invalid-requests' }, { $set: { 'notice.retryAt': 0 } });
      await worker.at(windowMs + 70_000, 0);
      expect(titles(send)).toEqual([
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_title',
      ]);
      // The next check raises and sends the recovery behind the delivered warning.
      await worker.at(windowMs + 140_000, 0);
      expect(titles(send)).toEqual([
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_title',
        'replies:archive.notice_invalid_recovered_title',
      ]);
      await worker.monitor.stop();
    }));

  it('skips a guild whose database is disabled and logs a failing guild once a minute', async () =>
    withFreshConnection(async (connection) => {
      const send = vi.fn(async () => ({}));
      const worker = workerProcess(connection, send, 0);
      worker.isDisabled.mockReturnValue({ traceId: 'abc' });
      const raise = vi.spyOn(worker.repo, 'raiseInvalidRequestNotice');
      await worker.at(1_000, warning);
      expect(worker.isDisabled).toHaveBeenCalledWith('1');
      expect(raise).not.toHaveBeenCalled();
      // The slowdown does not depend on any guild database.
      expect(worker.scheduler.snapshot().backgroundLimit).toBe(4);
      worker.isDisabled.mockReturnValue(undefined);
      raise.mockRejectedValue(new Error('database timeout'));
      for (let check = 0; check < 5; check += 1) await worker.at(2_000 + check * 5_000, warning);
      const failures = () =>
        (worker.warn.mock.calls as unknown[][]).filter(
          ([, message]) => message === 'Archive invalid-request notice not recorded',
        );
      expect(failures()).toHaveLength(1);
      await worker.at(62_000, warning);
      expect(failures()).toHaveLength(2);
      raise.mockRestore();
      await worker.at(67_000, warning);
      expect(titles(send)).toEqual(['replies:archive.notice_invalid_title']);
      await worker.monitor.stop();
    }));
});
