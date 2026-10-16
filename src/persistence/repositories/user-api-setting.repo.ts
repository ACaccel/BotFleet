/**
 * `UserApiSettingRepo` — per-user AI provider configuration. Document
 * existence doubles as whitelist membership; the LLM-chat handler
 * checks `findByUserId` before any external API call.
 *
 * Update semantics are a partial `updateOne($set: patch)` — provider,
 * model, temperature, system_prompt, and web_search may each be
 * updated independently.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { UserApiSettingDoc } from '../schemas/user-api-setting.schema';

/** Defaults applied when adding a new whitelist entry. */
export interface UserApiSettingDefaults {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly system_prompt: string;
  readonly web_search: boolean;
}

/** Subset of fields permitted by the settings modal. */
export interface UserApiSettingPatch {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly system_prompt?: string;
  readonly web_search?: boolean;
}

export interface UserApiSettingRepo {
  /** Look up a user's settings; `ok(undefined)` when not whitelisted. */
  findByUserId(userId: string): Promise<Result<UserApiSettingDoc | undefined, DatabaseError>>;
  /** Every whitelist entry — used by ai_whitelist_list. */
  listAll(): Promise<Result<readonly UserApiSettingDoc[], DatabaseError>>;
  /** Create a whitelist entry with defaults. Caller must dedupe via findByUserId. */
  create(
    userId: string,
    defaults: UserApiSettingDefaults,
  ): Promise<Result<UserApiSettingDoc, DatabaseError>>;
  /** Apply a partial update; `ok(true)` when a document was matched. */
  update(userId: string, patch: UserApiSettingPatch): Promise<Result<boolean, DatabaseError>>;
  /** Remove a whitelist entry; `ok(true)` when a document was removed. */
  deleteByUserId(userId: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoUserApiSettingRepo implements UserApiSettingRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async findByUserId(
    userId: string,
  ): Promise<Result<UserApiSettingDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.UserApiSetting.findOne({ userId })
        .lean<UserApiSettingDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoUserApiSettingRepo.findByUserId',
          input: { userId },
        }),
      );
    }
  }

  public async listAll(): Promise<Result<readonly UserApiSettingDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.UserApiSetting.find({}).lean<UserApiSettingDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoUserApiSettingRepo.listAll' }));
    }
  }

  public async create(
    userId: string,
    defaults: UserApiSettingDefaults,
  ): Promise<Result<UserApiSettingDoc, DatabaseError>> {
    try {
      const created = await this.conn.models.UserApiSetting.create({ userId, ...defaults });
      return ok(created.toObject<UserApiSettingDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoUserApiSettingRepo.create',
          input: { userId },
        }),
      );
    }
  }

  public async update(
    userId: string,
    patch: UserApiSettingPatch,
  ): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.UserApiSetting.updateOne(
        { userId },
        { $set: patch },
      ).exec();
      return ok(res.matchedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoUserApiSettingRepo.update',
          input: { userId },
        }),
      );
    }
  }

  public async deleteByUserId(userId: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.UserApiSetting.deleteOne({ userId }).exec();
      return ok(res.deletedCount > 0);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, {
          operation: 'MongoUserApiSettingRepo.deleteByUserId',
          input: { userId },
        }),
      );
    }
  }
}
