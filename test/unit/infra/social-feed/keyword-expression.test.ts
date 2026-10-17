/**
 * The feed keyword language: what the command accepts and how the poller
 * evaluates it. Both sides read the same grammar, so every case here is
 * phrased as "this keyword, this post text, this verdict".
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_FEED_KEYWORD_LENGTH,
  compileFeedKeyword,
  feedKeywordRefusal,
  matchesFeedKeyword,
  parseFeedKeyword,
} from '../../../../src/infra/social-feed';

/** Evaluate `keyword` against `text` the way the poller does. */
const matches = (keyword: string, text: string): boolean => {
  const expression = compileFeedKeyword(keyword);
  if (expression === null) throw new Error(`no expression for ${JSON.stringify(keyword)}`);
  return matchesFeedKeyword(expression, text);
};

describe('matchesFeedKeyword', () => {
  it('matches a single keyword as a case-insensitive substring', () => {
    expect(matches('Album', 'new ALBUM out')).toBe(true);
    expect(matches('album', 'tour dates')).toBe(false);
  });

  it('keeps adjacent words as one phrase, spacing included', () => {
    expect(matches('new album', 'a new album today')).toBe(true);
    expect(matches('new album', 'album is new')).toBe(false);
  });

  it.each([
    ['live AND album', 'live album', true],
    ['live AND album', 'live only', false],
    ['live & album', 'album live', true],
    ['live OR album', 'album only', true],
    ['live | album', 'nothing here', false],
    ['live or album', 'album only', true],
    ['NOT replay', 'live now', true],
    ['NOT replay', 'replay now', false],
    ['live NOT replay', 'live replay', false],
    ['live NOT replay', 'live now', true],
    ['!replay', 'replay now', false],
    ['live !replay', 'live now', true],
    ['live !replay', 'live replay', false],
    ['\uFF01replay', 'live now', true],
    ['!(live OR replay)', 'album', true],
    ['!!live', 'live now', true],
  ])('%j against %j is %s', (keyword, text, expected) => {
    expect(matches(keyword, text)).toBe(expected);
  });

  it('binds AND tighter than OR', () => {
    // a OR (b AND c), not (a OR b) AND c.
    expect(matches('a1 OR b1 AND c1', 'a1')).toBe(true);
    expect(matches('a1 OR b1 AND c1', 'b1')).toBe(false);
  });

  it('lets parentheses override precedence', () => {
    expect(matches('(a1 OR b1) AND c1', 'a1')).toBe(false);
    expect(matches('(a1 OR b1) AND c1', 'b1 c1')).toBe(true);
    expect(matches('a1 OR (b1 AND c1)', 'b1 c1')).toBe(true);
  });

  it('accepts full-width parentheses and curly quotes', () => {
    expect(matches('a1 OR \uFF08b1 AND c1\uFF09', 'b1 c1')).toBe(true);
    expect(matches('\u201CR&B\u201D', 'new r&b single')).toBe(true);
  });

  it('keeps operator characters and words literal inside quotes', () => {
    expect(matches('"rock and roll"', 'rock and roll night')).toBe(true);
    expect(matches('"rock and roll"', 'rock night, roll on')).toBe(false);
    expect(matches('"R&B" OR jazz', 'r&b')).toBe(true);
  });

  it('keeps an exclamation mark inside or after a word literal', () => {
    expect(matches('notice!', 'big notice! today')).toBe(true);
    expect(matches('notice!', 'notice today')).toBe(false);
    expect(matches('a!b', 'xa!by')).toBe(true);
    expect(matches('"!replay"', 'the !replay tag')).toBe(true);
  });

  it('only treats whole words as operators', () => {
    expect(matches('android', 'android update')).toBe(true);
    expect(matches('nothing', 'nothing new')).toBe(true);
  });

  it('matches nothing but negations against empty text', () => {
    expect(matches('album', '')).toBe(false);
    expect(matches('NOT album', '')).toBe(true);
  });
});

describe('compileFeedKeyword', () => {
  it.each([undefined, '', '   '])('applies no narrowing for %j', (stored) => {
    expect(compileFeedKeyword(stored)).toBeNull();
  });

  it.each(['(part 2', 'AND', '"open', 'a ) b'])(
    'falls back to one literal substring for the legacy value %j',
    (stored) => {
      expect(compileFeedKeyword(stored)).toEqual({ kind: 'term', text: stored.toLowerCase() });
    },
  );
});

describe('parseFeedKeyword', () => {
  it.each([undefined, '', '  \n'])('reads %j as absent', (raw) => {
    expect(parseFeedKeyword(raw)).toEqual({ kind: 'absent' });
  });

  it('returns the trimmed keyword when it parses', () => {
    expect(parseFeedKeyword('  a1 OR (b1 AND c1) ')).toEqual({
      kind: 'keyword',
      keyword: 'a1 OR (b1 AND c1)',
    });
  });

  it.each([
    'a1 AND',
    'OR a1',
    'a1 OR OR b1',
    '(a1 OR b1',
    'a1 OR b1)',
    '()',
    '"a1',
    'a1"',
    '""',
    '"  "',
    '"a1" b1',
    'a1 (b1)',
    'NOT',
    '!',
    'notice !',
    '&',
  ])('refuses the malformed expression %j', (raw) => {
    expect(parseFeedKeyword(raw)).toEqual({ kind: 'invalid' });
  });

  it('refuses input past the length limit, measured after trimming', () => {
    expect(parseFeedKeyword(` ${'a'.repeat(MAX_FEED_KEYWORD_LENGTH)} `).kind).toBe('keyword');
    expect(parseFeedKeyword('a'.repeat(MAX_FEED_KEYWORD_LENGTH + 1))).toEqual({
      kind: 'too_long',
    });
  });
});

describe('feedKeywordRefusal', () => {
  it('names the limit for an over-long keyword', () => {
    expect(feedKeywordRefusal({ kind: 'too_long' })).toEqual([
      'replies:feed.keyword_too_long',
      { max: MAX_FEED_KEYWORD_LENGTH },
    ]);
  });

  it('points a malformed keyword at the syntax help', () => {
    expect(feedKeywordRefusal({ kind: 'invalid' })).toEqual(['replies:feed.keyword_invalid']);
  });
});
