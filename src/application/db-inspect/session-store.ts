/**
 * Short-lived `/db list` sessions.
 *
 * A result panel's buttons carry only a session token and a page number, so
 * the query itself stays in memory: Discord custom IDs are capped at 100
 * characters, and a filter value can be longer than that alone. Sessions
 * expire, are bound to the member who ran the query, and are lost on
 * restart; the panel then asks for a new query.
 */
import { randomBytes } from 'node:crypto';

import { DbInspectError } from '../../core/errors';
import type { InspectField } from '../../persistence/inspect/catalog';
import type {
  InspectCondition,
  InspectCount,
  InspectSort,
} from '../../persistence/repositories/db-inspect.repo';

export const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 200;

export interface QuerySession {
  readonly token: string;
  readonly userId: string;
  readonly database: string;
  readonly collection: string;
  readonly condition?: InspectCondition;
  readonly sort: InspectSort;
  readonly total: InspectCount;
  /** The filter field does not lead an index, so the query may be slow. */
  readonly unindexedFilter: boolean;
  readonly fields: readonly InspectField[];
  readonly summaryFields: readonly string[];
  /** `_id`s of the page last shown, as strings, for the detail menu. */
  pageIds: readonly string[];
  expiresAt: number;
}

export type NewQuerySession = Omit<QuerySession, 'token' | 'pageIds' | 'expiresAt'>;

export class QuerySessionStore {
  private readonly sessions = new Map<string, QuerySession>();

  public constructor(private readonly now: () => number = Date.now) {}

  public create(input: NewQuerySession): QuerySession {
    this.prune();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const session: QuerySession = {
      ...input,
      token: randomBytes(6).toString('base64url'),
      pageIds: [],
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** The live session for `token`, refreshed; throws when expired or foreign. */
  public require(token: string, userId: string): QuerySession {
    const session = this.sessions.get(token);
    if (session === undefined || session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      throw new DbInspectError('DB_INSPECT_SESSION_EXPIRED');
    }
    if (session.userId !== userId) throw new DbInspectError('DB_INSPECT_NOT_INVOKER');
    session.expiresAt = this.now() + SESSION_TTL_MS;
    return session;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
