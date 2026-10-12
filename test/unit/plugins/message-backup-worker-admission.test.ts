import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_INVALID_REQUESTS } from '../../../src/core/archive/limits';
import { ArchiveInvalidRequestMonitor } from '../../../src/plugins/message-backup/runtime/invalid-request-monitor';
import { ArchiveWorker } from '../../../src/plugins/message-backup/runtime/worker';
import { archiveRuntimeSchema } from '../../../src/plugins/message-backup/config';
import { ArchivePolicySchema } from '../../../src/core/archive/policy';
import { createLogger } from '../../../src/core/logger';

it('bounds capture before initialization and drains initialization-waiting events on shutdown', async () => {
  const options = {
    client: { rest: {} },
    logger: createLogger({ level: 'silent', pretty: false }),
    guildIds: ['1'],
    config: archiveRuntimeSchema.parse({ max_pending_events: 1 }),
    policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
  } as unknown as ConstructorParameters<typeof ArchiveWorker>[0];
  const worker = new ArchiveWorker(options);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const initialize = vi.spyOn(worker, 'initialize').mockImplementation(async () => {
    await blocked;
    throw new Error('initialization unavailable');
  });
  const event = {
    eventId: 'first',
    guildId: '1',
    channelId: '10',
    messageId: '100',
    observedAt: 1,
    kind: 'delete' as const,
    bulk: false,
  };
  const first = worker.capture(event).catch((error: unknown) => error);
  await expect(worker.capture({ ...event, eventId: 'second' })).rejects.toThrow('queue overflow');
  expect(initialize).toHaveBeenCalledTimes(1);
  let drained = false;
  const shutdown = worker.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  expect(await first).toBeInstanceOf(Error);
  await shutdown;
  expect(drained).toBe(true);
});

describe('capture admission scope', () => {
  it('ignores out-of-scope events without initializing a database', async () => {
    const worker = new ArchiveWorker({
      client: { rest: {} },
      logger: createLogger({ level: 'silent', pretty: false }),
      guildIds: ['1'],
      config: archiveRuntimeSchema.parse({}),
      policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
    } as unknown as ConstructorParameters<typeof ArchiveWorker>[0]);
    const initialize = vi.spyOn(worker, 'initialize');
    await worker.capture({
      eventId: 'outside',
      guildId: '2',
      kind: 'gap',
      reason: 'test',
      observedAt: 1,
    });
    expect(initialize).not.toHaveBeenCalled();
    await worker.stop();
  });
});

describe('invalid-request protection wiring', () => {
  it('checks the shared REST count from start to stop and slows background reads', async () => {
    const rest = new EventEmitter();
    const logger = createLogger({ level: 'silent', pretty: false });
    const warn = vi.spyOn(logger, 'warn');
    const check = vi.spyOn(ArchiveInvalidRequestMonitor.prototype, 'check');
    const worker = new ArchiveWorker({
      client: { rest },
      logger,
      guildIds: ['1'],
      config: archiveRuntimeSchema.parse({ concurrency: 8 }),
      policy: ArchivePolicySchema.parse({ guildIds: ['1'] }),
      invalidRequestCheckMs: 10,
    } as unknown as ConstructorParameters<typeof ArchiveWorker>[0]);
    try {
      const forbidden = { status: 403, headers: { get: () => null } };
      for (let index = 0; index < ARCHIVE_INVALID_REQUESTS.warning; index += 1)
        rest.emit('response', {}, forbidden);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            invalidLast10Minutes: ARCHIVE_INVALID_REQUESTS.warning,
            level: 'warning',
            backgroundLimit: 4,
          }),
          'Archive invalid Discord requests high; slowing background reads',
        ),
      );
      await worker.stop();
      const checks = check.mock.calls.length;
      expect(checks).toBeGreaterThan(0);
      // Stopped: no further checks, and the REST listener is gone.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(check.mock.calls.length).toBe(checks);
      expect(rest.listenerCount('response')).toBe(0);
    } finally {
      await worker.stop();
      check.mockRestore();
    }
  });
});
