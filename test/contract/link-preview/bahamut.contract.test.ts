/**
 * Contract test for the Bahamut OpenGraph path.
 *
 * Pins the HTTP boundary with nock (real axios, no SDK doubles) so a
 * page-shape or status-code change surfaces here. The four rewrite
 * providers are pure string transforms with no network, so they need
 * only unit tests — this contract covers the one fetching provider.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { OgClient, createBahamutProvider } from '../../../src/infra/link-preview';
import { isErr, isOk } from '../../../src/core/result';

const ORIGIN = 'https://forum.gamer.com.tw';
const PATH = '/C.php';
const QUERY = { bsn: '60076', snA: '123' };
const fullUrl = (): URL => new URL(`${ORIGIN}${PATH}?bsn=${QUERY.bsn}&snA=${QUERY.snA}`);

const ogHtml = (head: string): string =>
  `<!doctype html><html><head>${head}</head><body>post</body></html>`;

const build = async () => {
  const provider = createBahamutProvider(new OgClient());
  return provider.build(fullUrl(), { timeoutMs: 4000 });
};

describe('Bahamut OpenGraph contract', () => {
  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });
  afterEach(() => {
    // Every test must consume the stub it registered — a leftover means
    // the HTTP call never happened and the assertion was vacuous.
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => {
    nock.enableNetConnect();
    nock.restore();
  });

  it('maps a well-formed OpenGraph page into a card', async () => {
    nock(ORIGIN)
      .get(PATH)
      .query(true)
      .reply(
        200,
        ogHtml(
          [
            '<meta property="og:title" content="Bahamut Post">',
            '<meta property="og:description" content="A forum post">',
            '<meta property="og:image" content="https://p2.bahamut.com.tw/og.jpg">',
            '<meta property="og:site_name" content="bahamut">',
          ].join(''),
        ),
      );

    const result = await build();
    expect(isOk(result)).toBe(true);
    if (isOk(result) && result.value?.kind === 'card') {
      expect(result.value.card.title).toBe('Bahamut Post');
      expect(result.value.card.imageUrl).toBe('https://p2.bahamut.com.tw/og.jpg');
    } else {
      throw new Error('expected a card result');
    }
  });

  it('returns Ok(null) for a page without an og:image', async () => {
    nock(ORIGIN)
      .get(PATH)
      .query(true)
      .reply(200, ogHtml('<meta property="og:title" content="No image">'));

    const result = await build();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('skips (Ok(null)) when an og:image exists but the title is missing', async () => {
    nock(ORIGIN)
      .get(PATH)
      .query(true)
      .reply(200, ogHtml('<meta property="og:image" content="https://p2.bahamut.com.tw/og.jpg">'));

    const result = await build();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('skips (Ok(null)) the age-gate interstitial served for an 18+ board', async () => {
    nock(ORIGIN)
      .get(PATH)
      .query(true)
      .reply(
        200,
        ogHtml(
          '<meta property="og:description" content="Age verification required.">' +
            '<meta property="og:image" content="https://i2.bahamut.com.tw/child-protection.png">',
        ),
      );

    const result = await build();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('does NOT follow a redirect (maxRedirects: 0 is the SSRF guard)', async () => {
    // A 3xx to an internal address must surface as an error, never be chased.
    nock(ORIGIN)
      .get(PATH)
      .query(true)
      .reply(302, '', { Location: 'http://169.254.169.254/latest/meta-data/' });

    const result = await build();
    expect(isErr(result)).toBe(true);
  });

  it('maps HTTP 429 to LINK_PREVIEW_RATE_LIMITED', async () => {
    nock(ORIGIN).get(PATH).query(true).reply(429, 'rate limited');
    const result = await build();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_RATE_LIMITED');
  });

  it('maps HTTP 500 to LINK_PREVIEW_UPSTREAM_5XX', async () => {
    nock(ORIGIN).get(PATH).query(true).reply(500, 'server error');
    const result = await build();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('LINK_PREVIEW_UPSTREAM_5XX');
  });
});
