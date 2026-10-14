/**
 * The filter vocabulary `/feed list` and `/feed subscribe` share.
 *
 * Two rules carry the whole point of the module and are easy to lose:
 * the media filter is labelled even when it is the default — an
 * unlabelled line is indistinguishable from one whose label the reader
 * does not recognise — and the keyword appears only when there is one,
 * so a member re-subscribing can see at a glance that their keyword is
 * gone. The separator is pinned too, because both surfaces join with it
 * and a divergence would be invisible to every other gate.
 */
import { describe, expect, it } from 'vitest';

import { describeFeedFilter, formatFeedFilter } from '../../../src/handlers/feed-filter-labels';

/** Echoes the key, so an assertion names the catalog entry it expects. */
const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`;

describe('describeFeedFilter', () => {
  it('labels the default media filter like any other', () => {
    expect(describeFeedFilter({ media: 'media_only' }, t)).toEqual([
      'replies:feed.filter_media.media_only',
    ]);
  });

  it('labels a non-default media filter', () => {
    expect(describeFeedFilter({ media: 'photo_only' }, t)).toEqual([
      'replies:feed.filter_media.photo_only',
    ]);
  });

  it('adds the keyword label, carrying the keyword itself', () => {
    expect(describeFeedFilter({ media: 'any', keyword: 'live' }, t)).toEqual([
      'replies:feed.filter_media.any',
      'replies:feed.filter_keyword:{"keyword":"live"}',
    ]);
  });

  it('defuses a backtick in the keyword, which is whatever a member typed', () => {
    // The translator interpolates without escaping and `/feed list`
    // draws a code span on the same line, so an unescaped backtick would
    // rewrite the rest of the page.
    expect(describeFeedFilter({ media: 'any', keyword: '`live`' }, t)).toEqual([
      'replies:feed.filter_media.any',
      'replies:feed.filter_keyword:{"keyword":" live "}',
    ]);
  });

  it('omits the keyword label for a stored empty-string keyword', () => {
    // The repository's `normalize` only collapses null to undefined, so
    // `''` reaches the labels intact and must read as "no keyword".
    expect(describeFeedFilter({ media: 'media_only', keyword: '' }, t)).toEqual([
      'replies:feed.filter_media.media_only',
    ]);
  });
});

describe('formatFeedFilter', () => {
  it('joins the labels with the separator both feed surfaces use', () => {
    // The separator is spelled out rather than read from the module, so
    // changing it has to be a deliberate edit to the copy both `/feed list`
    // and `/feed subscribe` show.
    expect(formatFeedFilter({ media: 'video_only', keyword: 'live' }, t)).toBe(
      'replies:feed.filter_media.video_only · replies:feed.filter_keyword:{"keyword":"live"}',
    );
  });

  it('renders a keyword-less filter as the media label alone, with no dangling separator', () => {
    expect(formatFeedFilter({ media: 'media_only' }, t)).toBe(
      'replies:feed.filter_media.media_only',
    );
  });
});
