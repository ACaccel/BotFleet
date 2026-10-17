/**
 * The boolean keyword language of a feed subscription's `keyword` filter.
 *
 * Shared rather than owned by one side: `/feed subscribe` validates the
 * expression before storing it, and the social-feed plugin evaluates the
 * stored string on every poll. The two are sibling layers that may not
 * import each other, and they must agree on one grammar — an expression
 * the command accepted but the poller read differently would forward the
 * wrong posts.
 *
 * Grammar, loosest binding first:
 *
 *   expression := and ( OR and )*
 *   and        := unary ( AND unary | <NOT unary> )*
 *   unary      := NOT unary | primary
 *   primary    := term | "(" expression ")"
 *
 * `AND` / `&`, `OR` / `|` and `NOT` / `!` are operators; the words match in
 * any letter case but only as whole words. `!` negates only where a word
 * would start, so `!replay` is a negation while a trailing `notice!` stays
 * literal text. `A NOT B` reads as `A AND NOT B`.
 * Adjacent bare words with no operator between them form one phrase, so a
 * plain keyword — the only form that existed before this language — still
 * means the same case-insensitive substring. Quoting a term keeps operator
 * characters and words literal.
 *
 * Pure string work: no I/O, and nothing platform-specific.
 */

/** Matches the schema's `maxlength` on the stored `filter.keyword`. */
export const MAX_FEED_KEYWORD_LENGTH = 100;

/** A parsed expression; every term is already lower-cased for matching. */
export type FeedKeywordExpression =
  | { readonly kind: 'term'; readonly text: string }
  | { readonly kind: 'not'; readonly operand: FeedKeywordExpression }
  | {
      readonly kind: 'and' | 'or';
      readonly left: FeedKeywordExpression;
      readonly right: FeedKeywordExpression;
    };

type Token =
  | {
      readonly kind: 'term';
      readonly text: string;
      readonly bare: boolean;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'and' | 'or' | 'not' | 'open' | 'close' };

/**
 * Grouping and quoting characters, each with its full-width or typographic
 * twin: a Chinese IME types the full-width parentheses (U+FF08, U+FF09), and
 * mobile keyboards substitute curly quotes (U+201C, U+201D) for `"`. They are
 * spelled as escapes so this file stays free of CJK literals.
 */
const OPEN_PARENS = new Set(['(', '\uFF08']);
const CLOSE_PARENS = new Set([')', '\uFF09']);
const OPEN_QUOTES = new Set(['"', '\u201C']);
const CLOSE_QUOTES = new Set(['"', '\u201D']);

/** Characters that end a bare word. */
const isDelimiter = (char: string): boolean =>
  /\s/.test(char) ||
  OPEN_PARENS.has(char) ||
  CLOSE_PARENS.has(char) ||
  OPEN_QUOTES.has(char) ||
  CLOSE_QUOTES.has(char) ||
  char === '&' ||
  char === '|';

/**
 * The prefix negation mark and its full-width twin (U+FF01), which a
 * Chinese IME types in place of `!`.
 */
const NEGATION_MARKS = new Set(['!', '\uFF01']);

const OPERATOR_WORDS: Readonly<Record<string, 'and' | 'or' | 'not'>> = {
  AND: 'and',
  OR: 'or',
  NOT: 'not',
};

/** Split `raw` into tokens, or `null` when a quote is unterminated or empty. */
const tokenize = (raw: string): Token[] | null => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (OPEN_PARENS.has(char)) {
      tokens.push({ kind: 'open' });
      index += 1;
    } else if (CLOSE_PARENS.has(char)) {
      tokens.push({ kind: 'close' });
      index += 1;
    } else if (char === '&') {
      tokens.push({ kind: 'and' });
      index += 1;
    } else if (char === '|') {
      tokens.push({ kind: 'or' });
      index += 1;
    } else if (OPEN_QUOTES.has(char)) {
      let close = index + 1;
      while (close < raw.length && !CLOSE_QUOTES.has(raw.charAt(close))) close += 1;
      if (close >= raw.length) return null;
      const text = raw.slice(index + 1, close);
      // A blank term would be a substring of every post, silently turning
      // its branch of the expression into "match everything".
      if (text.trim() === '') return null;
      tokens.push({ kind: 'term', text, bare: false, start: index, end: close + 1 });
      index = close + 1;
    } else if (CLOSE_QUOTES.has(char)) {
      return null;
    } else if (NEGATION_MARKS.has(char)) {
      // Reached only at the start of a word: inside one, the bare-word scan
      // below consumes the mark as ordinary text.
      tokens.push({ kind: 'not' });
      index += 1;
    } else {
      let end = index;
      while (end < raw.length && !isDelimiter(raw.charAt(end))) end += 1;
      const word = raw.slice(index, end);
      const operator = OPERATOR_WORDS[word.toUpperCase()];
      tokens.push(
        operator === undefined
          ? { kind: 'term', text: word, bare: true, start: index, end }
          : { kind: operator },
      );
      index = end;
    }
  }
  return mergeBarePhrases(raw, tokens);
};

/**
 * Join runs of adjacent bare words into one phrase term, keeping the
 * original spacing between them so the phrase is exactly the substring the
 * member typed.
 */
const mergeBarePhrases = (raw: string, tokens: readonly Token[]): Token[] => {
  const merged: Token[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (token.kind === 'term' && token.bare && previous?.kind === 'term' && previous.bare) {
      merged[merged.length - 1] = {
        kind: 'term',
        text: raw.slice(previous.start, token.end),
        bare: true,
        start: previous.start,
        end: token.end,
      };
    } else {
      merged.push(token);
    }
  }
  return merged;
};

/** Recursive-descent parser over a token list; `null` on any syntax error. */
const parseTokens = (tokens: readonly Token[]): FeedKeywordExpression | null => {
  let position = 0;
  const peek = (): Token | undefined => tokens[position];

  const parseOr = (): FeedKeywordExpression | null => {
    let left = parseAnd();
    while (left !== null && peek()?.kind === 'or') {
      position += 1;
      const right = parseAnd();
      left = right === null ? null : { kind: 'or', left, right };
    }
    return left;
  };

  const parseAnd = (): FeedKeywordExpression | null => {
    let left = parseUnary();
    while (left !== null) {
      const next = peek()?.kind;
      if (next === 'and') {
        position += 1;
      } else if (next !== 'not') {
        break;
      }
      const right = parseUnary();
      left = right === null ? null : { kind: 'and', left, right };
    }
    return left;
  };

  const parseUnary = (): FeedKeywordExpression | null => {
    if (peek()?.kind !== 'not') return parsePrimary();
    position += 1;
    const operand = parseUnary();
    return operand === null ? null : { kind: 'not', operand };
  };

  const parsePrimary = (): FeedKeywordExpression | null => {
    const token = peek();
    if (token?.kind === 'term') {
      position += 1;
      return { kind: 'term', text: token.text.toLowerCase() };
    }
    if (token?.kind !== 'open') return null;
    position += 1;
    const inner = parseOr();
    if (inner === null || peek()?.kind !== 'close') return null;
    position += 1;
    return inner;
  };

  const expression = parseOr();
  // Leftover tokens mean two operands met with no operator between them,
  // such as a quoted term beside a bare word, or a stray `)`.
  return expression !== null && position === tokens.length ? expression : null;
};

/** Parse `raw` as an expression, or `null` when it is not well formed. */
const parse = (raw: string): FeedKeywordExpression | null => {
  const tokens = tokenize(raw);
  return tokens === null || tokens.length === 0 ? null : parseTokens(tokens);
};

/**
 * Outcome of validating a member's `keyword` option, as a discriminated
 * union rather than a `Result` for the same reason as `parseFeedAccounts`:
 * the refusals are input mistakes answered with translated copy, not
 * domain failures.
 */
type ParsedFeedKeyword =
  | { readonly kind: 'absent' }
  | { readonly kind: 'keyword'; readonly keyword: string }
  | { readonly kind: 'too_long' }
  | { readonly kind: 'invalid' };

/**
 * Validate the `keyword` option a member typed.
 *
 * Blank counts as absent, so clearing the option and omitting it mean the
 * same thing. Over-long input is refused rather than truncated: cutting an
 * expression short can unbalance it or drop an operand, which would store
 * a filter the member never wrote.
 */
export const parseFeedKeyword = (raw: string | undefined): ParsedFeedKeyword => {
  const keyword = raw?.trim() ?? '';
  if (keyword === '') return { kind: 'absent' };
  if (keyword.length > MAX_FEED_KEYWORD_LENGTH) return { kind: 'too_long' };
  return parse(keyword) === null ? { kind: 'invalid' } : { kind: 'keyword', keyword };
};

/** Key and params for a reply refusing a keyword, as `feedAccountRefusal` shapes them. */
type FeedKeywordRefusal = readonly [
  key: string,
  params?: Readonly<Record<string, string | number>>,
];

/** Key and params refusing `parsed`, which must be neither absent nor valid. */
export const feedKeywordRefusal = (
  parsed: Extract<ParsedFeedKeyword, { kind: 'too_long' | 'invalid' }>,
): FeedKeywordRefusal => {
  switch (parsed.kind) {
    case 'too_long':
      return ['replies:feed.keyword_too_long', { max: MAX_FEED_KEYWORD_LENGTH }];
    case 'invalid':
      return ['replies:feed.keyword_invalid'];
    default: {
      const unreachable: never = parsed;
      throw new TypeError(`unhandled keyword refusal: ${JSON.stringify(unreachable)}`);
    }
  }
};

/**
 * Compile a stored keyword for matching.
 *
 * A stored value that does not parse predates this language — any text up
 * to the length limit used to be accepted as one substring — so it keeps
 * that meaning instead of failing the subscription. A blank value applies
 * no narrowing, as an empty substring always did.
 */
export const compileFeedKeyword = (stored: string | undefined): FeedKeywordExpression | null => {
  const keyword = stored?.trim() ?? '';
  if (keyword === '') return null;
  return parse(keyword) ?? { kind: 'term', text: keyword.toLowerCase() };
};

/**
 * True when `text` satisfies the expression. Every term is a
 * case-insensitive substring test, so `''` — a post whose platform exposes
 * no text — satisfies only expressions whose truth does not need a term
 * to be present, such as `NOT A`.
 */
export const matchesFeedKeyword = (expression: FeedKeywordExpression, text: string): boolean => {
  const haystack = text.toLowerCase();
  const evaluate = (node: FeedKeywordExpression): boolean => {
    switch (node.kind) {
      case 'term':
        return haystack.includes(node.text);
      case 'not':
        return !evaluate(node.operand);
      case 'and':
        return evaluate(node.left) && evaluate(node.right);
      case 'or':
        return evaluate(node.left) || evaluate(node.right);
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  };
  return evaluate(expression);
};
