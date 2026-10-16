import { describe, expect, it } from 'vitest';
import { ArchiveBackpressureError, ArchiveCapacityError } from '../../../src/core/archive/errors';
import { DatabaseError } from '../../../src/core/errors/external-service-error';
import { ArchiveStorageMonitor } from '../../../src/plugins/message-backup/runtime/storage-monitor';
import { ArchiveReactionRefreshError } from '../../../src/plugins/message-backup/flow/reactions';
import { ArchiveScheduler } from '../../../src/plugins/message-backup/flow/scheduler';
import {
  ARCHIVE_INBOX_MAX_ATTEMPTS,
  ARCHIVE_INBOX_MAX_CLAIMS,
  ARCHIVE_INBOX_TRANSIENT_WINDOW_MS,
  archiveInboxRetryDelay,
  classifyArchiveInboxFailure,
  decideArchiveInboxFailure,
} from '../../../src/plugins/message-backup/runtime/inbox-failure';
import { ArchiveSerialWriter } from '../../../src/plugins/message-backup/runtime/serial-writer';

const discordError = (code: number, status: number) =>
  Object.assign(new Error('Discord API error'), { code, status });
const never = () => new Promise<never>(() => undefined);
const rejection = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const LIMITS = { budgetBytes: 100, backgroundLimitBytes: 70, reserveBytes: 10 };
describe('classifyArchiveInboxFailure', () => {
  it.each([
    [discordError(10003, 404), 'deleted', 'discord-unknown-channel'],
    [discordError(50001, 403), 'denied', 'discord-50001-forbidden'],
    [discordError(50013, 403), 'denied', 'discord-50013-forbidden'],
    [discordError(20001, 403), 'denied', 'discord-20001-forbidden'],
  ])('treats an inaccessible source as terminal (%#)', (error, access, reason) => {
    expect(classifyArchiveInboxFailure(error)).toEqual({ kind: 'inaccessible', access, reason });
  });

  it('finds the Discord error behind an incomplete reaction refresh', () => {
    const error = new ArchiveReactionRefreshError('incomplete', [
      { complete: true },
      { complete: false, reason: 'cancelled', error: new Error('reaction-fetch-cancelled') },
      { complete: false, reason: 'denied', error: discordError(50001, 403) },
    ]);
    expect(error.reasons).toEqual(['cancelled', 'denied']);
    expect(error.cause).toMatchObject({ code: 50001 });
    expect(classifyArchiveInboxFailure(new Error('wrapped', { cause: error }))).toMatchObject({
      kind: 'inaccessible',
      access: 'denied',
    });
  });

  it('waits uncounted for errors thrown by real capacity producers', async () => {
    const writer = new ArchiveSerialWriter(1);
    void writer.run(never);
    const scheduler = new ArchiveScheduler({ concurrency: 1, maxQueued: 1 });
    void scheduler.run('a', 'history', never).catch(() => undefined);
    void scheduler.run('b', 'history', never).catch(() => undefined);
    const storage = new ArchiveStorageMonitor(
      async () => ({ measuredAt: Date.now(), usedBytes: 99, availableBytes: 1, roots: [] }),
      LIMITS,
    );
    const errors = [
      await rejection(writer.run(async () => undefined)),
      await rejection(scheduler.run('c', 'history', async () => undefined)),
      await rejection(storage.withReservation(30, false, async () => undefined)),
    ];
    scheduler.stop();
    expect(errors.map((error) => (error as Error).constructor)).toEqual([
      ArchiveBackpressureError,
      ArchiveBackpressureError,
      ArchiveCapacityError,
    ]);
    for (const error of errors)
      expect(classifyArchiveInboxFailure(error)).toEqual({ kind: 'capacity' });
    // A capacity message without the type is not capacity pressure.
    expect(classifyArchiveInboxFailure(new Error('Archive writer queue is full'))).toEqual({
      kind: 'retry',
    });
  });

  it.each([
    discordError(0, 503),
    Object.assign(new Error('Too many requests'), { status: 429 }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }),
    Object.assign(new Error('connection closed'), { name: 'MongoNetworkError' }),
    new DatabaseError({
      code: 'DATABASE_TIMEOUT',
      messageKey: 'errors:db.timeout',
      context: { operation: 'test' },
    }),
  ])('defers transient transport and database failures uncounted (%#)', (error) => {
    expect(classifyArchiveInboxFailure(error)).toEqual({ kind: 'transient' });
  });

  it.each([
    new Error('temporary REST failure'),
    Object.assign(new Error('Forbidden'), { status: 403 }),
    discordError(50035, 400),
    new DatabaseError({
      code: 'DATABASE_VALIDATION',
      messageKey: 'errors:db.validation',
      context: { operation: 'test' },
    }),
    'not an error',
  ])('counts anything else (%#)', (error) => {
    expect(classifyArchiveInboxFailure(error)).toEqual({ kind: 'retry' });
  });
});

describe('archiveInboxRetryDelay', () => {
  it('doubles from one minute and caps at one hour', () => {
    expect([0, 1, 2, 3, 6, 7, 10, 100].map(archiveInboxRetryDelay)).toEqual([
      60_000, 60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('decideArchiveInboxFailure', () => {
  const now = 1_000_000_000;

  it('pins the limits', () => {
    expect(ARCHIVE_INBOX_MAX_ATTEMPTS).toBe(10);
    expect(ARCHIVE_INBOX_MAX_CLAIMS).toBe(50);
    expect(ARCHIVE_INBOX_TRANSIENT_WINDOW_MS).toBe(86_400_000);
  });

  it.each([
    [0, { kind: 'defer', attempts: 1, retryAt: now + 60_000 }],
    [9, { kind: 'defer', attempts: 10, retryAt: now + 3_600_000 }],
    [10, { kind: 'dead', attempts: 11 }],
  ] as const)('counts a failure after %i attempts', (attempts, expected) => {
    expect(decideArchiveInboxFailure({ kind: 'retry' }, { attempts }, now)).toEqual({
      ...expected,
      firstFailedAt: now,
    });
  });

  it('keeps the first failure time across counted failures', () => {
    expect(
      decideArchiveInboxFailure({ kind: 'retry' }, { attempts: 2, firstFailedAt: 5 }, now),
    ).toMatchObject({ kind: 'defer', firstFailedAt: 5 });
  });

  it('defers capacity pressure without touching the counters', () => {
    expect(decideArchiveInboxFailure({ kind: 'capacity' }, { attempts: 4 }, now)).toEqual({
      kind: 'defer',
      retryAt: now + 300_000,
      attempts: 4,
    });
  });

  it.each([
    [undefined, { kind: 'defer', retryAt: now + 60_000, firstFailedAt: now }],
    [now - 30_000, { kind: 'defer', retryAt: now + 60_000, firstFailedAt: now - 30_000 }],
    [now - 600_000, { kind: 'defer', retryAt: now + 600_000, firstFailedAt: now - 600_000 }],
    [
      now - 86_400_000 + 1,
      { kind: 'defer', retryAt: now + 3_600_000, firstFailedAt: now - 86_400_000 + 1 },
    ],
    [now - 86_400_000, { kind: 'dead', firstFailedAt: now - 86_400_000 }],
  ] as const)(
    'bounds uncounted transient retries by time since the first failure (%s)',
    (firstFailedAt, expected) => {
      expect(
        decideArchiveInboxFailure(
          { kind: 'transient' },
          { attempts: 3, ...(firstFailedAt === undefined ? {} : { firstFailedAt }) },
          now,
        ),
      ).toEqual({ ...expected, attempts: 3 });
    },
  );

  it('records an inaccessible source as a terminal gap', () => {
    expect(
      decideArchiveInboxFailure(
        { kind: 'inaccessible', access: 'denied', reason: 'discord-50001-forbidden' },
        { attempts: 0 },
        now,
      ),
    ).toEqual({ kind: 'gap', access: 'denied', reason: 'discord-50001-forbidden' });
  });
});
