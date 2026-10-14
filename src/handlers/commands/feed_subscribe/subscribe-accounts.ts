/**
 * Runs `/feed subscribe`'s per-account work for a whole invocation and
 * reports what happened to each one.
 *
 * Failure isolation is the reason this exists as its own loop. A handle
 * that is misspelled, suspended, or momentarily unreachable must cost
 * that account only — aborting would drop the accounts behind it after
 * the ones ahead had already been written, leaving the member unable to
 * tell which. Every account therefore ends in an outcome record, the
 * unexpected ones included: a throw anywhere in one account's sequence
 * is caught here rather than at the handler boundary. Because that
 * hides the failure from `replyForError`, every caught value goes to
 * `logFailure` — isolation must not cost the operator channel. The two
 * conditions that stop the loop instead of isolating live in
 * `batch-policy.ts`, and an account never reached is reported as
 * `skipped` rather than passed over in silence.
 *
 * Sequential on purpose: a new subscription reads the platform once,
 * and firing twenty of those at once would turn one command into a
 * burst against an upstream the poller has to keep using. It holds no
 * Discord types, so the whole matrix of outcomes is exercised without
 * an interaction; rendering them is `format-outcomes.ts`'s job.
 */
import { prepareFeedSubscription, type FeedPlatform } from '../../../infra/social-feed';
import type {
  FeedSubscriptionFilterInput,
  FeedSubscriptionRepo,
} from '../../../persistence/repositories';
import { isSystemicFailure } from './batch-policy';

interface FeedSubscribeSuccess {
  /** The handle as the platform canonicalised it, and as it is stored. */
  readonly account: string;
  readonly status: 'created' | 'updated';
}

interface FeedSubscribeFailure {
  /**
   * Canonical handle when normalisation got that far, else what was
   * typed — which is why the renderer defuses it before quoting it.
   */
  readonly account: string;
  readonly status: 'failed';
  /**
   * What went wrong, unrendered — which is what lets the reply and the
   * operator log spell it differently, and this module skip a translator.
   */
  readonly cause: unknown;
}

interface FeedSubscribeSkipped {
  readonly account: string;
  readonly status: 'skipped';
}

/**
 * What became of one account. A discriminated union rather than
 * optional fields, so a reader that forgets to check `status` before
 * reaching for `cause` does not compile.
 */
export type FeedSubscribeOutcome =
  | FeedSubscribeSuccess
  | FeedSubscribeFailure
  | FeedSubscribeSkipped;

interface SubscribeAccountsRequest {
  readonly platform: FeedPlatform;
  readonly repo: FeedSubscriptionRepo;
  /** Parsed handles, still to be canonicalised by the platform. */
  readonly accounts: readonly string[];
  readonly channelId: string;
  readonly createdBy: string;
  /** Applied to every account in the batch; the options are per-invocation. */
  readonly filter: FeedSubscriptionFilterInput;
  /** Wall clock after which no further account is started. */
  readonly deadlineMs: number;
  /**
   * Writes the operator record of a failure this loop absorbed. Taken
   * as a callback so the module stays free of both Discord and the
   * logger, and so a test can assert that nothing was swallowed
   * silently.
   */
  logFailure(cause: unknown): void;
}

/**
 * Normalise, validate against the platform, and write one account. The
 * clock is read before the upstream request: a later reading could sit
 * past a post published while it was in flight and skip it forever.
 */
const subscribeOne = async (
  request: SubscribeAccountsRequest,
  raw: string,
): Promise<FeedSubscribeOutcome> => {
  const failed = (account: string, cause: unknown): FeedSubscribeFailure => {
    request.logFailure(cause);
    return { account, status: 'failed', cause };
  };
  try {
    const prepared = await prepareFeedSubscription(request.platform, raw, {
      nowMs: Date.now(),
      isNew: async (account) => {
        const found = await request.repo.find(request.platform.id, account, request.channelId);
        if (!found.ok) throw found.error;
        return found.value === undefined;
      },
    });
    if (!prepared.ok) return failed(raw, prepared.error);
    const { account, cursor } = prepared.value;

    const result = await request.repo.upsert({
      platform: request.platform.id,
      account,
      channel_id: request.channelId,
      created_by: request.createdBy,
      filter: request.filter,
      // Omitted rather than undefined for an existing subscription: the
      // repository writes what it is given, and the stored cursor must
      // survive a filter change.
      ...(cursor === undefined
        ? {}
        : { last_seen_id: cursor.lastSeenId, last_seen_timestamp: cursor.lastSeenTimestamp }),
    });
    if (!result.ok) return failed(account, result.error);
    return { account, status: result.value.created ? 'created' : 'updated' };
  } catch (error: unknown) {
    // Includes programmer errors. They must not take the rest of the
    // batch down, and `logFailure` is what keeps them diagnosable.
    return failed(raw, error);
  }
};

/** Subscribe every requested account, in the order they were named. */
export const subscribeAccounts = async (
  request: SubscribeAccountsRequest,
): Promise<readonly FeedSubscribeOutcome[]> => {
  const outcomes: FeedSubscribeOutcome[] = [];
  let stopped = false;
  for (const raw of request.accounts) {
    if (stopped || Date.now() >= request.deadlineMs) {
      outcomes.push({ account: raw, status: 'skipped' });
      continue;
    }
    const outcome = await subscribeOne(request, raw);
    outcomes.push(outcome);
    stopped = outcome.status === 'failed' && isSystemicFailure(outcome.cause);
  }
  return outcomes;
};
