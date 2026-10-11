/**
 * `ActivityRepo` — persistent state for the activity feature.
 *
 * Documents are keyed by `activity_id` (a timestamp string in current
 * usage). On schedule completion the participants list is updated and
 * the entry persists; explicit deletion comes from `deleteActivity`.
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
import type { ActivityDoc } from '../schemas/activity.schema';

export interface ActivityInput {
  readonly activity_id: string;
  readonly message_id: string;
  readonly title: string;
  readonly description: string;
  readonly expired_at: number;
  readonly channel_id: string;
  readonly participants: readonly string[];
}

export interface ActivityRepo {
  /** Every activity in this guild, used for boot-time job rebuild. */
  listAll(): Promise<Result<readonly ActivityDoc[], DatabaseError>>;
  /** Look up by activity id; resolves to `ok(undefined)` when absent. */
  findByActivityId(activity_id: string): Promise<Result<ActivityDoc | undefined, DatabaseError>>;
  /** Persist a new activity and return the stored doc. */
  create(input: ActivityInput): Promise<Result<ActivityDoc, DatabaseError>>;
  /** Replace the participants list for a given activity. `ok(true)` on match. */
  setParticipants(
    activity_id: string,
    participants: readonly string[],
  ): Promise<Result<boolean, DatabaseError>>;
  /** Delete by activity id; `ok(true)` when a doc was removed. */
  deleteByActivityId(activity_id: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoActivityRepo implements ActivityRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listAll(): Promise<Result<readonly ActivityDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Activity.find({}).lean<ActivityDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoActivityRepo.listAll' }));
    }
  }

  public async findByActivityId(
    activity_id: string,
  ): Promise<Result<ActivityDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Activity.findOne({ activity_id })
        .lean<ActivityDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoActivityRepo.findByActivityId',
          input: { activity_id },
        }),
      );
    }
  }

  public async create(input: ActivityInput): Promise<Result<ActivityDoc, DatabaseError>> {
    try {
      const created = await this.conn.models.Activity.create({ ...input });
      return ok(created.toObject<ActivityDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoActivityRepo.create',
          input: { activity_id: input.activity_id },
        }),
      );
    }
  }

  public async setParticipants(
    activity_id: string,
    participants: readonly string[],
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.updateOne(
        { activity_id },
        { $set: { participants: [...participants] } },
      ).exec();
      return ok(res.matchedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoActivityRepo.setParticipants',
          input: { activity_id },
        }),
      );
    }
  }

  public async deleteByActivityId(activity_id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.deleteOne({ activity_id }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoActivityRepo.deleteByActivityId',
          input: { activity_id },
        }),
      );
    }
  }
}
