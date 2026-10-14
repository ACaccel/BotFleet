/**
 * Expected rejections of nijika's `/db` inspection: an unknown target, an
 * invalid filter, or a result panel that expired or belongs to someone else.
 * The handlers answer them privately with `messageKey`; none is a failure.
 */
import { DomainError } from './domain-error';

export type DbInspectErrorCode =
  | 'DB_INSPECT_UNAVAILABLE'
  | 'DB_INSPECT_GUILD_REQUIRED'
  | 'DB_INSPECT_UNKNOWN_GUILD'
  | 'DB_INSPECT_UNKNOWN_COLLECTION'
  | 'DB_INSPECT_UNKNOWN_FIELD'
  | 'DB_INSPECT_PARTIAL_FILTER'
  | 'DB_INSPECT_INVALID_OPERATOR'
  | 'DB_INSPECT_INVALID_VALUE'
  | 'DB_INSPECT_INVALID_SORT'
  | 'DB_INSPECT_NOT_FOUND'
  | 'DB_INSPECT_SESSION_EXPIRED'
  | 'DB_INSPECT_NOT_INVOKER';

const KEYS: Readonly<Record<DbInspectErrorCode, string>> = {
  DB_INSPECT_UNAVAILABLE: 'replies:db_inspect.unavailable',
  DB_INSPECT_GUILD_REQUIRED: 'replies:db_inspect.guild_required',
  DB_INSPECT_UNKNOWN_GUILD: 'replies:db_inspect.unknown_guild',
  DB_INSPECT_UNKNOWN_COLLECTION: 'replies:db_inspect.unknown_collection',
  DB_INSPECT_UNKNOWN_FIELD: 'replies:db_inspect.unknown_field',
  DB_INSPECT_PARTIAL_FILTER: 'replies:db_inspect.partial_filter',
  DB_INSPECT_INVALID_OPERATOR: 'replies:db_inspect.invalid_operator',
  DB_INSPECT_INVALID_VALUE: 'replies:db_inspect.invalid_value',
  DB_INSPECT_INVALID_SORT: 'replies:db_inspect.invalid_sort',
  DB_INSPECT_NOT_FOUND: 'replies:db_inspect.not_found',
  DB_INSPECT_SESSION_EXPIRED: 'replies:db_inspect.session_expired',
  DB_INSPECT_NOT_INVOKER: 'replies:db_inspect.not_invoker',
};

type DbInspectParams = Readonly<Record<string, string | number>> | undefined;

export class DbInspectError extends DomainError<DbInspectErrorCode, DbInspectParams> {
  public constructor(code: DbInspectErrorCode, params?: Readonly<Record<string, string | number>>) {
    super({
      code,
      messageKey: KEYS[code],
      context: { operation: 'dbInspect' },
      ...(params === undefined ? {} : { messageParams: params }),
    });
  }
}
