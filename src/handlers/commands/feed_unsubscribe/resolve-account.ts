/**
 * Turns `/feed unsubscribe`'s optional `account` list into the values
 * stored on subscriptions, so the deletion scope matches what was
 * written by `/feed subscribe`.
 *
 * Adapter-injected so the fallback can be tested without configuring a
 * platform. Stored forum IDs and board/thread URLs resolve offline;
 * resolving a floor link may require the configured adapter's upstream.
 */
import { ok, type Result } from '../../../core/result';
import {
  normalizeBahamutTargetOffline,
  type FeedFailure,
  type FeedPlatform,
} from '../../../infra/social-feed';

/**
 * Best-effort normalisation for an account whose platform is unknown.
 *
 * Handle-based platforms store accounts lower-cased and without a
 * leading `@`, so this reproduces the common part of their rule. It is a
 * deliberate compromise: `platform` is optional on this command, and
 * refusing to unsubscribe without it would be worse than occasionally
 * matching nothing — a platform with case-sensitive handles would need
 * its `platform` named for an exact match.
 */
const fallbackNormalize = (raw: string): string => raw.replace(/^@+/, '').toLowerCase();

/**
 * The stored accounts the deletion should match, or `undefined` when
 * the user named no account at all and the deletion covers the whole
 * channel.
 *
 * With a platform in hand the platform's own rule applies per entry,
 * and a handle that platform rejects fails the **whole** call on the
 * Err rail. Skipping the bad entry and deleting the rest would be worse:
 * the member asked for a specific set, and a reply listing removals
 * would make a typo look like an account that was never subscribed.
 */
export const resolveUnsubscribeAccounts = async (
  platform: FeedPlatform | undefined,
  raw: readonly string[] | undefined,
  platformId?: string,
): Promise<Result<readonly string[] | undefined, FeedFailure>> => {
  // Only `undefined` widens the scope to the whole channel. An empty
  // list names no account, and the repository matches nothing for it —
  // collapsing the two here would turn "remove nothing" into "remove
  // everything". The parser never yields one, which is why this is a
  // guard rather than a branch the command can reach.
  if (raw === undefined) return ok(undefined);
  const accounts: string[] = [];
  for (const entry of raw) {
    if ((platformId ?? platform?.id) === 'bahamut') {
      const offline = normalizeBahamutTargetOffline(entry);
      if (offline.ok) {
        accounts.push(offline.value);
        continue;
      }
      if (platform === undefined) return offline;
    }
    if (platform === undefined) {
      accounts.push(fallbackNormalize(entry));
      continue;
    }
    const normalized = await platform.normalizeAccount(entry);
    if (!normalized.ok) return normalized;
    accounts.push(normalized.value);
  }
  return ok(accounts);
};
