import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_PERIODIC_RETRY_DELAY_MS } from '../../../src/core/archive/schedule';
import { MongoArchiveScheduleRepo } from '../../../src/persistence/repositories/archive-schedule.repo';
import { withFreshConnection } from '../helpers/mongo';

afterEach(() => vi.restoreAllMocks());

describe('archive schedule persistence', () => {
  it('leaves due time and running revision unchanged when settings are repeated', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      const enabled = await store.update({ enabled: true, intervalMs: 120_000 });
      const started = await store.start();
      now += 10_000;
      expect(await store.update({ enabled: true })).toMatchObject({
        revision: enabled.revision,
        nextRunAt: enabled.nextRunAt,
        running: true,
      });
      expect(await store.update({ intervalMs: 120_000 })).toMatchObject({
        revision: enabled.revision,
        nextRunAt: enabled.nextRunAt,
      });
      await store.finish(started!.revision);
      const finished = await store.read();
      expect(finished.nextRunAt).toBe(now + 120_000);
      now += 10_000;
      await Promise.all([
        store.update({ enabled: true }),
        store.update({ intervalMs: 120_000 }),
        store.update({}),
      ]);
      expect(await store.read()).toEqual(finished);
      expect(await store.start()).toBeNull();
    }));

  it('does not create a schedule for an empty update or repeatedly request a pause', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({});
      expect(await connection.collection('archive_schedule').countDocuments()).toBe(0);
      await store.update({ enabled: true });
      const disabled = await store.update({ enabled: false });
      expect(await store.update({ enabled: false })).toEqual(disabled);
    }));

  it('defaults disabled without creating data and persists overrides across instances', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 3_600_000);
      expect(await store.read()).toMatchObject({ enabled: false, intervalMs: 3_600_000 });
      expect(await store.start()).toBeNull();
      expect(await connection.collection('archive_schedule').countDocuments()).toBe(0);
      await store.update({ intervalMs: 120_000 });
      expect(await new MongoArchiveScheduleRepo(connection, 60_000).read()).toMatchObject({
        enabled: false,
        intervalMs: 120_000,
        nextRunAt: null,
      });
      await expect(store.update({ intervalMs: 0 })).rejects.toThrow();
    }));

  it('starts immediately on enable and waits the configured interval after completion', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true });
      const started = await store.start();
      expect(started?.running).toBe(true);
      expect(await store.start()).toBeNull();
      now += 10_000;
      await store.finish(started!.revision);
      expect((await store.read()).nextRunAt).toBe(now + 60_000);
      expect(await store.start()).toBeNull();
      now += 60_000;
      expect(await store.start()).not.toBeNull();
      await store.recover();
      expect((await store.read()).running).toBe(false);
    }));

  it('starts a disabled schedule immediately when enable also sets an interval', async () =>
    withFreshConnection(async (connection) => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      expect(await store.update({ enabled: true, intervalMs: 3_600_000 })).toMatchObject({
        enabled: true,
        intervalMs: 3_600_000,
        nextRunAt: now,
      });
    }));

  it('schedules from the change time when enable changes the interval of an enabled schedule', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true, intervalMs: 3_600_000 });
      const started = await store.start();
      await store.finish(started!.revision);
      now += 60_000;
      // `enable minutes:30` on an enabled schedule is an interval change, not a new start.
      expect(await store.update({ enabled: true, intervalMs: 1_800_000 })).toMatchObject({
        enabled: true,
        intervalMs: 1_800_000,
        nextRunAt: now + 1_800_000,
      });
      expect(await store.start()).toBeNull();
    }));

  it('preserves commands during a running pass and detects disable followed by enable', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true });
      const started = await store.start();
      const disabled = await store.update({ enabled: false });
      expect(disabled.pauseVersion).toBeGreaterThan(started!.pauseVersion);
      await store.finish(started!.revision);
      expect(await store.start()).toBeNull();
      await store.update({ enabled: true });
      const restarted = await store.start();
      await store.update({ enabled: false });
      const enabled = await store.update({ enabled: true });
      await store.finish(restarted!.revision);
      expect((await store.read()).nextRunAt).toBe(enabled.nextRunAt);
      expect(await store.start()).not.toBeNull();
    }));

  it('keeps a concurrently changed interval and its next-run time', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true });
      const started = await store.start();
      const changed = await store.update({ intervalMs: 300_000 });
      await store.finish(started!.revision);
      expect(await store.read()).toMatchObject({
        intervalMs: 300_000,
        nextRunAt: changed.nextRunAt,
        running: false,
      });
    }));

  it('resumes an interrupted pass after the short retry delay, never later than the interval', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 3_600_000);
      await store.update({ enabled: true });
      const started = await store.start();
      now += 10_000;
      await store.finish(started!.revision, ARCHIVE_PERIODIC_RETRY_DELAY_MS);
      expect(await store.read()).toMatchObject({
        running: false,
        nextRunAt: now + ARCHIVE_PERIODIC_RETRY_DELAY_MS,
      });
      now += ARCHIVE_PERIODIC_RETRY_DELAY_MS;
      const retried = await store.start();
      expect(retried).not.toBeNull();
      // A retry delay longer than the interval is capped at the interval.
      await store.finish(retried!.revision, 7_200_000);
      expect((await store.read()).nextRunAt).toBe(now + 3_600_000);
      await expect(store.finish(retried!.revision, 0)).rejects.toThrow(TypeError);
      await expect(store.finish(retried!.revision, 1.5)).rejects.toThrow(TypeError);
      await expect(store.finish(retried!.revision, -1)).rejects.toThrow(TypeError);
      await expect(store.finish(retried!.revision, Number.NaN)).rejects.toThrow(TypeError);
    }));

  it('lets a command during an interrupted pass override its retry timer', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new MongoArchiveScheduleRepo(connection, 3_600_000);
      await store.update({ enabled: true });
      const started = await store.start();
      now += 10_000;
      const changed = await store.update({ intervalMs: 600_000 });
      await store.finish(started!.revision, ARCHIVE_PERIODIC_RETRY_DELAY_MS);
      expect((await store.read()).nextRunAt).toBe(changed.nextRunAt);
      const notDue = await store.start();
      expect(notDue).toBeNull();
      now = changed.nextRunAt!;
      const next = await store.start();
      await store.update({ enabled: false });
      await store.finish(next!.revision, ARCHIVE_PERIODIC_RETRY_DELAY_MS);
      expect(await store.read()).toMatchObject({ enabled: false, nextRunAt: null, running: false });
    }));

  it('raises one failing notice at the third consecutive failure and one recovered notice', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      await store.update({ enabled: true });
      const pass = async (health: Parameters<MongoArchiveScheduleRepo['finish']>[2]) => {
        const started = await store.start();
        await store.finish(started?.revision ?? (await store.read()).revision, undefined, health);
        await connection
          .collection<{ _id: string }>('archive_schedule')
          .updateOne({ _id: 'current' }, { $set: { nextRunAt: 0 } });
        return store.read();
      };
      await pass({ kind: 'failure', reason: 'other' });
      expect((await pass({ kind: 'failure', reason: 'permission' })).notice).toBeUndefined();
      // Interrupted passes neither count nor reset the streak.
      expect((await pass({ kind: 'neutral' })).failureStreak).toBe(2);
      const failing = await pass({ kind: 'failure', reason: 'capacity' });
      expect(failing).toMatchObject({
        failureStreak: 3,
        alerted: true,
        lastFailureReason: 'capacity',
        notice: { kind: 'failing', failures: 3, reason: 'capacity' },
      });
      await store.markNoticeDelivered(failing.notice!.createdAt);
      const repeated = await pass({ kind: 'failure', reason: 'other' });
      expect(repeated.failureStreak).toBe(4);
      expect(repeated.notice).toMatchObject({ kind: 'failing', deliveredAt: expect.any(Number) });
      const recovered = await pass({ kind: 'success' });
      expect(recovered).toMatchObject({
        failureStreak: 0,
        alerted: false,
        lastCompletedAt: expect.any(Number),
        notice: { kind: 'recovered', failures: 4 },
      });
      expect(recovered.notice?.deliveredAt).toBeUndefined();
      await store.markNoticeDelivered(recovered.notice!.createdAt);
      // A later complete pass without an earlier alert raises nothing new.
      expect((await pass({ kind: 'success' })).notice).toMatchObject({
        kind: 'recovered',
        deliveredAt: expect.any(Number),
      });
    }));

  it('records deferred and abandoned deliveries only on the notice they name', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      const schedule = connection.collection<{ _id: string }>('archive_schedule');
      await store.update({ enabled: true });
      const notice = { kind: 'failing', failures: 3, reason: 'other', createdAt: 100 };
      await schedule.updateOne({ _id: 'current' }, { $set: { notice } });
      await store.deferNotice(100, 2, 5_000);
      expect((await store.read()).notice).toEqual({ ...notice, attempts: 2, retryAt: 5_000 });
      await store.abandonNotice(100);
      expect((await store.read()).notice).toMatchObject({
        attempts: 2,
        retryAt: 5_000,
        abandonedAt: expect.any(Number),
      });
      // A newer notice raised meanwhile keeps its own delivery state.
      const newer = { kind: 'recovered', failures: 3, createdAt: 200 };
      await schedule.updateOne({ _id: 'current' }, { $set: { notice: newer } });
      await store.deferNotice(100, 3, 9_000);
      await store.abandonNotice(100);
      await store.markNoticeDelivered(100);
      expect((await store.read()).notice).toEqual(newer);
    }));

  it('replaces the pass summary reference and returns the one it replaced', async () =>
    withFreshConnection(async (connection) => {
      const store = new MongoArchiveScheduleRepo(connection, 60_000);
      // Progress may be published before any schedule settings have been saved.
      const first = { channelId: '10', messageId: '60', startedAt: 1000 };
      const second = { channelId: '10', messageId: '61', startedAt: 2000 };
      expect(await store.replaceSummary(first)).toBeUndefined();
      const reopened = new MongoArchiveScheduleRepo(connection, 60_000);
      expect(await reopened.read()).toMatchObject({
        enabled: false,
        intervalMs: 60_000,
        summary: first,
      });
      await store.update({ enabled: true });
      expect(await store.replaceSummary(second)).toEqual({
        channelId: '10',
        messageId: '60',
        startedAt: 1000,
      });
      expect((await store.read()).summary).toEqual(second);
      // Settings changes keep the summary reference.
      await store.update({ intervalMs: 120_000 });
      expect((await store.read()).summary).toEqual(second);
    }));
});
