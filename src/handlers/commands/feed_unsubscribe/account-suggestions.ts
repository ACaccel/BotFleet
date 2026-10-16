/**
 * Turns a channel's stored subscriptions into the suggestions
 * `/feed unsubscribe` offers for its `account` option.
 *
 * The option takes a list, so completion works on the **last** segment
 * only and each suggestion's value repeats the segments already typed.
 * Discord replaces the whole option value with whatever the member
 * picks; a value carrying just the candidate would silently discard the
 * accounts they had already named.
 *
 * Earlier segments are re-parsed with `parseFeedAccounts` — the same
 * function the command reads the option with — so the echoed prefix is
 * exactly what the deletion will act on; a different normalisation would
 * quietly change the scope the member chose.
 *
 * Pure: it takes documents and strings, so it is testable without an
 * interaction or a database.
 */
import type { FeedSubscriptionDoc } from '../../../persistence/schemas/feed-subscription.schema';
import {
  MAX_AUTOCOMPLETE_CHOICES,
  MAX_AUTOCOMPLETE_FIELD_LENGTH,
} from '../../../infra/discord/autocomplete-limits';
import { MAX_FEED_ACCOUNTS, parseFeedAccounts } from '../../../infra/social-feed';
import { feedPlatformDisplayName } from '../../feed-platform-name';
import type { CommandSuggestions } from '../command';

/**
 * How the rebuilt list is spelled. `parseFeedAccounts` accepts any
 * mixture of commas and whitespace, so the one it round-trips through
 * is a choice — comma-and-space, which is how the command's own replies
 * render a list.
 */
const SEGMENT_SEPARATOR = ', ';

/** A leading `@` is decoration, exactly as it is when the option is parsed. */
const LEADING_AT = /^@+/;

/** What the member has narrowed the suggestion list to so far. */
interface AccountSuggestionScope {
  /** The `platform` option, when they have already filled it in. */
  readonly platform?: string;
  /** The `account` option's text as typed so far, commas and all. */
  readonly focused: string;
}

/**
 * The accounts to offer, best-effort ordered as the repository returned
 * them (platform, then account).
 *
 * An account already named in an earlier segment is left out — it is
 * the one candidate that certainly adds nothing. A candidate whose
 * rendered value or label would exceed Discord's 100-character ceiling
 * is dropped rather than truncated: a truncated handle is a different
 * handle, and the member would not see that until nothing was removed.
 *
 * The same account subscribed on two platforms yields two entries, each
 * naming its own platform. Their values are identical, which is
 * truthful — an `account` given without a `platform` removes the
 * subscription from both.
 */
export const buildAccountSuggestions = (
  docs: readonly FeedSubscriptionDoc[],
  scope: AccountSuggestionScope,
): CommandSuggestions => {
  const segments = scope.focused.split(',');
  // The last segment is what the member is still typing; everything
  // before it is settled and gets echoed back verbatim-but-normalised.
  const fragment = (segments.at(-1) ?? '').trim().replace(LEADING_AT, '').toLowerCase();
  const parsed = parseFeedAccounts(segments.slice(0, -1).join(','));
  if (parsed.kind === 'too_many') return [];
  const committed = parsed.kind === 'accounts' ? parsed.accounts : [];
  // A list already at the command's own cap cannot usefully grow: the
  // command refuses the whole option at one entry more, so offering a
  // candidate here would only build a list it then rejects.
  if (committed.length >= MAX_FEED_ACCOUNTS) return [];
  const taken = new Set(committed.map((account) => account.toLowerCase()));
  const prefix =
    committed.length === 0 ? '' : committed.join(SEGMENT_SEPARATOR) + SEGMENT_SEPARATOR;

  const suggestions: { name: string; value: string }[] = [];
  for (const doc of docs) {
    if (suggestions.length >= MAX_AUTOCOMPLETE_CHOICES) break;
    if (scope.platform !== undefined && doc.platform !== scope.platform) continue;
    const lower = doc.account.toLowerCase();
    if (taken.has(lower) || !lower.includes(fragment)) continue;
    const value = `${prefix}${doc.account}`;
    const name = `${feedPlatformDisplayName(doc.platform)} @${doc.account}`;
    if (value.length > MAX_AUTOCOMPLETE_FIELD_LENGTH) continue;
    if (name.length > MAX_AUTOCOMPLETE_FIELD_LENGTH) continue;
    suggestions.push({ name, value });
  }
  return suggestions;
};
