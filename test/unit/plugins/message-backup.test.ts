import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInitContext, PluginRuntimeContext } from '../../../src/core/plugin';
import { createMessageBackupPlugin } from '../../../src/plugins/message-backup';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { createLogger } from '../../../src/core/logger';

const fake = vi.hoisted(() => ({
  pollJobs: vi.fn(),
  scheduledPeriodic: vi.fn(),
  capture: vi.fn(),
  markGap: vi.fn(),
  cancel: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../../src/plugins/message-backup/runtime/worker', () => ({
  ArchiveWorker: vi.fn(function () {
    return fake;
  }),
}));
const context = () =>
  ({
    resolve: () => ({}),
    logger: createLogger({ level: 'silent', pretty: false }),
    translator: { t: (key: string) => key },
  }) as unknown as PluginInitContext;

describe('message archive lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const value of Object.values(fake)) value.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects invalid interval %s', (interval) => {
    expect(() =>
      createMessageBackupPlugin({ backupServers: ['1'], backupIntervalMs: interval }),
    ).toThrow();
  });
  it('rejects invalid policy/runtime instead of silently ignoring it', () => {
    expect(() =>
      createMessageBackupPlugin({ backupServers: ['1'], runtime: { concurrency: 0 } }),
    ).toThrow();
    expect(() =>
      createMessageBackupPlugin({ backupServers: ['1'], policy: { bots: [{ sourceId: 'bad' }] } }),
    ).toThrow();
  });
  it('keeps polling control jobs during a long scan without starting duplicate periodic work', async () => {
    let finish!: () => void;
    fake.scheduledPeriodic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const plugin = createMessageBackupPlugin({
      backupServers: ['1'],
      backupIntervalMs: 1000,
      runtime: { job_poll_seconds: 1 },
    });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.scheduledPeriodic).toHaveBeenCalledTimes(1);
    expect(fake.pollJobs).toHaveBeenCalledTimes(11);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.scheduledPeriodic).toHaveBeenCalledTimes(2);
    await plugin.onShutdown!(ctx);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.scheduledPeriodic).toHaveBeenCalledTimes(2);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate guild loops on repeated ready events or duplicate guild configuration', async () => {
    const plugin = createMessageBackupPlugin({
      backupServers: ['1', '1'],
      runtime: { job_poll_seconds: 1 },
    });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.pollJobs).toHaveBeenCalledTimes(1);
    expect(fake.scheduledPeriodic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.pollJobs).toHaveBeenCalledTimes(2);
    await plugin.onShutdown!(ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows the next control poll to signal preemption before a blocked periodic pass finishes', async () => {
    let finish!: () => void;
    let scanFinished = false;
    fake.scheduledPeriodic.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      scanFinished = true;
    });
    fake.pollJobs.mockImplementation(async () => {
      if (fake.pollJobs.mock.calls.length === 2) {
        expect(scanFinished).toBe(false);
        finish();
      }
    });
    const plugin = createMessageBackupPlugin({
      backupServers: ['1'],
      runtime: { job_poll_seconds: 1 },
    });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(scanFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanFinished).toBe(true);
    expect(fake.pollJobs).toHaveBeenCalledTimes(2);
    await plugin.onShutdown!(ctx);
  });

  it('drains simultaneous control polling and periodic work before releasing ownership', async () => {
    let finishScan!: () => void;
    let finishControl!: () => void;
    fake.scheduledPeriodic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishScan = resolve;
        }),
    );
    fake.pollJobs
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishControl = resolve;
          }),
      );
    const plugin = createMessageBackupPlugin({
      backupServers: ['1'],
      runtime: { job_poll_seconds: 1 },
    });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = plugin.onShutdown!(ctx);
    finishScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.stop).not.toHaveBeenCalled();
    finishControl();
    await stopped;
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('isolates guild failure and keeps polling', async () => {
    fake.pollJobs.mockRejectedValueOnce(new Error('unavailable'));
    const plugin = createMessageBackupPlugin({
      backupServers: ['1', '2'],
      runtime: { job_poll_seconds: 1 },
    });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.scheduledPeriodic).toHaveBeenCalledWith('2', 3_600_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.scheduledPeriodic).toHaveBeenCalledWith('1', 3_600_000);
    await plugin.onShutdown!(ctx);
  });
  it('waits for active work before releasing the owner', async () => {
    let finish!: () => void;
    fake.scheduledPeriodic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const plugin = createMessageBackupPlugin({ backupServers: ['1'] });
    const ctx = context();
    await plugin.init!(ctx);
    await plugin.onReady!(ctx);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = plugin.onShutdown!(ctx as PluginRuntimeContext);
    expect(fake.cancel).toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(fake.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('archive progress notification interval', () => {
  it.each([10])('accepts %s seconds', (seconds) => {
    expect(
      archiveRuntimeSchema.parse({ progress_interval_seconds: seconds }).progress_interval_seconds,
    ).toBe(seconds);
  });
  it.each([4, 5, 15, 30, 31, 10.5, NaN, Infinity])('rejects invalid interval %s', (seconds) => {
    expect(() => archiveRuntimeSchema.parse({ progress_interval_seconds: seconds })).toThrow();
  });
  it('defaults to a ten-second public heartbeat', () => {
    expect(archiveRuntimeSchema.parse({}).progress_interval_seconds).toBe(10);
  });
});
