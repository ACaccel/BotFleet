/**
 * `FetchRepo` — per-channel backup-progress markers used by the
 * msg-archive bot. One document per channel records the most recent
 * Discord message id consumed; the next backup pass starts after it.
 *
 * Error boundary: every method returns `Result<T, DatabaseError>`. A
 * mongoose failure is translated by the shared `databaseErrorFrom`
 * translator and returned as `err`; a missing lookup is a success
 * (`ok(undefined)`).
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../../infra/mongo/connection-manager';
import { databaseErrorFrom } from '../error-translator';
import type { FetchDoc } from '../schemas/fetch.schema';

export type FetchReader = Pick<FetchRepo, 'listChannelIds' | 'findByChannelId'>;

interface FetchRepo {
  /** All progress markers in this guild, projected to `channelID`. */
  listChannelIds(): Promise<Result<readonly string[], DatabaseError>>;
  /** Look up a marker by channel id. `ok(undefined)` when absent. */
  findByChannelId(channelID: string): Promise<Result<FetchDoc | undefined, DatabaseError>>;
  /**
   * Insert a new progress marker. Caller is responsible for ensuring
   * uniqueness — schema-level `index: true` on `channelID` is not a
   * `unique` constraint.
   */
  create(
    channel: string,
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<FetchDoc, DatabaseError>>;
  /** Move the cursor forward; `ok(true)` when a document was matched. */
  setLastMessageID(
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<boolean, DatabaseError>>;
  /** Delete a marker; `ok(true)` when a document was removed. */
  deleteByChannelId(channelID: string): Promise<Result<boolean, DatabaseError>>;
  /**
   * Idempotent equivalent of `create + setLastMessageID`. The
   * msg-archive `backupChannel` loop uses this at the tail of every
   * batch: the marker may or may not exist depending on whether this
   * is a fresh channel or an incremental resume.
   */
  upsertLastMessageID(
    channel: string,
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<void, DatabaseError>>;
}

export class MongoFetchRepo implements FetchRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listChannelIds(): Promise<Result<readonly string[], DatabaseError>> {
    try {
      const docs = await this.conn.models.Fetch.find({}, { channelID: 1 })
        .lean<Array<Pick<FetchDoc, 'channelID'>>>()
        .exec();
      return ok(docs.map((d) => d.channelID));
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoFetchRepo.listChannelIds' }));
    }
  }

  public async findByChannelId(
    channelID: string,
  ): Promise<Result<FetchDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Fetch.findOne({ channelID }).lean<FetchDoc>().exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFetchRepo.findByChannelId',
          input: { channelID },
        }),
      );
    }
  }

  public async create(
    channel: string,
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<FetchDoc, DatabaseError>> {
    if (this.conn.archiveOwner !== 'msg-archive')
      throw new Error('Archive checkpoints require msg-archive ownership');
    try {
      const created = await this.conn.models.Fetch.create({ channel, channelID, lastMessageID });
      return ok(created.toObject<FetchDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFetchRepo.create',
          input: { channelID },
        }),
      );
    }
  }

  public async setLastMessageID(
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<boolean, DatabaseError>> {
    if (this.conn.archiveOwner !== 'msg-archive')
      throw new Error('Archive checkpoints require msg-archive ownership');
    try {
      // updateOne avoids the doc-fetch round-trip that findOneAndUpdate
      // pays for; we only care whether a doc was matched. Mirrors
      // MongoActivityRepo.setParticipants for consistency.
      const res = await this.conn.models.Fetch.updateOne(
        { channelID },
        { $set: { lastMessageID } },
      ).exec();
      return ok(res.matchedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFetchRepo.setLastMessageID',
          input: { channelID },
        }),
      );
    }
  }

  public async deleteByChannelId(channelID: string): Promise<Result<boolean, DatabaseError>> {
    if (this.conn.archiveOwner !== 'msg-archive')
      throw new Error('Archive checkpoints require msg-archive ownership');
    try {
      const res = await this.conn.models.Fetch.deleteOne({ channelID }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFetchRepo.deleteByChannelId',
          input: { channelID },
        }),
      );
    }
  }

  public async upsertLastMessageID(
    channel: string,
    channelID: string,
    lastMessageID: string,
  ): Promise<Result<void, DatabaseError>> {
    if (this.conn.archiveOwner !== 'msg-archive')
      throw new Error('Archive checkpoints require msg-archive ownership');
    try {
      await this.conn.models.Fetch.updateOne(
        { channelID },
        { $set: { channel, lastMessageID } },
        { upsert: true },
      ).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoFetchRepo.upsertLastMessageID',
          input: { channelID },
        }),
      );
    }
  }
}
