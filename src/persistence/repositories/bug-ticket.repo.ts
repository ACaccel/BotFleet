/**
 * `BugTicketRepo` — `/bug_report` ticket metadata in the hub guild's
 * database.
 *
 * **Error boundary**: every method returns `Result<T, DatabaseError>`.
 */
import type { DatabaseError } from '../../core/errors/external-service-error';
import { err, ok, type Result } from '../../core/result';
import type { GuildConnection } from '../connection';
import { databaseErrorFrom } from '../error-translator';
import type { BugTicketDoc, BugTicketStatus, BugTicketType } from '../schemas/bug-ticket.schema';

export interface BugTicketInput {
  readonly bot_id: string;
  readonly reporter_id: string;
  readonly source_guild_id?: string;
  readonly source_channel_id?: string;
  readonly type: BugTicketType;
  readonly title: string;
  readonly created_at: number;
}

export interface BugTicketRepo {
  /** Insert with the bot's next number, retrying when two reports race for it. */
  createNumbered(input: BugTicketInput): Promise<Result<BugTicketDoc, DatabaseError>>;
  setThread(
    bot_id: string,
    number: number,
    thread_id: string,
  ): Promise<Result<void, DatabaseError>>;
  deleteByNumber(bot_id: string, number: number): Promise<Result<void, DatabaseError>>;
  findByNumber(
    bot_id: string,
    number: number,
  ): Promise<Result<BugTicketDoc | undefined, DatabaseError>>;
  findByThread(thread_id: string): Promise<Result<BugTicketDoc | undefined, DatabaseError>>;
  /** A reporter's tickets that are not closed, newest first. */
  listOpenByReporter(
    bot_id: string,
    reporter_id: string,
  ): Promise<Result<readonly BugTicketDoc[], DatabaseError>>;
  /** When the reporter last opened a ticket with this bot. */
  lastCreatedAt(
    bot_id: string,
    reporter_id: string,
  ): Promise<Result<number | undefined, DatabaseError>>;
  setStatus(
    bot_id: string,
    number: number,
    status: BugTicketStatus,
    closedBy?: { readonly at: number; readonly by: string },
  ): Promise<Result<void, DatabaseError>>;
  markDmFailed(bot_id: string, number: number): Promise<Result<void, DatabaseError>>;
}

const DUPLICATE_KEY = 11000;
const NUMBER_ATTEMPTS = 5;

const isDuplicateKey = (rawErr: unknown): boolean =>
  typeof rawErr === 'object' &&
  rawErr !== null &&
  (rawErr as { code?: unknown }).code === DUPLICATE_KEY;

export class MongoBugTicketRepo implements BugTicketRepo {
  constructor(private readonly conn: GuildConnection) {}

  private fail(operation: string, rawErr: unknown): DatabaseError {
    return databaseErrorFrom(rawErr, { operation: `MongoBugTicketRepo.${operation}` });
  }

  public async createNumbered(input: BugTicketInput): Promise<Result<BugTicketDoc, DatabaseError>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
      try {
        const latest = await this.conn.models.BugTicket.findOne({ bot_id: input.bot_id })
          .sort({ number: -1 })
          .lean<{ number: number }>()
          .exec();
        const doc = await this.conn.models.BugTicket.create({
          ...input,
          number: (latest?.number ?? 0) + 1,
          status: 'open',
        });
        return ok(doc.toObject<BugTicketDoc>());
      } catch (rawErr: unknown) {
        lastErr = rawErr;
        if (!isDuplicateKey(rawErr)) break;
      }
    }
    return err(this.fail('createNumbered', lastErr));
  }

  public async setThread(
    bot_id: string,
    number: number,
    thread_id: string,
  ): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.BugTicket.updateOne(
        { bot_id, number },
        { $set: { thread_id } },
      ).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('setThread', rawErr));
    }
  }

  public async deleteByNumber(
    bot_id: string,
    number: number,
  ): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.BugTicket.deleteOne({ bot_id, number }).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('deleteByNumber', rawErr));
    }
  }

  public async findByNumber(
    bot_id: string,
    number: number,
  ): Promise<Result<BugTicketDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.BugTicket.findOne({ bot_id, number })
        .lean<BugTicketDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('findByNumber', rawErr));
    }
  }

  public async findByThread(
    thread_id: string,
  ): Promise<Result<BugTicketDoc | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.BugTicket.findOne({ thread_id })
        .lean<BugTicketDoc>()
        .exec();
      return ok(doc ?? undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('findByThread', rawErr));
    }
  }

  public async listOpenByReporter(
    bot_id: string,
    reporter_id: string,
  ): Promise<Result<readonly BugTicketDoc[], DatabaseError>> {
    try {
      return ok(
        await this.conn.models.BugTicket.find({
          bot_id,
          reporter_id,
          status: { $ne: 'closed' },
        })
          .sort({ number: -1 })
          .lean<BugTicketDoc[]>()
          .exec(),
      );
    } catch (rawErr: unknown) {
      return err(this.fail('listOpenByReporter', rawErr));
    }
  }

  public async lastCreatedAt(
    bot_id: string,
    reporter_id: string,
  ): Promise<Result<number | undefined, DatabaseError>> {
    try {
      const doc = await this.conn.models.BugTicket.findOne({ bot_id, reporter_id })
        .sort({ created_at: -1 })
        .lean<{ created_at: number }>()
        .exec();
      return ok(doc?.created_at);
    } catch (rawErr: unknown) {
      return err(this.fail('lastCreatedAt', rawErr));
    }
  }

  public async setStatus(
    bot_id: string,
    number: number,
    status: BugTicketStatus,
    closedBy?: { readonly at: number; readonly by: string },
  ): Promise<Result<void, DatabaseError>> {
    try {
      const update =
        closedBy === undefined
          ? { $set: { status }, $unset: { closed_at: 1, closed_by: 1 } }
          : { $set: { status, closed_at: closedBy.at, closed_by: closedBy.by } };
      await this.conn.models.BugTicket.updateOne({ bot_id, number }, update).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('setStatus', rawErr));
    }
  }

  public async markDmFailed(bot_id: string, number: number): Promise<Result<void, DatabaseError>> {
    try {
      await this.conn.models.BugTicket.updateOne(
        { bot_id, number },
        { $set: { dm_failed: true } },
      ).exec();
      return ok(undefined);
    } catch (rawErr: unknown) {
      return err(this.fail('markDmFailed', rawErr));
    }
  }
}
