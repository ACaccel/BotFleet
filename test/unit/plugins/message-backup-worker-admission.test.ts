import { describe, expect, it, vi } from 'vitest';
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
      channelId: '20',
      kind: 'gap',
      observedAt: 1,
    });
    expect(initialize).not.toHaveBeenCalled();
    await worker.stop();
  });
});
