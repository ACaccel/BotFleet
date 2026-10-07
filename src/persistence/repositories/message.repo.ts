/**
 * `MessageRepo` — persistence boundary for archived Discord messages.
 *
 * Methods are intent-named (`findRecentByChannel`, `countAll`,
 * `insertManyIgnoringDuplicates`) rather than generic CRUD so the repo
 * stays domain-shaped: a future swap to a different storage layer would
 * not change call sites.
 *
 * Inputs use branded ID types from `@core/ids` so a `GuildId` cannot be
 * passed where a `ChannelId` is expected. Returned `MessageDoc` carries
 * the raw stored shape; the embedded id fields are not rebranded.
 *
 * Error boundary: every method returns
 * `Result<T, DatabaseError>`. A mongoose failure is translated by the
 * shared `databaseErrorFrom` translator (`persistence/error-translator`)
 * and returned as `err(DatabaseError)` — the typed error carries a
 * stable sub-code (`DATABASE_DUPLICATE_KEY`, `DATABASE_TIMEOUT`, ...),
 * the original mongoose error on `cause`, and a `context.operation`
 * naming the failing repo method. Two distinct exits coexist:
 *   - `err(DatabaseError)` — a domain failure (the DB query failed).
 *   - a thrown `TypeError` — a programmer error (contract violation
 *     such as a non-positive `limit`). Contract violations are not a
 *     domain failure mode, so they bubble unwrapped and never enter a
 *     `Result`.
 * A "not found" lookup is a success: `ok(undefined)`, not `err`.
 */
import type { ChannelId } from '../../core/ids';
import { err, ok, type Result } from '../../core/result';
import type { DatabaseError } from '../../core/errors/external-service-error';
import type { GuildConnection } from '../../infra/mongo/connection-manager';
import { databaseErrorFrom } from '../error-translator';
import type { MessageDoc, NewMessageDoc } from '../schemas/message.schema';

interface InsertResult {
  /** How many of the requested docs were actually written. */
  readonly inserted: number;
  /** How many were skipped due to a duplicate `messageId`. */
  readonly duplicates: number;
}

export type MessageReader = Omit<MessageRepo, 'insertManyIgnoringDuplicates'>;

interface MessageRepo {
  /** Total document count for this guild. Used by msg-archive metrics. */
  countAll(): Promise<Result<number, DatabaseError>>;

  /**
   * Recent messages from a single channel, newest first. `limit` clamps
   * the result; pass a positive integer (a non-positive or non-integer
   * `limit` is a programmer error and throws `TypeError`).
   */
  findRecentByChannel(
    channelId: ChannelId,
    limit: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>>;

  /**
   * Look up a single message by its Discord id. A missing message is a
   * success — `ok(undefined)`, with `undefined` the project-wide
   * "absent" shape under `noUncheckedIndexedAccess`.
   */
  findByMessageId(messageId: string): Promise<Result<MessageDoc | undefined, DatabaseError>>;

  /**
   * Bulk insert with duplicate-key tolerance — the underlying call is
   * `insertMany(docs, { ordered: false })` so a duplicate `messageId`
   * does not abort the batch. A `BulkWriteError` carrying `insertedDocs`
   * is the expected partial-success path and resolves to `ok`; any
   * other Mongo error resolves to `err`.
   */
  insertManyIgnoringDuplicates(
    docs: readonly NewMessageDoc[],
  ): Promise<Result<InsertResult, DatabaseError>>;

  /**
   * Messages whose `timestamp` falls within `[startMs, endMs)`, across
   * every channel in this guild. Used by the sticker/emoji-frequency
   * metrics commands that walk a month at a time. `startMs` / `endMs`
   * are millisecond epochs; an invalid window throws `TypeError`.
   */
  findByTimestampRange(
    startMs: number,
    endMs: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>>;

  /**
   * Messages from a single channel whose `timestamp` falls within
   * `[startMs, endMs)`, sorted oldest-first. Used by `db_list_message`
   * to render a chronological transcript of one channel/day.
   */
  findByChannelAndTimestampRange(
    channelId: ChannelId,
    startMs: number,
    endMs: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>>;

  /**
   * Subset of `messageIds` that are already stored in this guild's
   * collection. The msg-archive batch path uses this to filter
   * already-seen messages before calling `insertManyIgnoringDuplicates`
   * — Mongo's duplicate-key fallback is correct but expensive, the
   * pre-filter avoids the round-trip when most messages are already
   * known (the steady-state condition for an incremental backup).
   * Returns a Set so callers can do `O(1)` membership checks.
   */
  findExistingMessageIds(
    messageIds: readonly string[],
  ): Promise<Result<ReadonlySet<string>, DatabaseError>>;
}

/** Mongoose-backed implementation. */
export class MongoMessageRepo implements MessageRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async countAll(): Promise<Result<number, DatabaseError>> {
    try {
      return ok(await this.conn.models.Message.countDocuments({}).exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoMessageRepo.countAll' }));
    }
  }

  public async findRecentByChannel(
    channelId: ChannelId,
    limit: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>> {
    if (!Number.isInteger(limit) || limit <= 0) {
      // Programmer error — not a domain failure mode. Bubble unwrapped,
      // never wrap into a Result.
      throw new TypeError(
        `MongoMessageRepo.findRecentByChannel: limit must be a positive integer, got ${limit}`,
      );
    }
    try {
      // Branded `ChannelId` is structurally a `string` at runtime — no
      // explicit unbrand needed at the mongoose call site.
      const docs = await this.conn.models.Message.find({ channelId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean<MessageDoc[]>()
        .exec();
      return ok(docs);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.findRecentByChannel',
          input: { channelId: String(channelId), limit },
        }),
      );
    }
  }

  public async findByMessageId(
    messageId: string,
  ): Promise<Result<MessageDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Message.findOne({ messageId }).lean<MessageDoc>().exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.findByMessageId',
          input: { messageId },
        }),
      );
    }
  }

  public async insertManyIgnoringDuplicates(
    docs: readonly NewMessageDoc[],
  ): Promise<Result<InsertResult, DatabaseError>> {
    if (this.conn.archiveOwner !== 'msg-archive')
      throw new Error('Message writes require msg-archive ownership');
    if (docs.length === 0) {
      return ok({ inserted: 0, duplicates: 0 });
    }
    try {
      const inserted = await this.conn.models.Message.insertMany([...docs], {
        ordered: false,
      });
      return ok({ inserted: inserted.length, duplicates: docs.length - inserted.length });
    } catch (rawErr: unknown) {
      // Mongoose throws BulkWriteError on duplicate-key conflicts; the
      // partial-success count is on `err.insertedDocs`. That is the
      // *expected* path for this method's contract — resolve to `ok`
      // with the partial count rather than translating to DatabaseError.
      // Any other error shape is genuinely abnormal and resolves to `err`.
      if (
        typeof rawErr === 'object' &&
        rawErr !== null &&
        'insertedDocs' in rawErr &&
        Array.isArray((rawErr as { insertedDocs: unknown }).insertedDocs) &&
        'code' in rawErr &&
        rawErr.code === 11000 &&
        (!('writeErrors' in rawErr) ||
          (Array.isArray(rawErr.writeErrors) &&
            rawErr.writeErrors.every((entry: unknown) => {
              if (typeof entry !== 'object' || entry === null) return false;
              if ('code' in entry) return entry.code === 11000;
              return (
                'err' in entry &&
                typeof entry.err === 'object' &&
                entry.err !== null &&
                'code' in entry.err &&
                entry.err.code === 11000
              );
            }))) &&
        (!('writeConcernErrors' in rawErr) ||
          (Array.isArray(rawErr.writeConcernErrors) && rawErr.writeConcernErrors.length === 0))
      ) {
        const insertedDocs = (rawErr as { insertedDocs: readonly unknown[] }).insertedDocs;
        return ok({
          inserted: insertedDocs.length,
          duplicates: docs.length - insertedDocs.length,
        });
      }
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.insertManyIgnoringDuplicates',
          input: { batchSize: docs.length },
        }),
      );
    }
  }

  public async findByTimestampRange(
    startMs: number,
    endMs: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>> {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new TypeError(
        `MongoMessageRepo.findByTimestampRange: invalid window [${startMs}, ${endMs})`,
      );
    }
    try {
      // `timestamp` is a numeric epoch (the one-time msg-archive timestamp repair
      // backfill removed the legacy String rows that once required a
      // `$toLong` projection), so this plain half-open range is sargable
      // and served by the `{ timestamp: 1 }` index instead of a collection scan.
      const docs = await this.conn.models.Message.find({
        timestamp: { $gte: startMs, $lt: endMs },
      })
        .lean<MessageDoc[]>()
        .exec();
      return ok(docs);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.findByTimestampRange',
          input: { startMs, endMs },
        }),
      );
    }
  }

  public async findExistingMessageIds(
    messageIds: readonly string[],
  ): Promise<Result<ReadonlySet<string>, DatabaseError>> {
    if (messageIds.length === 0) return ok(new Set<string>());
    try {
      const docs = await this.conn.models.Message.find(
        { messageId: { $in: [...messageIds] } },
        { messageId: 1 },
      )
        .lean<Array<{ messageId: string }>>()
        .exec();
      return ok(new Set(docs.map((d) => d.messageId)));
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.findExistingMessageIds',
          input: { count: messageIds.length },
        }),
      );
    }
  }

  public async findByChannelAndTimestampRange(
    channelId: ChannelId,
    startMs: number,
    endMs: number,
  ): Promise<Result<readonly MessageDoc[], DatabaseError>> {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new TypeError(
        `MongoMessageRepo.findByChannelAndTimestampRange: invalid window [${startMs}, ${endMs})`,
      );
    }
    try {
      // Numeric `timestamp` (see findByTimestampRange) makes this a plain
      // half-open range; the compound `{ channelId: 1, timestamp: 1 }` index
      // serves both the equality + range and the sort with no blocking SORT.
      const docs = await this.conn.models.Message.find({
        channelId,
        timestamp: { $gte: startMs, $lt: endMs },
      })
        .sort({ timestamp: 1 })
        .lean<MessageDoc[]>()
        .exec();
      return ok(docs);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoMessageRepo.findByChannelAndTimestampRange',
          input: { channelId: String(channelId), startMs, endMs },
        }),
      );
    }
  }
}
