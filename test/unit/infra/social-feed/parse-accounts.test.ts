/**
 * The `target` option parser shared by `/feed subscribe` and
 * `/feed unsubscribe`.
 *
 * It is the only thing standing between a free-text Discord option and
 * a list of subscription keys, so every separator a member might type,
 * every duplicate they might repeat, and both refusals are pinned here.
 * The commands themselves then only have to route the outcome.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_FEED_ACCOUNTS,
  feedAccountRefusal,
  parseFeedAccounts,
} from '../../../../src/infra/social-feed/parse-accounts';

/** The accounts a successful parse produced; fails the test otherwise. */
const accountsOf = (raw: string): readonly string[] => {
  const parsed = parseFeedAccounts(raw);
  expect(parsed.kind).toBe('accounts');
  return parsed.kind === 'accounts' ? parsed.accounts : [];
};

describe('parseFeedAccounts', () => {
  it('preserves case-sensitive URL keys while still deduplicating handles and identical URLs', () => {
    const lower = 'https://forum.gamer.com.tw/C.php?bsn=12345&sna=42';
    const upper = 'https://forum.gamer.com.tw/C.php?bsn=12345&snA=42';
    expect(accountsOf(`${lower},${upper},${upper},SomeOne,someone`)).toEqual([
      lower,
      upper,
      'SomeOne',
    ]);
  });
  it('reads a single account, which stays the common case', () => {
    expect(accountsOf('someone')).toEqual(['someone']);
  });

  it.each([
    ['comma', 'a1,a2,a3'],
    ['comma and space', 'a1, a2, a3'],
    ['spaces alone', 'a1 a2 a3'],
    ['newlines', 'a1\na2\na3'],
    ['runs of separators', 'a1 ,,  a2,\n,a3'],
    ['a full-width comma, as a Chinese IME produces', 'a1，a2，a3'],
    ['an ideographic comma', 'a1、a2、a3'],
  ])('splits on %s', (_label, raw) => {
    expect(accountsOf(raw)).toEqual(['a1', 'a2', 'a3']);
  });

  it('strips a leading @, however many the member typed', () => {
    expect(accountsOf('@a1, @@a2')).toEqual(['a1', 'a2']);
  });

  it('keeps an @ that is not leading, because it may be part of a handle', () => {
    expect(accountsOf('some@one')).toEqual(['some@one']);
  });

  it('drops duplicates case-insensitively, keeping the first spelling', () => {
    // Every shipped platform lower-cases a handle, so these name one
    // subscription; reporting it twice would suggest two were written.
    expect(accountsOf('Alpha, @ALPHA, alpha, beta')).toEqual(['Alpha', 'beta']);
  });

  it('preserves first-seen order, which the reply echoes back', () => {
    expect(accountsOf('zeta, alpha, mid')).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('accepts exactly the cap', () => {
    const raw = Array.from({ length: MAX_FEED_ACCOUNTS }, (_, i) => `a${String(i)}`).join(',');

    expect(accountsOf(raw)).toHaveLength(MAX_FEED_ACCOUNTS);
  });

  it('refuses one account past the cap', () => {
    const raw = Array.from({ length: MAX_FEED_ACCOUNTS + 1 }, (_, i) => `a${String(i)}`).join(',');

    expect(parseFeedAccounts(raw).kind).toBe('too_many');
  });

  it('counts distinct accounts against the cap, not raw tokens', () => {
    // A repeated handle is collapsed before the cap is applied, so
    // pasting the same list twice is not a refusal.
    const distinct = Array.from({ length: MAX_FEED_ACCOUNTS }, (_, i) => `a${String(i)}`);

    expect(accountsOf([...distinct, ...distinct].join(','))).toHaveLength(MAX_FEED_ACCOUNTS);
  });

  it.each([
    ['', 'the empty string'],
    ['   ', 'whitespace'],
    [' , ,, ', 'separators only'],
    ['@', 'a bare @'],
  ])('reports %j (%s) as an empty list', (raw) => {
    expect(parseFeedAccounts(raw).kind).toBe('empty');
  });
});

describe('feedAccountRefusal', () => {
  it('names the cap in the too-many copy, so the member learns the limit', () => {
    expect(feedAccountRefusal({ kind: 'too_many' })).toEqual([
      'replies:feed.too_many_accounts',
      { max: MAX_FEED_ACCOUNTS },
    ]);
  });

  it('needs no params for the empty copy', () => {
    expect(feedAccountRefusal({ kind: 'empty' })).toEqual(['replies:feed.no_accounts']);
  });
});

it('retains YouTube handles and distinct case-sensitive channel IDs', () => {
  const first = 'UCAbCdEfGhIjKlMnOpQrStUv';
  const second = 'UCabCdEfGhIjKlMnOpQrStUv';
  expect(parseFeedAccounts(`@Example, ${first}, ${second}`, 'youtube')).toEqual({
    kind: 'accounts',
    accounts: ['@Example', first, second],
  });
  expect(parseFeedAccounts(`${first}, ${second}`)).toEqual({
    kind: 'accounts',
    accounts: [first, second],
  });
});
