/**
 * Unit tests for {@link extractUrls}: ordering, de-duplication,
 * angle-bracket / code / spoiler skipping, trailing and full-width
 * punctuation trimming, and the hard scan limit.
 */
import { describe, expect, it } from 'vitest';

import {
  extractUrls,
  HARD_SCAN_LIMIT,
} from '../../../../src/plugins/social-link-preview/internal/extract-urls';

const hrefs = (content: string, max?: number): string[] =>
  extractUrls(content, max).map((u) => u.href);

describe('extractUrls', () => {
  it('returns an empty array when there is no URL', () => {
    expect(extractUrls('just some text')).toEqual([]);
  });

  it('extracts multiple URLs in first-seen order', () => {
    expect(hrefs('a https://x.com/a/status/1 b https://www.instagram.com/p/abc/')).toEqual([
      'https://x.com/a/status/1',
      'https://www.instagram.com/p/abc/',
    ]);
  });

  it('de-duplicates repeated URLs', () => {
    expect(hrefs('https://x.com/a/status/1 https://x.com/a/status/1')).toEqual([
      'https://x.com/a/status/1',
    ]);
  });

  it('skips angle-bracket-wrapped URLs (the user opted out of an embed)', () => {
    expect(hrefs('look <https://x.com/a/status/1> here')).toEqual([]);
    expect(hrefs('a <https://x.com/a/status/1> b https://x.com/b/status/2')).toEqual([
      'https://x.com/b/status/2',
    ]);
  });

  it('skips URLs inside a spoiler, so the preview cannot reveal hidden content', () => {
    expect(hrefs('||https://x.com/a/status/1||')).toEqual([]);
    expect(hrefs('|| https://x.com/a/status/1 ||')).toEqual([]);
    expect(hrefs('||spoiler|| https://x.com/b/status/2')).toEqual(['https://x.com/b/status/2']);
  });

  it('skips URLs inside inline code and fenced code blocks', () => {
    expect(hrefs('`https://x.com/a/status/1`')).toEqual([]);
    expect(hrefs('```\nhttps://x.com/a/status/1\n```')).toEqual([]);
    expect(hrefs('`code` https://x.com/b/status/2')).toEqual(['https://x.com/b/status/2']);
  });

  it('does not treat spoiler bars inside code as a spoiler', () => {
    expect(hrefs('`a || b` https://x.com/b/status/2 `c || d`')).toEqual([
      'https://x.com/b/status/2',
    ]);
  });

  it('keeps a URL after an unmatched spoiler bar', () => {
    expect(hrefs('a || b https://x.com/b/status/2')).toEqual(['https://x.com/b/status/2']);
  });

  it('ends a URL at full-width punctuation written directly after it', () => {
    // Full-width comma, ideographic full stop and full-width right parenthesis.
    expect(hrefs('https://x.com/a/status/1\uff0cmore')).toEqual(['https://x.com/a/status/1']);
    expect(hrefs('https://x.com/a/status/1\u3002')).toEqual(['https://x.com/a/status/1']);
    expect(hrefs('\uff08https://x.com/a/status/1\uff09')).toEqual(['https://x.com/a/status/1']);
  });

  it('trims trailing sentence punctuation', () => {
    expect(hrefs('see https://x.com/a/status/1.')).toEqual(['https://x.com/a/status/1']);
    expect(hrefs('(https://x.com/a/status/1)')).toEqual(['https://x.com/a/status/1']);
  });

  it('honours the caller limit', () => {
    expect(
      hrefs('https://x.com/a/status/1 https://x.com/b/status/2 https://x.com/c/status/3', 2),
    ).toHaveLength(2);
  });

  it('never exceeds the hard scan limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://x.com/u/status/${i}`).join(' ');
    expect(extractUrls(many, 100)).toHaveLength(HARD_SCAN_LIMIT);
  });

  it('strips tracking params (mibextid / utm_* / fbclid / igsh / igsi) from extracted URLs', () => {
    expect(hrefs('https://www.facebook.com/share/r/1afkq5HHtD/?mibextid=WC7FNe')).toEqual([
      'https://www.facebook.com/share/r/1afkq5HHtD/',
    ]);
    expect(hrefs('https://x.com/a/status/1?utm_source=tw&utm_medium=x&fbclid=abc')).toEqual([
      'https://x.com/a/status/1',
    ]);
    expect(hrefs('https://www.instagram.com/reel/Cabc/?igsh=xyz&igshid=q')).toEqual([
      'https://www.instagram.com/reel/Cabc/',
    ]);
    expect(hrefs('https://www.instagram.com/p/DcmAigKJr9-/?igsi=MTlldjlrcm8zNHc4Yg==')).toEqual([
      'https://www.instagram.com/p/DcmAigKJr9-/',
    ]);
  });

  it('keeps meaningful query params (Facebook watch v, Bahamut sn)', () => {
    expect(hrefs('https://www.facebook.com/watch/?v=123&mibextid=ab')).toEqual([
      'https://www.facebook.com/watch/?v=123',
    ]);
    expect(hrefs('https://gnn.gamer.com.tw/detail.php?sn=297952&utm_source=fb')).toEqual([
      'https://gnn.gamer.com.tw/detail.php?sn=297952',
    ]);
  });

  it('de-duplicates links that differ only by tracking params', () => {
    expect(
      hrefs('https://x.com/a/status/1?utm_source=a https://x.com/a/status/1?fbclid=b'),
    ).toEqual(['https://x.com/a/status/1']);
  });
});
