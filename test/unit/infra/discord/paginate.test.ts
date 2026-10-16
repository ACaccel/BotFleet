/**
 * Line-to-page packing, the rule both feed listings depend on.
 *
 * A page over Discord's limit is rejected whole, so the failure this
 * guards against is not a cosmetic overflow but a listing that never
 * arrives. The three properties that matter: no page exceeds the limit,
 * no line is split across pages, and no page breaks early.
 */
import { describe, expect, it } from 'vitest';

import { MAX_PAGE_LENGTH, paginateLines } from '../../../../src/infra/discord/paginate';

const lines = (count: number, length: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `${String(index)}`.padEnd(length, 'x'));

describe('paginateLines', () => {
  it('returns no pages for no lines, leaving the copy to the caller', () => {
    expect(paginateLines([])).toEqual([]);
  });

  it('keeps a short listing in one page', () => {
    expect(paginateLines(['a', 'b', 'c'])).toEqual(['a\nb\nc']);
  });

  it('splits into pages inside the limit without losing or cutting a line', () => {
    const input = lines(60, 100);

    const pages = paginateLines(input);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_PAGE_LENGTH);
    expect(pages.join('\n').split('\n')).toEqual([...input]);
  });

  it('fills each page before starting the next', () => {
    // Without this, a page-per-line implementation would satisfy every
    // other assertion here.
    const input = lines(60, 100);

    const pages = paginateLines(input);

    for (const page of pages.slice(0, -1)) {
      expect(page.length).toBeGreaterThan(MAX_PAGE_LENGTH - 101);
    }
  });

  it('packs a page up to the limit exactly, and breaks one character past it', () => {
    // The off-by-one that matters: a page of exactly the limit is legal,
    // one character more is rejected by Discord outright.
    const first = 'a'.repeat(1000);
    // Together with the joining newline these fill the page exactly.
    const second = 'b'.repeat(MAX_PAGE_LENGTH - first.length - 1);

    expect(paginateLines([first, second])).toHaveLength(1);
    expect(paginateLines([first, `${second}b`])).toHaveLength(2);
  });

  it('truncates a single over-long line instead of losing the page to it', () => {
    const [page] = paginateLines(['x'.repeat(MAX_PAGE_LENGTH + 500)]);

    expect(page).toHaveLength(MAX_PAGE_LENGTH);
  });
});
