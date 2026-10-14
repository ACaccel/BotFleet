/**
 * `ReplyRepo` — auto-reply pair storage. One per guild; pairs are
 * keyed by an exact-match `input` and produce a `reply` string.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { ReplyDoc } from '../schemas/reply.schema';

export interface ReplyRepo {
  /** Exact-pair existence check (used by add_reply to dedupe). */
  findExactPair(input: string, reply: string): Promise<Result<readonly ReplyDoc[], DatabaseError>>;

  findByInput(input: string): Promise<Result<readonly ReplyDoc[], DatabaseError>>;

  /** Every pair in the guild, for the keyword overview. */
  listAll(): Promise<Result<readonly ReplyDoc[], DatabaseError>>;

  /** Find by Mongoose `_id` rendered as a string (delete_reply SSM). */
  findById(id: string): Promise<Result<ReplyDoc | undefined, DatabaseError>>;

  create(input: string, reply: string, createdBy: string): Promise<Result<ReplyDoc, DatabaseError>>;

  /** Delete by `_id`; `ok(true)` when a document was removed. */
  deleteById(id: string): Promise<Result<boolean, DatabaseError>>;
}

export class MongoReplyRepo implements ReplyRepo {
  constructor(private readonly conn: GuildConnection) {}

  public async findExactPair(
    input: string,
    reply: string,
  ): Promise<Result<readonly ReplyDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Reply.find({ input, reply }).lean<ReplyDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.findExactPair', input: { input } }),
      );
    }
  }

  public async findByInput(input: string): Promise<Result<readonly ReplyDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Reply.find({ input }).lean<ReplyDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.findByInput', input: { input } }),
      );
    }
  }

  public async listAll(): Promise<Result<readonly ReplyDoc[], DatabaseError>> {
    try {
      return ok(await this.conn.models.Reply.find({}).lean<ReplyDoc[]>().exec());
    } catch (rawErr: unknown) {
      return err(databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.listAll' }));
    }
  }

  public async findById(id: string): Promise<Result<ReplyDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.Reply.findById(id).lean<ReplyDoc>().exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.findById', input: { id } }),
      );
    }
  }

  public async create(
    input: string,
    reply: string,
    createdBy: string,
  ): Promise<Result<ReplyDoc, DatabaseError>> {
    try {
      const doc = await this.conn.models.Reply.create({ input, reply, created_by: createdBy });
      return ok(doc.toObject<ReplyDoc>());
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.create', input: { input } }),
      );
    }
  }

  public async deleteById(id: string): Promise<Result<boolean, DatabaseError>> {
    try {
      const res = await this.conn.models.Reply.findByIdAndDelete(id).exec();
      return ok(res !== null);
    } catch (rawErr: unknown) {
      return err(
        databaseErrorFrom(rawErr, { operation: 'MongoReplyRepo.deleteById', input: { id } }),
      );
    }
  }
}
