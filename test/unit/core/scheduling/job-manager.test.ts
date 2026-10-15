import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'node-schedule';

import { JobManager } from '../../../../src/core/scheduling';
import { silentLogger } from '../../../fixtures/runtime';
import { GuildLocaleContext } from '../../../../src/core/i18n';

// `JobManager` is a keyed wrapper around `node-schedule`. The scheduler
// itself is mocked so the tests stay deterministic and never register a
// real timer.
const scheduleJobMock = vi.fn();
vi.mock('node-schedule', () => ({
  default: {
    scheduleJob: (...args: unknown[]) => scheduleJobMock(...args),
  },
}));

/** Build a minimal fake `Job` whose `cancel()` can be asserted on. */
const fakeJob = (): Job => ({ cancel: vi.fn() }) as unknown as Job;

afterEach(() => {
  scheduleJobMock.mockReset();
});

describe('JobManager', () => {
  it('preserves guild identity when shared scheduler callbacks run in another guild and reschedule', () => {
    let zone = 'Asia/Taipei';
    const scope = new GuildLocaleContext((guildId) => ({
      language: 'en',
      timeZone: guildId === 'a' ? zone : 'UTC',
    }));
    scheduleJobMock.mockImplementation(() => fakeJob());
    const manager = new JobManager(new Map());
    const observed: string[] = [];
    scope.run('a', () =>
      manager.schedule('a', new Date(), () => {
        observed.push(scope.current.timeZone);
        manager.schedule('again', new Date(), () => {
          observed.push(scope.current.timeZone);
        });
      }),
    );
    zone = 'Europe/London';
    const first = scheduleJobMock.mock.calls[0]?.[1] as () => void;
    scope.run('b', first);
    zone = 'America/New_York';
    const second = scheduleJobMock.mock.calls[1]?.[1] as () => void;
    scope.run('b', second);
    expect(observed).toEqual(['Europe/London', 'America/New_York']);
    expect(scope.current.timeZone).toBe('UTC');
  });
  it('schedules a job, stores it under the key and returns it', () => {
    const job = fakeJob();
    scheduleJobMock.mockReturnValue(job);
    const jobs = new Map<string, Job>();
    const manager = new JobManager(jobs);
    const date = new Date('2030-01-01T00:00:00Z');
    const callback = () => undefined;

    const result = manager.schedule('giveaway:1', date, callback);

    expect(result).toBe(job);
    // The callback is wrapped (see the failure-routing cases below), so
    // the identity of the function handed to node-schedule differs.
    expect(scheduleJobMock).toHaveBeenCalledWith(date, expect.any(Function));
    expect(jobs.get('giveaway:1')).toBe(job);
  });

  it('schedules a recurring job from a cron expression under the key', () => {
    const job = fakeJob();
    scheduleJobMock.mockReturnValue(job);
    const jobs = new Map<string, Job>();
    const manager = new JobManager(jobs);
    const callback = () => undefined;

    const result = manager.scheduleRecurring('llm-chat:refresh', '0 4 * * 1', callback);

    expect(result).toBe(job);
    expect(scheduleJobMock).toHaveBeenCalledWith('0 4 * * 1', expect.any(Function));
    expect(jobs.get('llm-chat:refresh')).toBe(job);
  });

  it('scheduleRecurring replaces an existing job under the same key', () => {
    const first = fakeJob();
    const second = fakeJob();
    const jobs = new Map<string, Job>();
    const manager = new JobManager(jobs);

    scheduleJobMock.mockReturnValueOnce(first);
    manager.scheduleRecurring('k', '0 4 * * 1', () => undefined);
    scheduleJobMock.mockReturnValueOnce(second);
    manager.scheduleRecurring('k', '0 5 * * 1', () => undefined);

    expect(jobs.get('k')).toBe(second);
  });

  it('replaces an existing job registered under the same key', () => {
    const first = fakeJob();
    const second = fakeJob();
    const jobs = new Map<string, Job>();
    const manager = new JobManager(jobs);

    scheduleJobMock.mockReturnValueOnce(first);
    manager.schedule('k', new Date(), () => undefined);
    scheduleJobMock.mockReturnValueOnce(second);
    manager.schedule('k', new Date(), () => undefined);

    expect(jobs.get('k')).toBe(second);
  });

  it('cancels a stored job, removes it and reports success', () => {
    const job = fakeJob();
    const jobs = new Map<string, Job>([['k', job]]);
    const manager = new JobManager(jobs);

    const cancelled = manager.cancel('k');

    expect(cancelled).toBe(true);
    expect(job.cancel).toHaveBeenCalledTimes(1);
    expect(jobs.has('k')).toBe(false);
  });

  it('returns false when cancelling an unknown key', () => {
    const manager = new JobManager(new Map<string, Job>());

    expect(manager.cancel('missing')).toBe(false);
  });

  it('exposes get / has for stored jobs', () => {
    const job = fakeJob();
    const jobs = new Map<string, Job>([['k', job]]);
    const manager = new JobManager(jobs);

    expect(manager.get('k')).toBe(job);
    expect(manager.has('k')).toBe(true);
    expect(manager.get('absent')).toBeUndefined();
    expect(manager.has('absent')).toBe(false);
  });

  it('routes a rejected async callback to the logger instead of dropping it', async () => {
    // node-schedule discards its callback's return value, so a rejected
    // job used to surface only as a detached unhandledRejection.
    let fire: () => void = () => {};
    scheduleJobMock.mockImplementation((_when: unknown, cb: () => void) => {
      fire = cb;
      return fakeJob();
    });
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const manager = new JobManager(new Map<string, Job>(), logger);

    manager.schedule('giveaway:1', new Date('2030-01-01T00:00:00Z'), async () => {
      throw new Error('draw exploded');
    });
    fire();
    await new Promise<void>((r) => setImmediate(r));

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ job: 'giveaway:1' });
  });

  it('routes a synchronous throw to the logger', () => {
    let fire: () => void = () => {};
    scheduleJobMock.mockImplementation((_when: unknown, cb: () => void) => {
      fire = cb;
      return fakeJob();
    });
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const manager = new JobManager(new Map<string, Job>(), logger);

    manager.scheduleRecurring('refresh', '0 4 * * *', () => {
      throw new Error('sync boom');
    });

    expect(() => fire()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
