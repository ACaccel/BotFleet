import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedHttp } from '../../../../src/infra/http';
import { BahamutPlatform, normalizeBahamutTargetOffline } from '../../../../src/infra/social-feed';
import {
  parseBahamutBoardPage,
  parseBahamutPage,
} from '../../../../src/infra/social-feed/platforms/bahamut-html';
import { selectPostsToForward } from '../../../../src/plugins/social-feed/internal';
import {
  BAHAMUT_CREATED_AT as TIME,
  bahamutBoard as board,
  bahamutFloor as floor,
  bahamutPager as pager,
  bahamutTopic as topic,
} from '../../../fixtures/social-feed/bahamut';

const platform = new BahamutPlatform({
  baseUrl: 'https://forum.gamer.com.tw',
  timeoutMs: 8000,
  maxPages: 2,
});
const cursor = (id: string): string => `${TIME}:${id}`;

afterEach(() => vi.restoreAllMocks());

describe('Bahamut source target resolution', () => {
  it.each([
    ['36476/3047', '36476/3047'],
    ['thread:36476:3047', '36476/3047'],
    ['https://forum.gamer.com.tw/C.php?snA=3047&bsn=36476&page=7#post_12', '36476/3047'],
    ['https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047', '36476/3047'],
    ['36476', 'board:36476'],
    ['board:36476', 'board:36476'],
    ['board:36476:3', 'board:36476:3'],
    ['https://forum.gamer.com.tw/B.php?bsn=36476', 'board:36476'],
    ['https://m.gamer.com.tw/forum/B.php?bsn=36476&subbsn=3', 'board:36476:3'],
    ['https://forum.gamer.com.tw/B.php?bsn=36476&subbsn=0', 'board:36476'],
  ])('canonicalizes %s without network', async (raw, expected) => {
    const get = vi.spyOn(boundedHttp, 'get');
    expect(await platform.normalizeAccount(raw)).toEqual({ ok: true, value: expected });
    expect(normalizeBahamutTargetOffline(raw)).toEqual({ ok: true, value: expected });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    '36476/0',
    '0/3047',
    'https://evil.invalid/C.php?bsn=36476&snA=3047',
    'https://forum.gamer.com.tw.evil.invalid/C.php?bsn=36476&snA=3047',
    'https://user:password@forum.gamer.com.tw/B.php?bsn=36476',
    'https://forum.gamer.com.tw/B.php?bsn=1&bsn=2',
    'https://forum.gamer.com.tw/B.php?bsn=1&subbsn=-1',
    'https://m.gamer.com.tw/C.php?bsn=1&snA=2',
    'https://forum.gamer.com.tw/search.php?bsn=1',
    '36476/../3047',
  ])('refuses unsupported targets %s', async (raw) => {
    const result = await platform.normalizeAccount(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.messageKey).toBe('errors:feed.invalid_target');
  });

  it.each([
    'https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15574',
    'https://m.gamer.com.tw/forum/Co.php?bsn=36476&snB=15574',
  ])('resolves a single-floor URL to the same thread key: %s', async (url) => {
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({
      data: '<meta property="al:ios:url" content="bahamut://forumCo?bsn=36476&amp;snA=3047&amp;snB=15574">',
    });
    expect(await platform.normalizeAccount(url)).toEqual({ ok: true, value: '36476/3047' });
    expect(get).toHaveBeenCalledWith(
      'https://forum.gamer.com.tw/Co.php',
      expect.objectContaining({ params: { bsn: '36476', sn: '15574' }, maxRedirects: 0 }),
    );
    expect(normalizeBahamutTargetOffline(url).ok).toBe(false);
  });

  it('rejects an unrelated parent thread response', async () => {
    vi.spyOn(boundedHttp, 'get').mockResolvedValue({
      data: '<meta property="al:ios:url" content="bahamut://forumCo?bsn=99&amp;snA=3047">',
    });
    const result = await platform.normalizeAccount(
      'https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15574',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_INVALID_RESPONSE');
  });
});

describe('Bahamut forum HTML', () => {
  it('retains nested body and quoted content, author, creation time and permalink but excludes inline comments', () => {
    const parsed = parseBahamutPage(
      floor(
        '15574',
        'New<div><br></div><div>Nested &amp; more</div><blockquote>Quoted content</blockquote><img data-src="https://cdn.invalid/photo.jpg">',
        131,
      ) + pager(7),
      '36476/3047',
    );
    expect(parsed.lastPage).toBe(7);
    expect(parsed.posts[0]).toMatchObject({
      id: cursor('15574'),
      authorAccount: 'example',
      text: 'New\nNested & more\nQuoted content',
      floorNumber: 131,
      isReply: true,
      media: [{ kind: 'photo', url: 'https://cdn.invalid/photo.jpg' }],
      url: 'https://forum.gamer.com.tw/Co.php?bsn=36476&sn=15574',
    });
    expect(parsed.posts[0]?.text).not.toContain('inline comment');
  });

  it('distinguishes the opening floor from replies', () => {
    expect(parseBahamutPage(floor('1', 'Opening'), '1/2').posts[0]?.isReply).toBe(false);
  });

  it.each([
    '<html>challenge</html>',
    '<section id="post_1"><article>changed schema</article></section>',
  ])('fails closed on unrecognized thread pages', (html) => {
    expect(() => parseBahamutPage(html, '1/2')).toThrow();
  });

  it('reads p href topic links, keeps local pinned threads, and excludes cross-board topics and ads', () => {
    const parsed = parseBahamutBoardPage(
      board(
        topic('70', { board: '99999', sticky: true }) + topic('10', { sticky: true }) + topic('42'),
      ),
      { kind: 'board', board: '12345' },
    );
    expect(parsed.topics).toEqual([
      { id: '10', title: 'Topic 10', sticky: true },
      { id: '42', title: 'Topic 42', sticky: false },
    ]);
  });

  it('honors subboard membership', () => {
    const parsed = parseBahamutBoardPage(
      board(topic('41', { subboard: '1' }) + topic('42', { subboard: '3' })),
      { kind: 'board', board: '12345', subboard: '3' },
    );
    expect(parsed.topics.map((p) => p.id)).toEqual(['42']);
  });

  it('refuses a board returned in last-reply order', () => {
    expect(() =>
      parseBahamutBoardPage(board(topic('42')).replace('value="2" selected', 'value="2"'), {
        kind: 'board',
        board: '12345',
      }),
    ).toThrow('creation');
  });

  it('accepts a verified empty board but refuses challenge pages', () => {
    expect(parseBahamutBoardPage(board(''), { kind: 'board', board: '12345' }).topics).toEqual([]);
    expect(() => parseBahamutBoardPage('challenge', { kind: 'board', board: '12345' })).toThrow();
  });

  it('passes forum authors and replies through generic media and keyword filtering', () => {
    const posts = parseBahamutPage(floor('1', 'Release notes', 2), '1/2').posts;
    expect(
      selectPostsToForward(posts, {
        platform,
        account: '1/2',
        filter: { media: 'any', keyword: 'release' },
        maxPosts: 5,
      }),
    ).toHaveLength(1);
    expect(
      selectPostsToForward(posts, {
        platform,
        account: '1/2',
        filter: { media: 'photo_only' },
        maxPosts: 5,
      }),
    ).toHaveLength(0);
  });
});

describe('Bahamut cursor-aware reads', () => {
  it('checks off a verified deleted opening floor and then returns the following topic', async () => {
    const listing = board(topic('43') + topic('42') + topic('40'));
    const deleted =
      '<section id="disable_500"><div class="c-disable"><div class="floor" data-floor="1">Deleted</div></div></section>';
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: listing })
      .mockResolvedValueOnce({ data: deleted + floor('501', 'A much later reply', 2) })
      .mockResolvedValueOnce({ data: listing })
      .mockResolvedValueOnce({ data: floor('600', 'Following topic') });
    const first = await platform.fetchTimeline('board:12345', { afterId: cursor('40'), limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value).toMatchObject([
      { id: cursor('42'), isDeleted: true, createdTimestamp: TIME },
    ]);
    expect(
      selectPostsToForward(first.value, {
        platform,
        account: 'board:12345',
        filter: { media: 'any' },
        maxPosts: 5,
      }),
    ).toEqual([]);
    const next = await platform.fetchTimeline('board:12345', {
      afterId: first.value[0]?.id,
      limit: 1,
    });
    expect(next.ok && next.value.map((post) => post.id)).toEqual([cursor('43')]);
  });

  it('can initialize a board whose newest opening floor is explicitly deleted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(TIME * 1000);
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: board(topic('42')) })
      .mockResolvedValueOnce({
        data: '<section id="disable_500"><div class="c-disable"><div class="floor" data-floor="1">Deleted</div></div></section>',
      });
    const result = await platform.fetchTimeline('board:12345');
    expect(result.ok && result.value).toMatchObject([{ id: cursor('42'), isDeleted: true }]);
  });

  it('still refuses a missing opening floor without an explicit deletion marker', async () => {
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: board(topic('42')) })
      .mockResolvedValueOnce({ data: floor('501', 'Only a reply', 2) });
    const result = await platform.fetchTimeline('board:12345', { afterId: cursor('40') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_INVALID_RESPONSE');
  });
  it('initializes a thread from its latest page without replaying older pages', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: floor('1', 'old') + pager(7) })
      .mockResolvedValueOnce({ data: floor('70', 'new', 131) + pager(7) });
    const result = await platform.fetchTimeline('36476/3047');
    expect(result.ok && result.value.map((p) => p.id)).toEqual([cursor('70')]);
    expect(get.mock.calls.map((c) => c[1]?.params)).toEqual([
      { bsn: '36476', snA: '3047', page: 1 },
      { bsn: '36476', snA: '3047', page: 7 },
    ]);
  });

  it('reaches the old thread cursor before returning the oldest bounded new batch', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: floor('1', 'old') + pager(7) })
      .mockResolvedValueOnce({
        data: floor('70', 'new', 131) + floor('69', 'previous', 130) + pager(7),
      })
      .mockResolvedValueOnce({ data: floor('60', 'seen', 120) + pager(7) });
    const result = await platform.fetchTimeline('36476/3047', { afterId: cursor('60'), limit: 1 });
    expect(result.ok && result.value.map((p) => p.id)).toEqual([cursor('69')]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0]?.[1]?.signal).toBe(get.mock.calls[2]?.[1]?.signal);
  });

  it('reports an unread thread gap instead of silently skipping it', async () => {
    const limited = new BahamutPlatform({
      baseUrl: 'https://forum.gamer.com.tw',
      timeoutMs: 8000,
      maxPages: 1,
    });
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: floor('1', 'old') + pager(7) })
      .mockResolvedValueOnce({ data: floor('70', 'new') + pager(7) });
    const result = await limited.fetchTimeline('1/2', { afterId: cursor('30') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.messageKey).toBe('errors:feed.bahamut_lookback_exceeded');
  });

  it('handles deleted first-page floors while discovering the current thread head', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({
        data:
          '<section id="disable_1"><div class="c-disable"><div class="floor" data-floor="1">1</div></div></section>' +
          pager(2),
      })
      .mockResolvedValueOnce({ data: floor('21', 'new', 21) + pager(2) });
    const result = await platform.fetchTimeline('1/2');
    expect(result.ok && result.value).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('seeds a board at the newest topic and reads the actual opening body, not reply metadata', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: board(topic('10', { sticky: true }) + topic('42')) })
      .mockResolvedValueOnce({
        data: floor('500', 'Opening body') + floor('501', 'Later reply', 2),
      });
    const result = await platform.fetchTimeline('board:12345');
    expect(result.ok && result.value).toMatchObject([
      {
        id: cursor('42'),
        authorAccount: 'example',
        text: 'Topic 42\nOpening body',
        url: 'https://forum.gamer.com.tw/C.php?bsn=12345&snA=42',
        isReply: false,
      },
    ]);
    expect(get).toHaveBeenNthCalledWith(
      1,
      'https://forum.gamer.com.tw/B.php',
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: 'ckForumListOrder=post' }),
      }),
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      'https://forum.gamer.com.tw/C.php',
      expect.objectContaining({ params: { bsn: '12345', snA: '42', page: 1 } }),
    );
  });

  it('ignores old pinned topics when deciding whether board pagination has reached the old cursor', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: board(topic('10', { sticky: true }) + topic('45'), 2) })
      .mockResolvedValueOnce({
        data: board(topic('44') + topic('43') + topic('42') + topic('40'), 2),
      })
      .mockResolvedValueOnce({ data: floor('500', 'Body 42') })
      .mockResolvedValueOnce({ data: floor('501', 'Body 43') });
    const result = await platform.fetchTimeline('board:12345', { afterId: cursor('40'), limit: 2 });
    expect(result.ok && result.value.map((p) => p.id)).toEqual([cursor('42'), cursor('43')]);
    expect(get.mock.calls[1]?.[1]?.params).toEqual({ bsn: '12345', page: 2 });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('does not notify when only an old topic was bumped', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValue({ data: board(topic('40') + topic('39')) });
    const result = await platform.fetchTimeline('board:12345', { afterId: cursor('40') });
    expect(result).toEqual({ ok: true, value: [] });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reports a board lookback gap before reading or forwarding partial topics', async () => {
    const limited = new BahamutPlatform({
      baseUrl: 'https://forum.gamer.com.tw',
      timeoutMs: 8000,
      maxPages: 1,
    });
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: board(topic('45'), 2) });
    const result = await limited.fetchTimeline('board:12345', { afterId: cursor('40') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.messageKey).toBe('errors:feed.bahamut_lookback_exceeded');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ response: { status: 429 } }, 'FEED_RATE_LIMITED'],
    [{ code: 'ERR_CANCELED' }, 'FEED_TIMEOUT'],
  ])('translates HTTP failures %j', async (cause, code) => {
    vi.spyOn(boundedHttp, 'get').mockRejectedValue(cause);
    const result = await platform.fetchTimeline('1/2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('surfaces a 200 challenge page as an invalid response', async () => {
    vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: 'challenge' });
    const result = await platform.fetchTimeline('1/2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_INVALID_RESPONSE');
  });

  it('orders timestamps then large source IDs without losing precision', () => {
    expect(platform.compareIds('100:9007199254740993', '100:9007199254740992')).toBe(1);
    expect(platform.compareIds('100:2', '101:1')).toBe(-1);
    expect(platform.compareIds('bad', '100:1')).toBe(0);
    expect(platform.baselineIdAt(100_000)).toBe('100:0');
  });
});
