import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveScheduleStore } from '../../../src/infra/archive/schedule';
import { withFreshConnection } from '../helpers/mongo';

afterEach(() => vi.restoreAllMocks());

describe('archive schedule persistence', () => {
  it('leaves due time and running revision unchanged when settings are repeated', async () =>
    withFreshConnection(async (connection) => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const store = new ArchiveScheduleStore(connection, 60_000);
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
      const store = new ArchiveScheduleStore(connection, 60_000);
      await store.update({});
      expect(await connection.collection('archive_schedule').countDocuments()).toBe(0);
      await store.update({ enabled: true });
      const disabled = await store.update({ enabled: false });
      expect(await store.update({ enabled: false })).toEqual(disabled);
    }));

  it('defaults disabled without creating data and persists overrides across instances', async () =>
    withFreshConnection(async (connection) => {
      const store = new ArchiveScheduleStore(connection, 3_600_000);
      expect(await store.read()).toMatchObject({ enabled: false, intervalMs: 3_600_000 });
      expect(await store.start()).toBeNull();
      expect(await connection.collection('archive_schedule').countDocuments()).toBe(0);
      await store.update({ intervalMs: 120_000 });
      expect(await new ArchiveScheduleStore(connection, 60_000).read()).toMatchObject({
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
      const store = new ArchiveScheduleStore(connection, 60_000);
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

  it('preserves commands during a running pass and detects disable followed by enable', async () =>
    withFreshConnection(async (connection) => {
      const store = new ArchiveScheduleStore(connection, 60_000);
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
      const store = new ArchiveScheduleStore(connection, 60_000);
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
});
