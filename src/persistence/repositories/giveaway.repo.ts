/**
 * `GiveawayRepo` — persistent state for the giveaway feature.
 *
 * Documents are keyed by the announcement Discord `message_id`. The
 * scheduler reads pending giveaways on boot, the announcement creates
 * one, and the schedule callback (or a manual cancel) deletes it.
 *
 * **Error boundary**: every method returns
 * `Result<T, DatabaseError>`. A mongoose failure is translated by the
 * shared `databaseErrorFrom` translator and returned as `err`; a
 * missing lookup is a success (`ok(undefined)`).
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { GiveawayDoc } from '../schemas/giveaway.schema';

/** Insertion shape — the schema fields without the Mongoose `_id`. */
export interface GiveawayInput {
  readonly winner_num: number;
  readonly prize: string;
  readonly end_time: number;
  readonly channel_id: string;
  readonly prize_owner_id: string;
  readonly participants: readonly string[];
  readonly message_id: string;
}

export interface GiveawayRepo {
  /** Every giveaway in this guild, used for boot-time job rebuild. */
  listAll(): Promise<Result<readonly GiveawayDoc[], DatabaseError>>;
  /** Look up by announcement message id; `ok(undefined)` when absent. */
  findByMessageId(message_id: string): Promise<Result<GiveawayDoc | undefined, DatabaseError>>;
  /** Persist a new giveaway and return the stored doc. */
  create(input: GiveawayInput): Promise<Result<GiveawayDoc, DatabaseError>>;
  /** Delete by announcement message id; `ok(true)` when a doc was removed. */
  deleteByMessageId(message_id: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoGiveawayRepo implements GiveawayRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listAll(): Promise<Result<readonly GiveawayDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Giveaway.find({}).lean<GiveawayDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoGiveawayRepo.listAll' }));
    }
  }

  public async findByMessageId(
    message_id: string,
  ): Promise<Result<GiveawayDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Giveaway.findOne({ message_id })
        .lean<GiveawayDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoGiveawayRepo.findByMessageId',
          input: { message_id },
        }),
      );
    }
  }

  public async create(input: GiveawayInput): Promise<Result<GiveawayDoc, DatabaseError>> {
    try {
      const created = await this.conn.models.Giveaway.create({ ...input });
      return ok(created.toObject<GiveawayDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoGiveawayRepo.create',
          input: { message_id: input.message_id },
        }),
      );
    }
  }

  public async deleteByMessageId(message_id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Giveaway.deleteOne({ message_id }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoGiveawayRepo.deleteByMessageId',
          input: { message_id },
        }),
      );
    }
  }
}
