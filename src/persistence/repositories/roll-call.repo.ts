/**
 * `RollCallRepo` — roll-call state, one collection per guild.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 * Check-in and close are conditional updates, so a late click or a
 * double close changes nothing.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { RollCallDoc } from '../schemas/roll-call.schema';

export interface RollCallInput {
  readonly message_id: string;
  readonly channel_id: string;
  readonly creator_id: string;
  readonly persona: string;
  readonly targets: readonly string[];
  readonly activity_id?: string;
  readonly deadline?: number;
}

export interface RollCallRepo {
  create(input: RollCallInput): Promise<Result<RollCallDoc, DatabaseError>>;
  findByMessageId(message_id: string): Promise<Result<RollCallDoc | undefined, DatabaseError>>;
  listOpen(): Promise<Result<readonly RollCallDoc[], DatabaseError>>;
  /** Mark `userId` present while open and called; `ok(false)` when nothing changed. */
  checkIn(message_id: string, userId: string): Promise<Result<boolean, DatabaseError>>;
  /** Close an open roll call; `ok(false)` when it was already closed or absent. */
  close(message_id: string, purgeAt: Date): Promise<Result<boolean, DatabaseError>>;
}

export class MongoRollCallRepo implements RollCallRepo {
  constructor(private readonly conn: GuildConnection) {}

  private fail(operation: string, rawErr: unknown): DatabaseError {
    return databaseErrorFrom(rawErr, { operation: `MongoRollCallRepo.${operation}` });
  }

  public async create(input: RollCallInput): Promise<Result<RollCallDoc, DatabaseError>> {
    try {
      const doc = await this.conn.models.RollCall.create({
        ...input,
        targets: [...input.targets],
        present: [],
        closed: false,
      });
      return ok(doc.toObject<RollCallDoc>());
    } catch (rawErr: unknown) {
      return err(this.fail('create', rawErr));
    }
  }

  public async findByMessageId(
    message_id: string,
  ): Promise<Result<RollCallDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.RollCall.findOne({ message_id })
        .lean<RollCallDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('findByMessageId', rawErr));
    }
  }

  public async listOpen(): Promise<Result<readonly RollCallDoc[], DatabaseError>> {
    try {
      return ok(
        await this.conn.models.RollCall.find({ closed: false }).lean<RollCallDoc[]>().exec(),
      );
    } catch (rawErr: unknown) {
      return err(this.fail('listOpen', rawErr));
    }
  }

  public async checkIn(
    message_id: string,
    userId: string,
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.RollCall.updateOne(
        { message_id, closed: false, targets: userId, present: { $ne: userId } },
        { $addToSet: { present: userId } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('checkIn', rawErr));
    }
  }

  public async close(message_id: string, purgeAt: Date): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.RollCall.updateOne(
        { message_id, closed: false },
        { $set: { closed: true, purge_at: purgeAt } },
      ).exec();
      return ok(res.modifiedCount > 0);
    } catch (rawErr: unknown) {
      return err(this.fail('close', rawErr));
    }
  }
}
