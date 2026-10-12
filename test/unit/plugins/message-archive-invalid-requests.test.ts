import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_INVALID_REQUESTS } from '../../../src/core/archive/limits';
import { ArchiveInvalidRequestGuard } from '../../../src/plugins/message-backup/flow/invalid-request-guard';
import { ArchiveRestTelemetry } from '../../../src/plugins/message-backup/flow/rest-telemetry';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';

const { warning, critical, recovery, restoreStepMs, windowMs } = ARCHIVE_INVALID_REQUESTS;

describe('invalid-request thresholds', () => {
  it('stays below the ban limit with room to react', () => {
    expect(recovery).toBeLessThan(warning);
    expect(warning).toBeLessThan(critical);
    expect(critical).toBeLessThan(ARCHIVE_INVALID_REQUESTS.banLimit);
    expect(windowMs).toBe(600_000);
  });

  it('counts 401, 403 and non-shared 429 responses over ten minutes', () => {
    let now = 1_000_000;
    const telemetry = new ArchiveRestTelemetry(() => now);
    telemetry.response(401, null);
    telemetry.response(403, null);
    telemetry.response(429, 'user');
    telemetry.response(429, 'global', 'true');
    telemetry.response(429, null);
    // A shared-scope 429 is another application's limit; Discord does not count it.
    telemetry.response(429, 'shared');
    telemetry.response(404, null);
    telemetry.response(500, null);
    expect(telemetry.invalidLast10Minutes()).toBe(5);
    expect(telemetry.snapshot().invalidResponsesLast10Minutes).toBe(5);
    now += 601_000;
    expect(telemetry.invalidLast10Minutes()).toBe(0);
  });
});

describe('invalid-request guard', () => {
  it('halves background reads at warning, drops to one at critical and holds until recovery', () => {
    const guard = new ArchiveInvalidRequestGuard(32, 0);
    expect(guard.observe(warning - 1, 1)).toMatchObject({
      level: 'normal',
      backgroundLimit: undefined,
    });
    expect(guard.observe(warning, 2)).toMatchObject({
      level: 'warning',
      previous: 'normal',
      backgroundLimit: 16,
    });
    expect(guard.observe(critical, 3)).toMatchObject({
      level: 'critical',
      previous: 'warning',
      backgroundLimit: 1,
    });
    // Between recovery and warning the episode continues, slowed by half.
    expect(guard.observe(recovery, 4)).toMatchObject({ level: 'warning', backgroundLimit: 16 });
    expect(guard.observe(recovery - 1, 5)).toMatchObject({
      level: 'normal',
      previous: 'warning',
      backgroundLimit: 16,
    });
  });

  it('restores background reads gradually after recovery', () => {
    const guard = new ArchiveInvalidRequestGuard(32, 0);
    guard.observe(critical, 0);
    let now = 1;
    expect(guard.observe(0, now).backgroundLimit).toBe(1);
    expect(guard.observe(0, now + restoreStepMs - 1).backgroundLimit).toBe(1);
    const limits: (number | undefined)[] = [];
    for (let step = 1; step <= 6; step += 1) {
      now = 1 + step * restoreStepMs;
      limits.push(guard.observe(0, now).backgroundLimit);
    }
    expect(limits).toEqual([2, 4, 8, 16, undefined, undefined]);
    // A new episode during the restore slows reads again at once.
    expect(guard.observe(warning, now + 1).backgroundLimit).toBe(16);
  });

  it('never limits a single reader below one', () => {
    const guard = new ArchiveInvalidRequestGuard(1, 0);
    expect(guard.observe(warning, 1).backgroundLimit).toBe(1);
    expect(guard.observe(0, 2).backgroundLimit).toBe(1);
    expect(guard.observe(0, 2 + restoreStepMs).backgroundLimit).toBeUndefined();
    expect(() => new ArchiveInvalidRequestGuard(0, 0)).toThrow('invalid-archive-concurrency');
  });

  it('settles only after a whole window below recovery', () => {
    const guard = new ArchiveInvalidRequestGuard(8, 0);
    expect(guard.observe(0, windowMs - 1).settled).toBe(false);
    expect(guard.observe(recovery, windowMs).settled).toBe(false);
    expect(guard.observe(0, windowMs).settled).toBe(true);
    expect(guard.observe(warning, windowMs + 1).settled).toBe(false);
  });
});

describe('background admission limit', () => {
  it('caps history reads but never live reads', async () => {
    const scheduler = new ArchiveScheduler({ concurrency: 4 });
    scheduler.setBackgroundLimit(1);
    expect(scheduler.snapshot().backgroundLimit).toBe(1);
    const releases: (() => void)[] = [];
    const blocked = (key: string, priority: 'history' | 'live') =>
      scheduler.run(
        key,
        priority,
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
    const history = [blocked('history:1:a', 'history'), blocked('history:2:a', 'history')];
    const live = blocked('live:1', 'live');
    await Promise.resolve();
    expect(scheduler.snapshot()).toMatchObject({ active: 2, background: 1, queued: 1 });
    scheduler.setBackgroundLimit(undefined);
    expect(scheduler.snapshot()).toMatchObject({ active: 3, background: 2, queued: 0 });
    expect(scheduler.snapshot()).not.toHaveProperty('backgroundLimit');
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases) release();
    await Promise.all([...history, live]);
    expect(() => scheduler.setBackgroundLimit(0)).toThrow('invalid-archive-background-limit');
    scheduler.stop();
  });
});
