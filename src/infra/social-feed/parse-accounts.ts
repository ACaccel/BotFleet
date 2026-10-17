/**
 * Parses the `account` option of the `/feed_*` commands, which accepts
 * several handles in one invocation.
 *
 * Shared rather than duplicated: `/feed subscribe` and
 * `/feed unsubscribe` are sibling handler directories that may not
 * import each other, and both have to read the option the same way — a
 * list that parsed differently between subscribing and unsubscribing
 * would leave entries no command could remove. It lives beside
 * `normalizeAccount` because what it produces is a list of feed account
 * handles; the `@` strip and the case-insensitive de-duplication are
 * account rules, not option-reading ones.
 *
 * Pure string work, deliberately platform-agnostic. Canonicalising an
 * entry stays with `FeedPlatform.normalizeAccount`, which each command
 * runs afterwards on every entry it got back.
 */

/**
 * How many accounts one invocation may name.
 *
 * Each newly subscribed account costs one upstream timeline read, and
 * the whole batch has to finish inside the single deferred interaction
 * Discord expires after 15 minutes. A read is retried up to three times
 * with backoff, so its worst case is roughly 28 seconds at the shipped
 * 8-second platform timeout and roughly 95 at the configurable
 * 30-second ceiling — twenty of the latter would overrun the window, so
 * the cap alone is not the guarantee. `/feed subscribe` stops the batch
 * at its own deadline; what this cap does is bound the common case and
 * the reply, which lists one line per account.
 */
export const MAX_FEED_ACCOUNTS = 20;

/**
 * Entry separators: a comma or any whitespace, each repeatable.
 *
 * The two escaped code points are the full-width comma (U+FF0C) and the
 * ideographic comma (U+3001) — what a Chinese IME produces where an
 * English keyboard produces `,`. They are spelled as escapes so this
 * file stays free of CJK literals.
 */
const SEPARATOR = /[\s,\uFF0C\u3001]+/;

/** A leading `@` is decoration; every platform stores handles without it. */
const LEADING_AT = /^@+/;

/**
 * Outcome of parsing the option, as a discriminated union rather than a
 * `Result`: neither refusal is a domain failure with an error taxonomy
 * behind it, and the commands answer both with their own translated
 * copy. `Result`'s error channel is reserved for `DomainError`.
 */
type ParsedFeedAccounts =
  | { readonly kind: 'accounts'; readonly accounts: readonly string[] }
  /** The option held nothing but separators. */
  | { readonly kind: 'empty' }
  /** More than {@link MAX_FEED_ACCOUNTS} distinct entries. */
  | { readonly kind: 'too_many' };

/**
 * Split `raw` into the accounts it names, in first-seen order.
 *
 * Handles are case-insensitive, but URL paths/query keys and explicit
 * source prefixes retain their spelling until platform normalization.
 */
export const parseFeedAccounts = (raw: string): ParsedFeedAccounts => {
  const seen = new Map<string, string>();
  for (const token of raw.split(SEPARATOR)) {
    const account = token.replace(LEADING_AT, '');
    if (account === '') continue;
    const key = /[:/]/.test(account) ? account : account.toLowerCase();
    if (!seen.has(key)) seen.set(key, account);
  }
  if (seen.size === 0) return { kind: 'empty' };
  if (seen.size > MAX_FEED_ACCOUNTS) return { kind: 'too_many' };
  return { kind: 'accounts', accounts: [...seen.values()] };
};

/**
 * The reply arguments for a list that cannot be used, as a tuple a
 * caller spreads into its own `t` / refusal helper.
 *
 * Both `/feed_*` commands refuse an unusable list, and the copy has to
 * match between them — a member who is told "at most 20" by one command
 * and something else by the other has to guess which limit is real. The
 * catalog keys therefore live with the rule that produces them, exactly
 * as the platform adapters keep their own `errors:feed.*` keys.
 */
type FeedAccountRefusal = readonly [
  key: string,
  params?: Readonly<Record<string, string | number>>,
];

/** Key and params refusing `parsed`, which must not name any account. */
export const feedAccountRefusal = (
  parsed: Exclude<ParsedFeedAccounts, { kind: 'accounts' }>,
): FeedAccountRefusal => {
  // Exhaustive rather than a ternary: a third way for a list to be
  // unusable must fail the build here, not silently read as "empty".
  switch (parsed.kind) {
    case 'too_many':
      return ['replies:feed.too_many_accounts', { max: MAX_FEED_ACCOUNTS }];
    case 'empty':
      return ['replies:feed.no_accounts'];
    default: {
      const unreachable: never = parsed;
      throw new TypeError(`unhandled account-list refusal: ${JSON.stringify(unreachable)}`);
    }
  }
};
