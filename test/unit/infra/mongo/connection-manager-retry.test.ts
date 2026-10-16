/**
 * Unit coverage for the resilience contract of
 * `ConnectionManager`: transient-failure retry with bounded backoff,
 * persistent-failure / retry-exhaustion disabling, and the
 * `isDisabled` query surface.
 *
 * Uses `StaticConnectionManager`'s `openOverride` failure-injection
 * hook so the retry / disable behaviour is exercised deterministically
 * without a real cluster. Backoff is driven through an injected no-op
 * `sleep`, so the suite runs in zero wall time while still asserting
 * the delay schedule.
 */
import mongoose, { type Connection } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asGuildId } from '../../../../src/core/ids';
import { DatabaseError } from '../../../../src/core/errors';
import {
  MongoConnectionManager,
  StaticConnectionManager,
  type GuildConnection,
  type RetryPolicy,
} from '../../../../src/infra/mongo/connection-manager';

const guildId = asGuildId('123456789012345678');

// `openOverride` bypasses `buildModels`, so the underlying connection
// is never dereferenced — a typed stub is sufficient for these tests.
const fakeConnection = {} as Connection;

const fastPolicy: RetryPolicy = { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000 };

const transientError = (): DatabaseError =>
  new DatabaseError({
    code: 'DATABASE_TIMEOUT',
    messageKey: 'errors.db.timeout',
    context: { operation: 'test.open' },
  });

const persistentError = (): DatabaseError =>
  new DatabaseError({
    code: 'DATABASE_UNKNOWN',
    messageKey: 'errors.db.unavailable',
    context: { operation: 'test.open' },
  });

const guildConnection = (): GuildConnection =>
  ({ guildId, connection: fakeConnection }) as unknown as GuildConnection;

describe('ConnectionManager — retry / disable', () => {
  it('retries a transient failure and succeeds within the attempt budget', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      calls += 1;
      if (calls < 3) throw transientError();
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep,
      openOverride,
    });

    const conn = await mgr.getConnection(guildId);

    expect(conn.guildId).toBe(guildId);
    expect(openOverride).toHaveBeenCalledTimes(3);
    // Two retries -> two backoff sleeps: 100ms then 200ms.
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    // A guild that ultimately connected is not disabled.
    expect(mgr.isDisabled(guildId)).toBeUndefined();
  });

  it('disables the guild after transient retries are exhausted', async () => {
    const sleep = vi.fn(async () => {});
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw transientError();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep,
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);

    // 3 attempts total, 2 backoff sleeps in between.
    expect(openOverride).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const disabled = mgr.isDisabled(guildId);
    expect(disabled).toBeDefined();
    expect(disabled?.traceId).toMatch(/^[0-9a-z]{6}$/);
    expect(disabled?.error.code).toBe('DATABASE_TIMEOUT');
  });

  it('disables the guild immediately on a persistent failure without retrying', async () => {
    const sleep = vi.fn(async () => {});
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw persistentError();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep,
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);

    // Persistent failure: a single attempt, no backoff sleeps.
    expect(openOverride).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(mgr.isDisabled(guildId)?.error.code).toBe('DATABASE_UNKNOWN');
  });

  it('short-circuits subsequent getConnection calls for a disabled guild', async () => {
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw persistentError();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep: async () => {},
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);

    // The second call must NOT hit `open` again — the disabled marker
    // short-circuits without touching the cluster.
    expect(openOverride).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable traceId across repeated failures of the same guild', async () => {
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw persistentError();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep: async () => {},
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    const first = mgr.isDisabled(guildId)?.traceId;
    // Re-query: the marker is the durable record; the traceId never
    // changes once stamped so log/ticket correlation stays valid.
    expect(mgr.isDisabled(guildId)?.traceId).toBe(first);
  });

  it('clears the disabled marker on close so a recovered guild can retry', async () => {
    let shouldFail = true;
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      if (shouldFail) throw persistentError();
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      sleep: async () => {},
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(mgr.isDisabled(guildId)).toBeDefined();

    await mgr.close(guildId);
    expect(mgr.isDisabled(guildId)).toBeUndefined();

    // After the database recovers, the next getConnection succeeds.
    shouldFail = false;
    const conn = await mgr.getConnection(guildId);
    expect(conn.guildId).toBe(guildId);
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const sleep = vi.fn(async () => {});
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw transientError();
    });
    // 5 attempts -> 4 backoff sleeps: 100, 200, 400, then capped at 500.
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 500 },
      sleep,
      openOverride,
    });

    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(sleep.mock.calls).toEqual([[100], [200], [400], [500]]);
  });

  it('discards an open that finishes after closeAll instead of caching it', async () => {
    let releaseOpen: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      await opening;
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      openOverride,
    });

    const pending = mgr.getConnection(guildId).catch((e: unknown) => e);
    // Tear down while the open is still in flight.
    const closing = mgr.closeAll();
    releaseOpen();
    await closing;

    // `closeAll` closes exactly the connections it can see; a late
    // arrival cached behind its back would never be closed again.
    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(((await pending) as Error).message).toMatch(/closed while it was opening/);
    // ...and the teardown leaves no disabled marker behind.
    expect(mgr.isDisabled(guildId)).toBeUndefined();
  });

  it('waits for an in-flight open before closeAll resolves', async () => {
    const timeline: string[] = [];
    let releaseOpen: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      await opening;
      timeline.push('open-settled');
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      openOverride,
    });

    void mgr.getConnection(guildId).catch(() => undefined);
    const closing = mgr.closeAll().then(() => {
      timeline.push('closeAll-resolved');
    });

    // Hold the open open for a few turns; without the drain `closeAll`
    // resolves here and the ordering below inverts.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(timeline).toEqual([]);

    releaseOpen();
    await closing;

    expect(timeline).toEqual(['open-settled', 'closeAll-resolved']);
  });

  it('refuses new connections while closeAll is running', async () => {
    let releaseOpen: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      await opening;
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      openOverride,
    });

    void mgr.getConnection(guildId).catch(() => undefined);
    const closing = mgr.closeAll();
    // The generation counter only covers opens that started *before*
    // the teardown; `closeAll` yields twice, so new work has to be
    // refused outright for the window.
    await expect(mgr.getConnection(guildId)).rejects.toThrow(/closed while it was opening/);

    releaseOpen();
    await closing;

    // ...and the manager is usable again once the teardown finishes.
    await expect(mgr.getConnection(guildId)).resolves.toBeDefined();
  });

  it('gives up on an in-flight open that never settles', async () => {
    const openOverride = vi.fn(
      () =>
        new Promise<GuildConnection>(() => {
          /* never settles */
        }),
    );
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      openOverride,
    });

    void mgr.getConnection(guildId).catch(() => undefined);
    vi.useFakeTimers();
    const closing = mgr.closeAll();
    await vi.advanceTimersByTimeAsync(2_000);
    // An open retrying against a dead cluster must not consume the
    // process-level shutdown budget.
    await expect(closing).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('does not mark the guild disabled when an open loses a shutdown race', async () => {
    let releaseOpen: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      await opening;
      return guildConnection();
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      openOverride,
    });

    const pending = mgr.getConnection(guildId).catch((e: unknown) => e);
    const closing = mgr.closeAll();
    releaseOpen();
    await closing;

    // An ordinary Ctrl+C is not a cluster failure; classifying it as one
    // wrote an alarming "[mongo] guild … disabled" line on every clean
    // shutdown that raced an open.
    await expect(pending).resolves.not.toBeInstanceOf(DatabaseError);
    expect(mgr.isDisabled(guildId)).toBeUndefined();
  });

  it('wraps a non-DatabaseError thrown by open into a typed DatabaseError', async () => {
    const openOverride = vi.fn(async (): Promise<GuildConnection> => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:27017');
    });
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 10 },
      sleep: async () => {},
      openOverride,
    });

    const rejection = await mgr.getConnection(guildId).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(DatabaseError);
    // ECONNREFUSED is classified as a network failure.
    expect((rejection as DatabaseError).code).toBe('DATABASE_NETWORK');
  });
});

describe('ConnectionManager — automatic recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createManager = (
    openOverride: (id: ReturnType<typeof asGuildId>) => Promise<GuildConnection>,
  ) =>
    new StaticConnectionManager(fakeConnection, {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      recoveryIntervalMs: 1_000,
      openOverride,
    });

  it('recovers a production connection without closing another healthy guild', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const close = vi.fn(async () => {});
    const model = { init: vi.fn(async () => {}) };
    const connection = { model: vi.fn(() => model), close } as unknown as Connection;
    const asPromise = vi
      .fn<() => Promise<Connection>>()
      .mockResolvedValueOnce(connection)
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue(connection);
    const create = vi
      .spyOn(mongoose, 'createConnection')
      .mockReturnValue({ asPromise } as unknown as Connection);
    const mgr = new MongoConnectionManager(
      'mongodb://localhost/',
      {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
      },
      undefined,
      1_000,
    );
    const otherGuild = asGuildId('987654321098765432');
    const healthy = await mgr.getConnection(otherGuild);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(mgr.getConnection(guildId)).resolves.toMatchObject({ guildId });
    expect(mgr.isDisabled(guildId)).toBeUndefined();
    await expect(mgr.getConnection(otherGuild)).resolves.toBe(healthy);
    expect(create).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    await mgr.closeAll();
  });

  it('retries only after cooldown and caches the recovered connection', async () => {
    vi.useFakeTimers();
    const recovered = guildConnection();
    const open = vi
      .fn<() => Promise<GuildConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue(recovered);
    const mgr = createManager(open);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    await vi.advanceTimersByTimeAsync(999);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(mgr.getConnection(guildId)).resolves.toBe(recovered);
    expect(mgr.isDisabled(guildId)).toBeUndefined();
    await expect(mgr.getConnection(guildId)).resolves.toBe(recovered);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('retains the marker and deduplicates concurrent recovery attempts', async () => {
    vi.useFakeTimers();
    let release: (entry: GuildConnection) => void = () => {};
    const recovering = new Promise<GuildConnection>((resolve) => {
      release = resolve;
    });
    const open = vi
      .fn<() => Promise<GuildConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockReturnValue(recovering);
    const mgr = createManager(open);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    const disabled = mgr.isDisabled(guildId);
    await vi.advanceTimersByTimeAsync(1_000);
    const first = mgr.getConnection(guildId);
    const second = mgr.getConnection(guildId);
    expect(open).toHaveBeenCalledTimes(2);
    expect(mgr.isDisabled(guildId)).toBe(disabled);
    const recovered = guildConnection();
    release(recovered);
    expect(await Promise.all([first, second])).toEqual([recovered, recovered]);
    expect(mgr.isDisabled(guildId)).toBeUndefined();
  });

  it('refreshes cooldown after another transient failure while preserving trace id', async () => {
    vi.useFakeTimers();
    const open = vi.fn<() => Promise<GuildConnection>>().mockRejectedValue(transientError());
    const mgr = createManager(open);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    const traceId = mgr.isDisabled(guildId)?.traceId;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(mgr.isDisabled(guildId)?.traceId).toBe(traceId);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('stops recovery when a retry discovers a persistent error', async () => {
    vi.useFakeTimers();
    const permanent = persistentError();
    const open = vi
      .fn<() => Promise<GuildConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValue(permanent);
    const mgr = createManager(open);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(mgr.getConnection(guildId)).rejects.toBe(permanent);
    expect(mgr.isDisabled(guildId)?.error).toBe(permanent);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(mgr.getConnection(guildId)).rejects.toBe(permanent);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not restore a disabled marker when recovery rejects after shutdown drains out', async () => {
    vi.useFakeTimers();
    let rejectOpen: (error: Error) => void = () => {};
    const recovering = new Promise<GuildConnection>((_resolve, reject) => {
      rejectOpen = reject;
    });
    const open = vi
      .fn<() => Promise<GuildConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockReturnValue(recovering);
    const mgr = createManager(open);
    await expect(mgr.getConnection(guildId)).rejects.toBeInstanceOf(DatabaseError);
    await vi.advanceTimersByTimeAsync(1_000);
    const recovery = mgr.getConnection(guildId).catch((error: unknown) => error);
    const closing = mgr.closeAll();
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    rejectOpen(transientError());
    expect(await recovery).toMatchObject({ name: 'ShutdownRaceError' });
    expect(mgr.isDisabled(guildId)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not resume retry backoff after shutdown', async () => {
    let release: () => void = () => {};
    const backoff = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = vi.fn<() => Promise<GuildConnection>>().mockRejectedValue(transientError());
    const sleep = vi.fn(() => backoff);
    const mgr = new StaticConnectionManager(fakeConnection, {
      retryPolicy: fastPolicy,
      openOverride: open,
      sleep,
    });
    const pending = mgr.getConnection(guildId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    const closing = mgr.closeAll();
    release();
    await closing;
    expect(await pending).toMatchObject({ name: 'ShutdownRaceError' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(mgr.isDisabled(guildId)).toBeUndefined();
  });
});
