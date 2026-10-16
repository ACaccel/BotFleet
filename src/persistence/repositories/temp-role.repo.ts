/**
 * `TempRoleRepo` — persistent state for the temporary notification-role
 * feature.
 *
 * Documents are keyed by the Discord `role_id`. The scheduler reads
 * pending temp roles on boot (`listAll`), `/role temp create`
 * creates one, and the expiry job (or a reboot sweep that finds an
 * already-expired row) deletes it.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 * A mongoose failure is translated by the shared `databaseErrorFrom`
 * translator and returned as `err`; a missing lookup is a success
 * (`ok(undefined)`).
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { TempRoleDoc } from '../schemas/temp-role.schema';

/** Insertion shape — the schema fields without the Mongoose `_id`. */
export interface TempRoleInput {
  readonly role_id: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly creator_id: string;
  readonly role_name: string;
  readonly expires_at: number;
}

export interface TempRoleRepo {
  /** Every temp role in this guild, used for boot-time job rebuild. */
  listAll(): Promise<Result<readonly TempRoleDoc[], DatabaseError>>;
  /** Look up by Discord role id; `ok(undefined)` when absent. */
  findByRoleId(role_id: string): Promise<Result<TempRoleDoc | undefined, DatabaseError>>;
  /** Persist a new temp role and return the stored doc. */
  create(input: TempRoleInput): Promise<Result<TempRoleDoc, DatabaseError>>;
  /** Delete by Discord role id; `ok(true)` when a doc was removed. */
  deleteByRoleId(role_id: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoTempRoleRepo implements TempRoleRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async listAll(): Promise<Result<readonly TempRoleDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.TempRole.find({}).lean<TempRoleDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoTempRoleRepo.listAll' }));
    }
  }

  public async findByRoleId(
    role_id: string,
  ): Promise<Result<TempRoleDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.TempRole.findOne({ role_id }).lean<TempRoleDoc>().exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoTempRoleRepo.findByRoleId',
          input: { role_id },
        }),
      );
    }
  }

  public async create(input: TempRoleInput): Promise<Result<TempRoleDoc, DatabaseError>> {
    try {
      const created = await this.conn.models.TempRole.create({ ...input });
      return ok(created.toObject<TempRoleDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoTempRoleRepo.create',
          input: { role_id: input.role_id },
        }),
      );
    }
  }

  public async deleteByRoleId(role_id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.TempRole.deleteOne({ role_id }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoTempRoleRepo.deleteByRoleId',
          input: { role_id },
        }),
      );
    }
  }
}
