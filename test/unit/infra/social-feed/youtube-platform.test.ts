import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedHttp } from '../../../../src/infra/http';
import { YouTubePlatform } from '../../../../src/infra/social-feed/platforms/youtube-platform';
import { parseYouTubeAtom } from '../../../../src/infra/social-feed/platforms/youtube-atom';
import { resolveYouTubeChannelMetadata } from '../../../../src/infra/social-feed/platforms/youtube-target';
import { parseYouTubeXml } from '../../../../src/infra/social-feed/platforms/youtube-xml';

const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const OTHER = 'UCBR8-60-B28hp2BmDPdntcQ';
const VIDEO = 'Ab_cD-12345';
const entry = (id = VIDEO): string => `<entry>
  <id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><yt:channelId>${CHANNEL}</yt:channelId>
  <title>Launch &amp; learn &#x1F680;</title>
  <author><name>Test &amp; Team</name><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>
  <published>2026-10-15T19:05:24+00:00</published><updated>2026-10-16T01:00:00Z</updated>
  <media:group><media:description>First line\nSecond &lt;line&gt;</media:description>
  <media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg"/></media:group>
</entry>`;
const feed = (entries = entry()): string => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"
 xmlns:media="http://search.yahoo.com/mrss/">
 <id>yt:channel:${CHANNEL}</id><yt:channelId>${CHANNEL}</yt:channelId><title>Test channel</title>
 ${entries}</feed>`;
const metadata = (channel = CHANNEL): string => `<html><head>
  <link rel="canonical" href="https://www.youtube.com/channel/${channel}">
  <meta itemprop="channelId" content="${channel}">
</head><body></body></html>`;
const platform = new YouTubePlatform({ timeoutMs: 500 });

afterEach(() => vi.restoreAllMocks());

describe('YouTube source normalization', () => {
  it.each([
    CHANNEL,
    ` https://www.youtube.com/channel/${CHANNEL} `,
    `https://youtube.com/channel/${CHANNEL}/`,
  ])('keeps case-sensitive channel identity without requesting %s', async (raw) => {
    const get = vi.spyOn(boundedHttp, 'get');
    expect(await platform.normalizeAccount(raw)).toEqual({ ok: true, value: CHANNEL });
    expect(get).not.toHaveBeenCalled();
    expect((await platform.normalizeAccount(CHANNEL.toLowerCase())).ok).toBe(false);
  });

  it.each([
    '@Test.Handle',
    'https://www.youtube.com/@TEST.handle',
    'https://youtube.com/@test.handle/',
  ])('resolves %s through fixed official metadata', async (raw) => {
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: metadata() });
    expect(await platform.normalizeAccount(raw)).toEqual({ ok: true, value: CHANNEL });
    expect(get).toHaveBeenCalledWith(
      'https://www.youtube.com/@test.handle',
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  it('supports percent-encoded international handles without changing channel-ID case', async () => {
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: metadata() });
    expect(await platform.normalizeAccount('https://www.youtube.com/@%E6%B8%AC%E8%A9%A6')).toEqual({
      ok: true,
      value: CHANNEL,
    });
    expect(get.mock.calls[0]?.[0]).toBe('https://www.youtube.com/@%E6%B8%AC%E8%A9%A6');
  });

  it.each([
    '',
    'youtube',
    '@',
    '@../channel',
    '@bad handle',
    '@-bad',
    '@bad.',
    '@bad%2Fname',
    `uc${CHANNEL.slice(2)}`,
    `https://www.youtube.com:443/channel/${CHANNEL}`,
    `http://www.youtube.com/channel/${CHANNEL}`,
    `https://www.youtube.com.evil.invalid/channel/${CHANNEL}`,
    `https://user@www.youtube.com/channel/${CHANNEL}`,
    'https://youtu.be/Ab_cD-12345',
    'https://www.youtube.com/@name?redirect=https://evil.invalid',
    'https://www.youtube.com/@name#fragment',
    'https://www.youtube.com/@name/videos',
    'https://www.youtube.com/../@name',
    'https://www.youtube.com/\\@name',
    'https://www.youtube.com/@bad%2Fname',
    'https://www.youtube.com/@bad%0Aname',
    'https://www.youtube.com/@bad%ZZ',
    'https://www.youtube.com/c/legacy',
    'https://www.youtube.com/user/legacy',
  ])('rejects unsafe or unsupported targets without HTTP: %s', async (raw) => {
    const get = vi.spyOn(boundedHttp, 'get');
    expect(await platform.normalizeAccount(raw)).toMatchObject({
      ok: false,
      error: { code: 'FEED_INVALID_ACCOUNT', messageKey: 'errors:feed.invalid_youtube_target' },
    });
    expect(await platform.fetchTimeline(raw)).toMatchObject({
      ok: false,
      error: { code: 'FEED_INVALID_ACCOUNT' },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    '<html><head><script>"<meta itemprop="channelId" content="' +
      CHANNEL +
      '">"</script></head></html>',
    `<html><head><!-- <meta itemprop="channelId" content="${CHANNEL}"> --></head></html>`,
    metadata().replace(`content="${CHANNEL}"`, `content="${OTHER}"`),
    metadata().replace('https://www.youtube.com/channel/', 'https://evil.invalid/channel/'),
    '<html><head></head><body>Consent required</body></html>',
    '<html>challenge</html>',
    `<html><head><!-- <meta itemprop="channelId" content="${CHANNEL}"></head></html>`,
    `<html><head><script><meta itemprop="channelId" content="${CHANNEL}"></head></html>`,
  ])('refuses missing or conflicting official metadata', async (body) => {
    vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: body });
    expect(await platform.normalizeAccount('@example')).toMatchObject({
      ok: false,
      error: { code: 'FEED_INVALID_RESPONSE' },
    });
  });

  it('accepts channelId metadata when the canonical URL uses a handle', () => {
    expect(
      resolveYouTubeChannelMetadata(metadata().replace(`/channel/${CHANNEL}`, '/@example')),
    ).toBe(CHANNEL);
  });

  it('reads official canonical metadata after the head while ignoring IDs embedded in scripts', () => {
    expect(
      resolveYouTubeChannelMetadata(
        `<html><head><script>const fake = '<link rel="canonical" href="https://www.youtube.com/channel/${OTHER}">';</script></head><body><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}"></body></html>`,
      ),
    ).toBe(CHANNEL);
  });
});

describe('YouTube Atom snapshots', () => {
  it('accepts the public feed channel suffix and numbered thumbnail host while retaining full entry identity', () => {
    const input = feed()
      .replace(`<id>yt:channel:${CHANNEL}</id>`, `<id>yt:channel:${CHANNEL.slice(2)}</id>`)
      .replace(
        `<yt:channelId>${CHANNEL}</yt:channelId>`,
        `<yt:channelId>${CHANNEL.slice(2)}</yt:channelId>`,
      )
      .replace('https://i.ytimg.com/', 'https://i1.ytimg.com/');
    const [post] = parseYouTubeAtom(input, CHANNEL);
    expect(post?.authorAccount).toBe(CHANNEL);
    expect(post?.youtube.thumbnailUrl).toBe(`https://i1.ytimg.com/vi/${VIDEO}/hqdefault.jpg`);
  });

  it('parses native identity, publication, author, description, thumbnail and video media', () => {
    const posts = parseYouTubeAtom(feed(), CHANNEL);
    expect(posts).toEqual([
      {
        id: VIDEO,
        authorAccount: CHANNEL,
        authorName: 'Test & Team',
        createdTimestamp: Date.parse('2026-10-15T19:05:24Z') / 1000,
        url: `https://www.youtube.com/watch?v=${VIDEO}`,
        text: 'Launch & learn \u{1F680}\n\nFirst line\nSecond <line>',
        isReply: false,
        isRepost: false,
        media: [{ kind: 'video', url: `https://www.youtube.com/watch?v=${VIDEO}` }],
        youtube: {
          title: 'Launch & learn \u{1F680}',
          description: 'First line\nSecond <line>',
          authorName: 'Test & Team',
          thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`,
        },
      },
    ]);
  });

  it('uses namespace URIs rather than fixed prefixes and permits CDATA descriptions', () => {
    const input = feed()
      .replaceAll('yt:', 'video:')
      .replace('xmlns:yt=', 'xmlns:video=')
      .replaceAll('media:', 'm:')
      .replace('xmlns:media=', 'xmlns:m=')
      .replace(
        '<m:description>First line\nSecond &lt;line&gt;</m:description>',
        '<m:description><![CDATA[Literal <tags> & text]]></m:description>',
      )
      .replaceAll('video:video:', 'yt:video:')
      .replaceAll('video:channel:', 'yt:channel:');
    expect(parseYouTubeAtom(input, CHANNEL)[0]?.text).toContain('Literal <tags> & text');
  });

  it('retains publication and native IDs when updated, title or description changes', () => {
    const before = parseYouTubeAtom(feed(), CHANNEL)[0]!;
    const after = parseYouTubeAtom(
      feed()
        .replace('2026-10-16T01:00:00Z', '2027-01-01T00:00:00Z')
        .replace('Launch &amp; learn', 'Edited title')
        .replace('First line', 'Edited description'),
      CHANNEL,
    )[0]!;
    expect(after.id).toBe(before.id);
    expect(after.createdTimestamp).toBe(before.createdTimestamp);
    expect(after.text).not.toBe(before.text);
  });

  it('accepts a verified empty feed and entries without optional media metadata', () => {
    expect(parseYouTubeAtom(feed(''), CHANNEL)).toEqual([]);
    const minimal = entry().replace(/<media:group>[\s\S]*?<\/media:group>/, '');
    expect(parseYouTubeAtom(feed(minimal), CHANNEL)[0]?.youtube).toEqual({
      title: 'Launch & learn \u{1F680}',
      description: '',
      authorName: 'Test & Team',
    });
  });

  it.each([
    ['HTML response', '<html><body>Unavailable</body></html>'],
    ['wrong root namespace', feed().replace('http://www.w3.org/2005/Atom', 'urn:fake')],
    [
      'wrong video namespace',
      feed().replace('http://www.youtube.com/xml/schemas/2015', 'urn:fake'),
    ],
    ['wrong entry namespace', feed().replace('<entry>', '<entry xmlns="urn:fake">')],
    ['unbound prefix', feed().replace('yt:videoId', 'unknown:videoId')],
    [
      'empty namespace prefix',
      feed().replace('<entry>', '<:entry>').replace('</entry>', '</:entry>'),
    ],
    ['invalid namespace declaration', feed().replace('<entry>', '<entry xmlns:a:b="urn:invalid">')],
    ['reserved namespace rebinding', feed().replace('<entry>', '<entry xmlns:xml="urn:invalid">')],
    [
      'forbidden xmlns URI',
      feed().replace('<entry>', '<entry xmlns:a="http://www.w3.org/2000/xmlns/">'),
    ],
    ['empty bound namespace', feed().replace('<entry>', '<entry xmlns:a="">')],
    [
      'wrong channel',
      feed().replace(
        `<yt:channelId>${CHANNEL}</yt:channelId>`,
        `<yt:channelId>${OTHER}</yt:channelId>`,
      ),
    ],
    ['missing feed identity', feed().replace(`<id>yt:channel:${CHANNEL}</id>`, '')],
    ['duplicate video', feed(entry() + entry())],
    ['missing video', feed().replace(`<yt:videoId>${VIDEO}</yt:videoId>`, '')],
    ['mismatched native ID', feed().replace(`yt:video:${VIDEO}`, 'yt:video:zyx98765432')],
    [
      'mismatched entry channel',
      feed().replace(
        `<yt:channelId>${CHANNEL}</yt:channelId>\n  <title>`,
        `<yt:channelId>${OTHER}</yt:channelId>\n  <title>`,
      ),
    ],
    ['bad native ID', feed().replaceAll(VIDEO, '../unsafe!!')],
    ['duplicate title', feed().replace('</entry>', '<title>Duplicate</title></entry>')],
    ['missing publication', feed().replace(/<published>.*?<\/published>/, '')],
    ['invalid calendar day', feed().replace('2026-10-15T19:05:24+00:00', '2026-02-30T19:05:24Z')],
    ['missing timezone', feed().replace('2026-10-15T19:05:24+00:00', '2026-10-15T19:05:24')],
    ['bad timezone', feed().replace('+00:00', '+25:00')],
    [
      'bad author',
      feed().replace(`https://www.youtube.com/channel/${CHANNEL}`, 'https://evil.invalid/'),
    ],
    ['bad thumbnail', feed().replace('https://i.ytimg.com/', 'http://127.0.0.1/')],
    ['thumbnail credentials', feed().replace('https://i.ytimg.com/', 'https://user@i.ytimg.com/')],
    ['truncated entry', feed().replace('</entry>', '')],
    ['extra root', feed() + '<extra/>'],
    ['trailing text', feed() + 'garbage'],
    [
      'DTD and external entity',
      '<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + feed(),
    ],
    ['internal entity', '<!DOCTYPE feed [<!ENTITY unsafe "unsafe">]>' + feed()],
    [
      'standalone entity declaration',
      feed().replace('<entry>', '<!ENTITY unsafe "unsafe"><entry>'),
    ],
    [
      'external DTD',
      feed().replace('<feed ', '<!DOCTYPE feed SYSTEM "https://evil.invalid/evil.dtd"><feed '),
    ],
    ['entity in attribute', feed().replace('<entry>', '<entry type="&unknown;">')],
    ['literal angle bracket in attribute', feed().replace('<entry>', '<entry type="<invalid>">')],
    ['unknown entity', feed().replace('Launch &amp;', 'Launch &unknown;')],
    ['bare ampersand', feed().replace('Launch &amp;', 'Launch &')],
    ['invalid numeric entity', feed().replace('&#x1F680;', '&#xD800;')],
    ['XML control character', feed().replace('Launch', 'Launch\u0001')],
    [
      'duplicate attribute',
      feed().replace('url="https://i.ytimg.com', 'url="duplicate" url="https://i.ytimg.com'),
    ],
    [
      'duplicate expanded attribute',
      feed().replace('<entry>', '<entry xmlns:a="urn:test" xmlns:b="urn:test" a:id="1" b:id="2">'),
    ],
    ['nested text markup', feed().replace('Launch &amp; learn', '<b>Launch</b>')],
    ['malformed comment', feed().replace('<entry>', '<!-- invalid -- comment --><entry>')],
    ['comment ending in hyphen', feed().replace('<entry>', '<!-- invalid ---> <entry>')],
    ['entity outside root', '&#x20;' + feed()],
    ['malformed attribute', feed().replace('<entry>', '<entry invalid>')],
    ['unterminated trailing comment', feed() + '<!-- unfinished'],
    ['unterminated CDATA', feed().replace('First line', '<![CDATA[unfinished')],
    ['processing instruction', feed().replace('<entry>', '<?instruction unsafe?><entry>')],
    ['unsupported XML version', feed().replace('version="1.0"', 'version="1.1"')],
    ['invalid text terminator', feed().replace('First line', 'Invalid ]]> text')],
  ])('rejects %s instead of silently baselining past it', (_label, input) => {
    expect(() => parseYouTubeAtom(input, CHANNEL)).toThrow();
  });

  it('limits XML body size, depth and node count before exposing an incomplete snapshot', () => {
    expect(() => parseYouTubeXml('<root>' + 'x'.repeat(1024 * 1024) + '</root>')).toThrow(
      'XML body too large',
    );
    expect(() =>
      parseYouTubeXml('<root>' + '<deep>'.repeat(40) + '</deep>'.repeat(40) + '</root>'),
    ).toThrow();
    expect(() => parseYouTubeXml('<root>' + '<node/>'.repeat(10_001) + '</root>')).toThrow(
      'XML complexity limit exceeded',
    );
  });

  it('keeps CDATA literal while decoding XML references once and preserving harmless comments', () => {
    const parsed = parseYouTubeAtom(
      feed().replace(
        '<media:description>First line\nSecond &lt;line&gt;</media:description>',
        '<media:description>&amp;lt; &#65; <!-- comment --><![CDATA[&unknown; <literal>]]></media:description>',
      ),
      CHANNEL,
    );
    expect(parsed[0]?.youtube.description).toBe('&lt; A &unknown; <literal>');
  });
});

describe('YouTube bounded HTTP and failure semantics', () => {
  it('requests only the fixed official feed and retains the complete snapshot regardless of cursor hints', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValue({ data: feed(entry() + entry('zyx98765432')) });
    const result = await platform.fetchTimeline(CHANNEL, {
      afterId: VIDEO,
      sinceTimestamp: 9e12,
      limit: 1,
    });
    expect(result.ok && result.value.map((post) => post.id)).toEqual([VIDEO, 'zyx98765432']);
    expect(get).toHaveBeenCalledWith(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: 500,
        responseType: 'text',
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      }),
    );
    expect(platform.trackingMode).toBe('snapshot');
    expect(platform.subscriptionScope).toBe('source');
    expect(platform.defaultMediaFilter).toBe('any');
    expect(platform.displayName).toBe('YouTube');
    expect(platform.toEmbedUrl(parseYouTubeAtom(feed(), CHANNEL)[0]!)).toBe(
      `https://www.youtube.com/watch?v=${VIDEO}`,
    );
  });

  it('shares one absolute deadline across handle resolution and the feed request', async () => {
    const get = vi
      .spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: metadata() })
      .mockResolvedValueOnce({ data: feed() });
    expect((await platform.fetchTimeline('@example')).ok).toBe(true);
    expect(get.mock.calls[0]?.[1]?.signal).toBe(get.mock.calls[1]?.[1]?.signal);
    expect(get.mock.calls[0]?.[1]?.maxContentLength).toBe(4 * 1024 * 1024);
  });

  it('does not discard malformed entries even when limit and timestamp hints would omit them', async () => {
    vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: feed(entry() + entry('bad')) });
    expect(await platform.fetchTimeline(CHANNEL, { limit: 1, sinceTimestamp: 9e12 })).toMatchObject(
      { ok: false, error: { code: 'FEED_INVALID_RESPONSE' } },
    );
  });

  it('rejects oversized official metadata and preserves parse error taxonomy during handle reads', async () => {
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: 'x'.repeat(4 * 1024 * 1024 + 1) })
      .mockResolvedValueOnce({ data: '<html><head></head></html>' });
    expect(await platform.normalizeAccount('@example')).toMatchObject({
      ok: false,
      error: { code: 'FEED_INVALID_RESPONSE' },
    });
    expect(await platform.fetchTimeline('@example')).toMatchObject({
      ok: false,
      error: { code: 'FEED_INVALID_RESPONSE' },
    });
  });

  it('distinguishes an existing empty channel from a nonexistent channel', async () => {
    vi.spyOn(boundedHttp, 'get')
      .mockResolvedValueOnce({ data: feed('') })
      .mockRejectedValueOnce({ response: { status: 404 } });
    expect(await platform.fetchTimeline(CHANNEL)).toEqual({ ok: true, value: [] });
    expect(await platform.fetchTimeline(OTHER)).toMatchObject({
      ok: false,
      error: { code: 'FEED_NOT_FOUND' },
    });
  });

  it.each([
    [{ response: { status: 429 } }, 'FEED_RATE_LIMITED'],
    [{ response: { status: 503 } }, 'FEED_UPSTREAM_5XX'],
    [
      { response: { status: 302, headers: { location: 'http://127.0.0.1/' } } },
      'FEED_FETCH_FAILED',
    ],
    [{ code: 'ERR_CANCELED' }, 'FEED_TIMEOUT'],
    [{ code: 'ECONNABORTED' }, 'FEED_TIMEOUT'],
    [{ code: 'ETIMEDOUT' }, 'FEED_TIMEOUT'],
    [{ code: 'ENOTFOUND' }, 'FEED_FETCH_FAILED'],
    [{ code: 'ERR_BAD_RESPONSE', message: 'maxContentLength exceeded' }, 'FEED_FETCH_FAILED'],
  ])('translates bounded request failures for both entry points', async (cause, code) => {
    const get = vi.spyOn(boundedHttp, 'get').mockRejectedValue(cause);
    expect(await platform.fetchTimeline(CHANNEL)).toMatchObject({
      ok: false,
      error: { code, cause },
    });
    expect(await platform.normalizeAccount('@example')).toMatchObject({
      ok: false,
      error: { code, cause },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([{}, '<html>challenge</html>', 'x'.repeat(1024 * 1024 + 1)])(
    'rejects invalid or oversized bodies',
    async (body) => {
      vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: body });
      expect(await platform.fetchTimeline(CHANNEL)).toMatchObject({
        ok: false,
        error: { code: 'FEED_INVALID_RESPONSE' },
      });
      expect(await platform.normalizeAccount('@example')).toMatchObject({
        ok: false,
        error: { code: 'FEED_INVALID_RESPONSE' },
      });
    },
  );

  it('aborts a stalled complete request using the absolute signal', async () => {
    vi.spyOn(boundedHttp, 'get').mockImplementation(
      (_url, config) =>
        new Promise((_resolve, reject) => {
          config!.signal!.addEventListener!('abort', () => reject({ code: 'ERR_CANCELED' }), {
            once: true,
          });
        }),
    );
    expect(await new YouTubePlatform({ timeoutMs: 10 }).fetchTimeline(CHANNEL)).toMatchObject({
      ok: false,
      error: { code: 'FEED_TIMEOUT' },
    });
  });

  it.each([0, -1, 60_001, 1.5, NaN, Infinity])(
    'rejects invalid timeout configuration %s',
    (timeoutMs) => {
      expect(() => new YouTubePlatform({ timeoutMs })).toThrow(TypeError);
    },
  );
});
