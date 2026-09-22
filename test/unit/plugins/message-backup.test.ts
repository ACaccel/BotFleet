import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../../src/core/logger';
import { TOKENS } from '../../../src/bot/tokens';
import type { PluginRuntimeContext } from '../../../src/core/plugin';
import { createMessageBackupPlugin } from '../../../src/plugins/message-backup';
import { performBackup } from '../../../src/plugins/message-backup/internal';

// Replace the heavy internal backup implementation with a controllable
// spy so the loop-resilience tests can force a pass to throw without
// touching Discord or Mongo. `vi.mock` is hoisted above the imports by
// vitest, so the spy is registered before the plugin module loads.
vi.mock('../../../src/plugins/message-backup/internal', () => ({
  performBackup: vi.fn(),
}));

describe('createMessageBackupPlugin', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects a non-positive, non-finite, or over-ceiling `backupIntervalMs` (%s)',
    (bad) => {
      expect(() =>
        createMessageBackupPlugin({ backupServers: ['1'], backupIntervalMs: bad }),
      ).toThrow(TypeError);
    },
  );

  it('accepts `backupIntervalMs` exactly at Node’s timer ceiling', () => {
    const p = createMessageBackupPlugin({ backupServers: ['1'], backupIntervalMs: 2_147_483_647 });
    expect(p.id).toBe('message-backup');
  });
});

describe('createMessageBackupPlugin onReady loop resilience', () => {
  const mockedPerformBackup = vi.mocked(performBackup);

  const buildCtx = (): PluginRuntimeContext =>
    ({
      logger: createLogger({ level: 'silent', pretty: false }),
      // onReady resolves only the registry + client; both are unused
      // because performBackup is mocked, so a stub satisfies the seam.
      resolve: (token: unknown) => (token === TOKENS.GuildRegistry ? {} : {}),
    }) as unknown as PluginRuntimeContext;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedPerformBackup.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports ready during the first pass and schedules repeats only after it completes', async () => {
    let finish: () => void = () => {};
    mockedPerformBackup
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const plugin = createMessageBackupPlugin({ backupServers: ['g1'], backupIntervalMs: 1000 });
    const ctx = buildCtx();

    await plugin.onReady!(ctx);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(2);
    await plugin.onShutdown!(ctx);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(2);
  });

  it('does not start another guild or repeat after shutdown during the initial pass', async () => {
    let finish: () => void = () => {};
    mockedPerformBackup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const plugin = createMessageBackupPlugin({
      backupServers: ['g1', 'g2'],
      backupIntervalMs: 1000,
    });
    const ctx = buildCtx();

    await plugin.onReady!(ctx);
    await plugin.onShutdown!(ctx);
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockedPerformBackup.mock.calls.map((call) => call[0])).toEqual(['g1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs up only the guilds present at construction, ignoring a later push into the caller array', async () => {
    mockedPerformBackup.mockResolvedValue(undefined);
    const servers = ['g1', 'g2'];
    const plugin = createMessageBackupPlugin({ backupServers: servers, backupIntervalMs: 1000 });
    // The caller keeps its array; the plugin must have taken a copy.
    servers.push('g3');
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    await onReady(ctx);

    expect(mockedPerformBackup.mock.calls.map((call) => call[0])).toEqual(['g1', 'g2']);

    await onShutdown(ctx);
  });

  it('runs the next pass one default hour later when `backupIntervalMs` is omitted', async () => {
    mockedPerformBackup.mockResolvedValue(undefined);
    const plugin = createMessageBackupPlugin({ backupServers: ['g1'] });
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    await onReady(ctx);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);

    // Just short of the hour: the loop must not have fired again.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(2);

    await onShutdown(ctx);
  });

  it('keeps the repeat loop alive after a failing backup pass', async () => {
    mockedPerformBackup
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(undefined);
    const plugin = createMessageBackupPlugin({ backupServers: ['g1'], backupIntervalMs: 1000 });
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    // The immediate pass fails internally but must not reject onReady.
    await expect(onReady(ctx)).resolves.toBeUndefined();
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);

    // The loop must reschedule and run the next pass despite the failure.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(2);

    await onShutdown(ctx);
  });

  it('isolates a per-guild failure so later guilds in the same pass still run', async () => {
    mockedPerformBackup.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const plugin = createMessageBackupPlugin({
      backupServers: ['g1', 'g2'],
      backupIntervalMs: 1000,
    });
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    await expect(onReady(ctx)).resolves.toBeUndefined();
    // g1's throw did not abort the pass — g2 was still attempted.
    expect(mockedPerformBackup).toHaveBeenCalledTimes(2);

    await onShutdown(ctx);
  });

  it('threads transcript logging off by default (writeTranscript=false)', async () => {
    mockedPerformBackup.mockResolvedValue(undefined);
    // `backupLogEnabled` omitted → defaults to false; the backup still runs.
    const plugin = createMessageBackupPlugin({ backupServers: ['g1'], backupIntervalMs: 1000 });
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    await onReady(ctx);
    expect(mockedPerformBackup).toHaveBeenCalledTimes(1);
    expect(mockedPerformBackup).toHaveBeenCalledWith(
      'g1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
    );

    await onShutdown(ctx);
  });

  it('threads transcript logging on when backupLogEnabled is set (writeTranscript=true)', async () => {
    mockedPerformBackup.mockResolvedValue(undefined);
    const plugin = createMessageBackupPlugin({
      backupServers: ['g1'],
      backupIntervalMs: 1000,
      backupLogEnabled: true,
    });
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('message-backup plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();

    await onReady(ctx);
    expect(mockedPerformBackup).toHaveBeenCalledWith(
      'g1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
    );

    await onShutdown(ctx);
  });
});
