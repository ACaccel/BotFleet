/**
 * Per-guild MongoDB connection lifecycle.
 *
 * Owns the SDK boundary to mongoose: opening, closing, and tracking
 * one `Connection` per guild id. Repositories receive a `Connection`
 * (via {@link ConnectionManager.getConnection}) and never touch
 * `mongoose.createConnection` themselves — that keeps `persistence/`
 * free of SDK lifecycle concerns and makes test substitution trivial.
 *
 * Why `infra/mongo/` and not `persistence/`:
 *   `persistence/` owns the mapping from domain to storage (schemas +
 *   repositories). Connection acquisition is the SDK boundary, the same
 *   category as a Discord client or LLM HTTP client, per the layer
 *   rules that keep SDK boundaries out of `persistence/`.
 *
 * Resilience:
 *   `getConnection` classifies a failed open via the `persistence/`
 *   error-translator. A *transient* failure (`DATABASE_TIMEOUT` /
 *   `DATABASE_NETWORK`) is retried with bounded exponential backoff; a
 *   *persistent* failure — or a transient one whose retries are
 *   exhausted — marks the guild **disabled**. Transiently disabled guilds
 *   become eligible for another bounded attempt after a configurable
 *   cooldown. Persistent failures remain disabled until {@link close} /
 *   {@link closeAll} clears the marker. Each disabled marker carries a
 *   generated `traceId` so the user-facing `errors:db.guild_disabled`
 *   message can be grep-correlated to the structured boot log.
 *
 *   Per-URI sharing: `MongoConnectionManager` instances are pooled by
 *   base URI in the composition root (`BaseBot.sharedConnectionManagers`).
 *   Because the disabled set is now manager-internal state, two bots
 *   that share one base URI also share one disabled set — a guild
 *   disabled for one is disabled for the other. This is intentional:
 *   they target the same physical database, so the failure is the
 *   same failure.
 */
import mongoose, { type Connection, type Model } from 'mongoose';
import type { GuildId } from '../../core/ids';
import { SCHEMAS, type DocByName, type SchemaName } from '../../persistence/schemas';
import { DatabaseError } from '../../core/errors/external-service-error';
import { databaseErrorFrom, isTransient } from '../../persistence/error-translator';

/** Typed model registry for one guild connection. */
export type Models = {
  readonly [K in SchemaName]: Model<DocByName[K]>;
};

export interface GuildConnection {
  readonly guildId: GuildId;
  readonly connection: Connection;
  readonly models: Models;
}

/**
 * Disabled-guild marker. Returned by {@link ConnectionManager.isDisabled}
 * so the handler layer can render `errors:db.guild_disabled` with a
 * `traceId` that matches the structured log line written when the
 * guild was disabled.
 */
export interface DisabledGuildState {
  /** Stable id linking the user-facing message to the boot log. */
  readonly traceId: string;
  /** The classified failure that caused the guild to be disabled. */
  readonly error: DatabaseError;
}

/**
 * Bounded-backoff retry policy for transient connection failures.
 *
 * Defaults: up to 3 attempts (1 initial + 2 retries), 200 ms initial
 * delay doubling each retry, capped at 2 s. The policy is constructor-
 * injectable so tests can drive deterministic, fast retries.
 */
export interface RetryPolicy {
  /** Total attempts including the first. Must be >= 1. */
  readonly maxAttempts: number;
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Upper bound on any single backoff delay, in milliseconds. */
  readonly maxDelayMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
});

/**
 * Upper bound on how long {@link ConnectionManager.closeAll} waits for
 * an in-flight open to settle. An open caught mid-retry against a dead
 * cluster can hold for tens of seconds — which is exactly when a
 * SIGTERM arrives — and the process-level shutdown budget is 5s. Better
 * to abandon the drain than to have the whole graceful path force-exit.
 */
const CLOSE_DRAIN_TIMEOUT_MS = 1_500;
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;

interface RecoveryState extends DisabledGuildState {
  readonly retryAt: number;
}

const validateRecoveryInterval = (intervalMs: number): void => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('recoveryIntervalMs must be a positive safe integer');
  }
};

/** Injectable sleep so tests advance backoff without real wall time. */
type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Generate a short, stable trace id for correlating logs to user messages. */
const generateTraceId = (): string => Math.random().toString(36).slice(2, 8).padStart(6, '0');

/**
 * Validate and assemble a per-guild MongoDB URI.
 *
 * Discord snowflake ids are digit-only; rejecting anything else here
 * prevents URI injection via crafted guild ids (e.g. a `guildId` that
 * embeds `?` would silently rewrite the connection's query string).
 */
export const buildGuildMongoUri = (baseUri: string, guildId: string): string => {
  if (guildId.length === 0) {
    throw new TypeError('buildGuildMongoUri: guildId must be non-empty');
  }
  if (!/^\d+$/.test(guildId)) {
    throw new TypeError(`buildGuildMongoUri: guildId must be all digits, got "${guildId}"`);
  }
  return `${baseUri}${guildId}?authSource=admin`;
};

const buildModels = (connection: Connection): Models => ({
  Fetch: connection.model<DocByName['Fetch']>('Fetch', SCHEMAS.Fetch),
  Message: connection.model<DocByName['Message']>('Message', SCHEMAS.Message),
  Reply: connection.model<DocByName['Reply']>('Reply', SCHEMAS.Reply),
  Giveaway: connection.model<DocByName['Giveaway']>('Giveaway', SCHEMAS.Giveaway),
  Activity: connection.model<DocByName['Activity']>('Activity', SCHEMAS.Activity),
  TempRole: connection.model<DocByName['TempRole']>('TempRole', SCHEMAS.TempRole),
  UserApiSetting: connection.model<DocByName['UserApiSetting']>(
    'UserApiSetting',
    SCHEMAS.UserApiSetting,
  ),
  FeedSubscription: connection.model<DocByName['FeedSubscription']>(
    'FeedSubscription',
    SCHEMAS.FeedSubscription,
  ),
});

/**
 * Run every model's index build, tolerating per-model rejections.
 *
 * Awaiting `m.init()` closes a startup race between
 * `insertManyIgnoringDuplicates` and the auto-built unique index.
 *
 * Treating an init failure as fatal would be strictly worse for the
 * operator: a single permission gap or one collection with pre-existing
 * duplicates would block ALL DB commands across EVERY guild. So we
 * `allSettled`: we still await the build (race window stays closed
 * when permissions/data are OK), but rejections drop a stderr line
 * and the connection stays serving. Each init runs in its own task so
 * the per-model `name` stays in scope on rejection. Stderr keeps this
 * layer free of cross-imports into core/logger.
 */
const initModelsBestEffort = async (models: Models, guildId: GuildId): Promise<void> => {
  await Promise.allSettled(
    Object.entries(models).map(async ([name, model]) => {
      try {
        await model.init();
      } catch (err: unknown) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        process.stderr.write(
          `[mongo] model.init() failed for ${name} on guild ${guildId}: ${reason}. ` +
            `Connection kept open; indexes may be missing.\n`,
        );
        throw err;
      }
    }),
  );
};

/**
 * Await `promises`, giving up after `timeoutMs`. Rejections are
 * expected here (a discarded open rejects by design), so they are
 * absorbed rather than propagated.
 */
const drainWithTimeout = async (
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> => {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled(promises).then(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Raised when an open finishes after a {@link ConnectionManager.closeAll}
 * that started while it was in flight.
 *
 * `closeAll` closes exactly the connections it can see; one still being
 * opened is invisible to it. Caching the late arrival would leave a
 * socket open that no later teardown knows about, so the open is
 * discarded instead (the caller's `catch` closes the raw connection).
 *
 * A dedicated class because this is a *shutdown race*, not a connection
 * failure: `retryOpen` rethrows it untouched, so the guild is not
 * marked disabled and no `[mongo] guild … disabled` line is written for
 * what is an ordinary Ctrl+C.
 */
class ShutdownRaceError extends Error {
  public constructor(guildId: GuildId) {
    super(
      `connection for guild ${guildId} was discarded: the manager was closed while it was opening`,
    );
    this.name = 'ShutdownRaceError';
  }
}

const assertSameGeneration = (opened: number, current: number, guildId: GuildId): void => {
  if (opened === current) return;
  throw new ShutdownRaceError(guildId);
};

/**
 * Shared transient-retry / persistent-disable loop for both
 * {@link ConnectionManager} implementations.
 *
 * Runs `open` up to `policy.maxAttempts` times. A failure is
 * classified via the `persistence/` error-translator: a *transient*
 * error with attempts remaining triggers a capped exponential-backoff
 * `sleep` and a retry; a *persistent* error — or an exhausted
 * transient one — is handed to `onDisable` (so the caller records the
 * guild as disabled) and then rethrown as a typed {@link DatabaseError}.
 *
 * Extracted as a free function so `MongoConnectionManager` and
 * `StaticConnectionManager` share one resilience implementation and
 * cannot drift; each manager keeps its own `onDisable` (the production
 * manager additionally writes an operator-facing stderr line).
 */
const retryOpen = async (params: {
  readonly guildId: GuildId;
  readonly operation: string;
  readonly policy: RetryPolicy;
  readonly sleep: SleepFn;
  readonly open: (guildId: GuildId) => Promise<GuildConnection>;
  readonly onDisable: (guildId: GuildId, error: DatabaseError) => void;
}): Promise<GuildConnection> => {
  const { guildId, operation, policy, sleep, open, onDisable } = params;
  const { maxAttempts, initialDelayMs, maxDelayMs } = policy;
  let lastError: DatabaseError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await open(guildId);
    } catch (raw: unknown) {
      // A teardown race is not a cluster failure: retrying or disabling
      // the guild would both be wrong, and the caller is already going
      // away.
      if (raw instanceof ShutdownRaceError) throw raw;
      const dbError =
        raw instanceof DatabaseError
          ? raw
          : databaseErrorFrom(raw, { operation, input: { guildId, attempt } });
      lastError = dbError;

      const retriable = isTransient(dbError) && attempt < maxAttempts;
      if (!retriable) break;

      // Exponential backoff, capped: 200ms, 400ms, 800ms, ... <= maxDelayMs.
      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  // Retries exhausted or a persistent failure: disable the guild so
  // subsequent calls short-circuit, and rethrow the typed error.
  const error =
    lastError ??
    databaseErrorFrom(new Error('connection open produced no error'), {
      operation,
      input: { guildId },
    });
  onDisable(guildId, error);
  throw error;
};

/**
 * Connection acquisition contract. Implementations:
 *   - {@link MongoConnectionManager}: production, talks to a real cluster.
 *   - {@link StaticConnectionManager}: wraps an externally-managed
 *     connection (mongodb-memory-server) for integration tests.
 */
export interface ConnectionManager {
  /**
   * Open (or return the cached) connection for `guildId`. The returned
   * `GuildConnection` carries the strongly-typed `Models` map.
   *
   * Throws a {@link DatabaseError} if the open fails. Transient
   * failures are retried internally before the throw; a guild that
   * fails persistently (or exhausts its retries) is marked disabled —
   * see {@link isDisabled}. Later calls retry transient failures after
   * the recovery cooldown; the disabled marker remains until success.
   */
  getConnection(guildId: GuildId): Promise<GuildConnection>;
  /**
   * Query the disabled state of a guild. Returns `undefined` when the
   * guild is healthy (or has never been opened), or a
   * {@link DisabledGuildState} carrying the `traceId` and the
   * classified failure when the guild has been disabled.
   */
  isDisabled(guildId: GuildId): DisabledGuildState | undefined;
  /**
   * Close every open guild connection. Safe to call multiple times, and
   * the manager is reusable afterwards — a `getConnection` issued once
   * `closeAll` has resolved opens a fresh connection. While it is
   * running, `getConnection` rejects.
   */
  closeAll(): Promise<void>;
  /** Close a single guild connection if open; no-op otherwise. */
  close(guildId: GuildId): Promise<void>;
}

/**
 * Default {@link ConnectionManager} backed by `mongoose.createConnection`.
 *
 * Connections are cached per guild id; concurrent `getConnection` calls
 * for the same guild dedupe via the in-flight promise so the cluster is
 * not hit twice during a startup race.
 */
export class MongoConnectionManager implements ConnectionManager {
  private readonly cache = new Map<GuildId, GuildConnection>();
  private readonly pending = new Map<GuildId, Promise<GuildConnection>>();
  private readonly disabled = new Map<GuildId, RecoveryState>();
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: SleepFn;
  /**
   * Bumped by every {@link closeAll}. An `open` that started before a
   * teardown and finishes after it belongs to a previous generation:
   * caching that connection would resurrect a socket the shutdown has
   * already accounted for, and nothing would ever close it.
   */
  private generation = 0;
  /**
   * True for the duration of {@link closeAll}. `closeAll` yields twice
   * (draining the in-flight opens, then closing the cached ones), and
   * the generation counter only protects opens that *started* before
   * it. Refusing new work for the window closes the "started during"
   * hole; the flag clears afterwards so the manager stays reusable.
   */
  private closing = false;

  /**
   * @param baseUri    Base MongoDB URI; the guild id + `authSource` are
   *                   appended per guild by {@link buildGuildMongoUri}.
   * @param retryPolicy Bounded-backoff policy for transient failures.
   *                   Defaults to {@link DEFAULT_RETRY_POLICY}.
   * @param sleep      Injectable delay primitive — tests pass a no-op
   *                   to keep backoff retries instantaneous.
   * @param recoveryIntervalMs Cooldown before retrying a transiently disabled guild.
   */
  constructor(
    private readonly baseUri: string,
    retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    sleep: SleepFn = realSleep,
    private readonly recoveryIntervalMs: number = DEFAULT_RECOVERY_INTERVAL_MS,
  ) {
    validateRecoveryInterval(recoveryIntervalMs);
    this.retryPolicy = retryPolicy;
    this.sleep = sleep;
  }

  public async getConnection(guildId: GuildId): Promise<GuildConnection> {
    if (this.closing) throw new ShutdownRaceError(guildId);

    const cached = this.cache.get(guildId);
    if (cached !== undefined) return cached;

    const disabledState = this.disabled.get(guildId);
    if (
      disabledState !== undefined &&
      (!isTransient(disabledState.error) || Date.now() < disabledState.retryAt)
    ) {
      throw disabledState.error;
    }

    const inFlight = this.pending.get(guildId);
    if (inFlight !== undefined) return inFlight;

    // Deleted by identity, not by key: `closeAll` clears the map while
    // this promise is still settling, and a key-based delete would
    // evict a *successor* entry installed in the meantime, letting a
    // third caller start a duplicate open for the same guild.
    const promise: Promise<GuildConnection> = this.openWithRetry(guildId).finally(() => {
      if (this.pending.get(guildId) === promise) this.pending.delete(guildId);
    });
    this.pending.set(guildId, promise);
    return promise;
  }

  public isDisabled(guildId: GuildId): DisabledGuildState | undefined {
    return this.disabled.get(guildId);
  }

  public async close(guildId: GuildId): Promise<void> {
    // Clearing the disabled marker on close lets the next boot retry a
    // guild whose database has since recovered.
    this.disabled.delete(guildId);
    const entry = this.cache.get(guildId);
    if (entry === undefined) return;
    this.cache.delete(guildId);
    await entry.connection.close();
  }

  public async closeAll(): Promise<void> {
    this.generation += 1;
    this.closing = true;
    try {
      // Drain in-flight opens first. Each one sees the bumped
      // generation, closes its own socket, and rejects, so the teardown
      // does not race a connection into the cache behind its back. The
      // drain is bounded: an open retrying against a dead cluster must
      // not consume the process-level shutdown budget.
      const inFlight = [...this.pending.values()];
      this.pending.clear();
      await drainWithTimeout(inFlight, CLOSE_DRAIN_TIMEOUT_MS);
      this.disabled.clear();
      const entries = [...this.cache.values()];
      this.cache.clear();
      await Promise.all(entries.map((e) => e.connection.close()));
    } finally {
      this.closing = false;
    }
  }

  /** Open with bounded-backoff retry for transient failures (see {@link retryOpen}). */
  private openWithRetry(guildId: GuildId): Promise<GuildConnection> {
    const generation = this.generation;
    return retryOpen({
      guildId,
      operation: 'MongoConnectionManager.open',
      policy: this.retryPolicy,
      sleep: this.sleep,
      open: async (id) => {
        assertSameGeneration(generation, this.generation, id);
        try {
          return await this.open(id);
        } catch (error: unknown) {
          assertSameGeneration(generation, this.generation, id);
          throw error;
        }
      },
      onDisable: (id, error) => this.markDisabled(id, error),
    }).then((entry) => {
      assertSameGeneration(generation, this.generation, guildId);
      this.disabled.delete(guildId);
      this.cache.set(guildId, entry);
      return entry;
    });
  }

  /**
   * Record a guild as disabled, generating the correlation `traceId`
   * and writing one operator-facing stderr line. Repeated failures keep
   * the trace id but refresh the error and cooldown for the next attempt.
   */
  private markDisabled(guildId: GuildId, error: DatabaseError): void {
    const previous = this.disabled.get(guildId);
    const traceId = previous?.traceId ?? generateTraceId();
    this.disabled.set(guildId, {
      traceId,
      error,
      retryAt: Date.now() + this.recoveryIntervalMs,
    });
    process.stderr.write(
      `[mongo] guild ${guildId} disabled after connection failure ` +
        `(code=${error.code}, traceId=${traceId}): ${error.message}\n`,
    );
  }

  private async open(guildId: GuildId): Promise<GuildConnection> {
    const generation = this.generation;
    const uri = buildGuildMongoUri(this.baseUri, guildId);
    const connection = await mongoose.createConnection(uri).asPromise();
    try {
      const models = buildModels(connection);
      // Best-effort index initialization — see initModelsBestEffort.
      // A rejected init does NOT fail the open; the connection stays
      // serving. The bot's structured logger separately reports
      // "MongoDB for guild ... connected".
      await initModelsBestEffort(models, guildId);
      assertSameGeneration(generation, this.generation, guildId);
      const entry: GuildConnection = { guildId, connection, models };
      this.cache.set(guildId, entry);
      return entry;
    } catch (err: unknown) {
      // Reached only when something OTHER than `m.init()` throws
      // (e.g. `buildModels` itself). The mongoose connection is open
      // at this point — close it so a failed cold-start does not leak
      // a TCP socket and the next `getConnection` retries cleanly.
      try {
        await connection.close();
      } catch {
        // Suppress: the original error is what callers need to see;
        // close failures during cleanup must not mask it.
      }
      throw err;
    }
  }
}

/**
 * Adapter that wraps an externally-managed `Connection` (typically the
 * mongodb-memory-server in integration tests). Lets tests reuse the same
 * `ConnectionManager` contract without spinning per-guild URIs.
 *
 * The `openOverride` constructor hook lets a test inject a failing
 * `open` so the transient-retry / persistent-disable behaviour of the
 * {@link ConnectionManager} contract can be exercised deterministically
 * without a real cluster.
 */
export class StaticConnectionManager implements ConnectionManager {
  private readonly cache = new Map<GuildId, GuildConnection>();
  private readonly pending = new Map<GuildId, Promise<GuildConnection>>();
  private readonly disabled = new Map<GuildId, RecoveryState>();
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: SleepFn;
  private readonly recoveryIntervalMs: number;
  private readonly openOverride?: (guildId: GuildId) => Promise<GuildConnection>;
  /** See {@link MongoConnectionManager}'s generation counter and closing flag. */
  private generation = 0;
  private closing = false;

  /**
   * @param underlying  Externally-managed mongoose connection.
   * @param options     Optional retry policy, sleep primitive, and an
   *                    `openOverride` failure-injection hook for tests.
   */
  constructor(
    private readonly underlying: Connection,
    options: {
      readonly retryPolicy?: RetryPolicy;
      readonly sleep?: SleepFn;
      readonly recoveryIntervalMs?: number;
      readonly openOverride?: (guildId: GuildId) => Promise<GuildConnection>;
    } = {},
  ) {
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    validateRecoveryInterval(this.recoveryIntervalMs);
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = options.sleep ?? realSleep;
    this.openOverride = options.openOverride;
  }

  public async getConnection(guildId: GuildId): Promise<GuildConnection> {
    if (this.closing) throw new ShutdownRaceError(guildId);

    const cached = this.cache.get(guildId);
    if (cached !== undefined) return cached;

    const disabledState = this.disabled.get(guildId);
    if (
      disabledState !== undefined &&
      (!isTransient(disabledState.error) || Date.now() < disabledState.retryAt)
    ) {
      throw disabledState.error;
    }

    const inFlight = this.pending.get(guildId);
    if (inFlight !== undefined) return inFlight;

    const promise: Promise<GuildConnection> = this.openWithRetry(guildId).finally(() => {
      if (this.pending.get(guildId) === promise) this.pending.delete(guildId);
    });
    this.pending.set(guildId, promise);
    return promise;
  }

  public isDisabled(guildId: GuildId): DisabledGuildState | undefined {
    return this.disabled.get(guildId);
  }

  public async close(guildId: GuildId): Promise<void> {
    this.disabled.delete(guildId);
    this.cache.delete(guildId);
  }

  public async closeAll(): Promise<void> {
    this.generation += 1;
    this.closing = true;
    try {
      const inFlight = [...this.pending.values()];
      this.pending.clear();
      await drainWithTimeout(inFlight, CLOSE_DRAIN_TIMEOUT_MS);
      this.disabled.clear();
      this.cache.clear();
    } finally {
      this.closing = false;
    }
  }

  /**
   * Open with bounded-backoff retry for transient failures, via the
   * shared {@link retryOpen} loop — so the static adapter and the
   * production manager behave identically against the
   * `ConnectionManager` contract.
   */
  private openWithRetry(guildId: GuildId): Promise<GuildConnection> {
    const generation = this.generation;
    return retryOpen({
      guildId,
      operation: 'StaticConnectionManager.open',
      policy: this.retryPolicy,
      sleep: this.sleep,
      open: async (id) => {
        assertSameGeneration(generation, this.generation, id);
        try {
          return await this.open(id);
        } catch (error: unknown) {
          assertSameGeneration(generation, this.generation, id);
          throw error;
        }
      },
      onDisable: (id, error) => this.markDisabled(id, error),
    }).then((entry) => {
      assertSameGeneration(generation, this.generation, guildId);
      this.disabled.delete(guildId);
      this.cache.set(guildId, entry);
      return entry;
    });
  }

  private markDisabled(guildId: GuildId, error: DatabaseError): void {
    const previous = this.disabled.get(guildId);
    const traceId = previous?.traceId ?? generateTraceId();
    this.disabled.set(guildId, {
      traceId,
      error,
      retryAt: Date.now() + this.recoveryIntervalMs,
    });
  }

  /**
   * Build the guild connection from the externally-managed connection,
   * or delegate to the injected `openOverride` failure hook.
   *
   * Blocks until every model's declared indexes are present (notably
   * the unique index on `Message.messageId` that
   * `insertManyIgnoringDuplicates` depends on). Without this, the first
   * insert of a suite races the auto-index build and unique constraints
   * silently do not enforce.
   */
  private async open(guildId: GuildId): Promise<GuildConnection> {
    const generation = this.generation;
    if (this.openOverride !== undefined) {
      const overridden = await this.openOverride(guildId);
      assertSameGeneration(generation, this.generation, guildId);
      return overridden;
    }
    const models = buildModels(this.underlying);
    await Promise.all(Object.values(models).map((m) => m.init()));
    assertSameGeneration(generation, this.generation, guildId);
    const entry: GuildConnection = {
      guildId,
      connection: this.underlying,
      models,
    };
    this.cache.set(guildId, entry);
    return entry;
  }
}
