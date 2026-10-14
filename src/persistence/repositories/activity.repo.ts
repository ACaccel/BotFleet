/**
 * `ActivityRepo` — sign-up activity state, one collection per guild.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 * Joining is a single conditional update so concurrent clicks cannot
 * exceed the capacity or add a member twice.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { ActivityDoc } from '../schemas/activity.schema';

export interface ActivityInput {
  readonly activity_id: string;
  readonly message_id: string;
  readonly channel_id: string;
  readonly title: string;
  readonly description: string;
  readonly creator_id: string;
  readonly role_id?: string;
  readonly capacity?: number;
  readonly starts_at?: number;
  readonly expired_at: number;
}

export interface AttendanceRecord {
  readonly at: number;
  readonly present: readonly string[];
  readonly total: number;
}

export interface ActivityRepo {
  listAll(): Promise<Result<readonly ActivityDoc[], DatabaseError>>;
  findByActivityId(activity_id: string): Promise<Result<ActivityDoc | undefined, DatabaseError>>;
  create(input: ActivityInput): Promise<Result<ActivityDoc, DatabaseError>>;
  /** Add `userId` while the activity is open and has room; `ok(false)` when not added. */
  join(activity_id: string, userId: string): Promise<Result<boolean, DatabaseError>>;
  /** Remove `userId` while the activity is open; `ok(false)` when not removed. */
  leave(activity_id: string, userId: string): Promise<Result<boolean, DatabaseError>>;
  /**
   * Move an activity from one of `from` to `status`, scheduling its purge.
   * `ok(false)` when it was not in one of those states.
   */
  finish(
    activity_id: string,
    from: readonly ('open' | 'closed')[],
    status: 'closed' | 'cancelled',
    purgeAt: Date,
  ): Promise<Result<boolean, DatabaseError>>;
  markStartNotified(activity_id: string): Promise<Result<boolean, DatabaseError>>;
  addAttendance(
    activity_id: string,
    record: AttendanceRecord,
  ): Promise<Result<boolean, DatabaseError>>;
}

export class MongoActivityRepo implements ActivityRepo {
  constructor(private readonly conn: GuildConnection) {}

  private fail(operation: string, rawErr: unknown, activity_id?: string): DatabaseError {
    return databaseErrorFrom(rawErr, {
      operation: `MongoActivityRepo.${operation}`,
      ...(activity_id === undefined ? {} : { input: { activity_id } }),
    });
  }

  public async listAll(): Promise<Result<readonly ActivityDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Activity.find({}).lean<ActivityDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(this.fail('listAll', rawErr));
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
      return err(this.fail('findByActivityId', rawErr, activity_id));
    }
  }

  public async create(input: ActivityInput): Promise<Result<ActivityDoc, DatabaseError>> {
    try {
      const doc = await this.conn.models.Activity.create({ ...input, participants: [] });
      return ok(doc.toObject<ActivityDoc>());
    } catch (rawErr: unknown) {
      return err(this.fail('create', rawErr, input.activity_id));
    }
  }

  public async join(activity_id: string, userId: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.updateOne(
        {
          activity_id,
          status: 'open',
          participants: { $ne: userId },
          $or: [
            { capacity: { $exists: false } },
            { capacity: null },
            { $expr: { $lt: [{ $size: '$participants' }, '$capacity'] } },
          ],
        },
        { $addToSet: { participants: userId } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('join', rawErr, activity_id));
    }
  }

  public async leave(activity_id: string, userId: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.updateOne(
        { activity_id, status: 'open', participants: userId },
        { $pull: { participants: userId } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('leave', rawErr, activity_id));
    }
  }

  public async finish(
    activity_id: string,
    from: readonly ('open' | 'closed')[],
    status: 'closed' | 'cancelled',
    purgeAt: Date,
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      // Legacy rows have no `status`; they count as open.
      const states = from.includes('open') ? [...from, null] : [...from];
      const res = await this.conn.models.Activity.updateOne(
        { activity_id, status: { $in: states } },
        { $set: { status, purge_at: purgeAt } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('finish', rawErr, activity_id));
    }
  }

  public async markStartNotified(activity_id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.updateOne(
        { activity_id, start_notified: { $ne: true } },
        { $set: { start_notified: true } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('markStartNotified', rawErr, activity_id));
    }
  }

  public async addAttendance(
    activity_id: string,
    record: AttendanceRecord,
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Activity.updateOne(
        { activity_id },
        { $push: { attendance: { ...record, present: [...record.present] } } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('addAttendance', rawErr, activity_id));
    }
  }
}
