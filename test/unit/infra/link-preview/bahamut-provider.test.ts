/**
 * Unit tests for the Bahamut OpenGraph provider. The {@link OgClient} is
 * faked so the provider's mapping + skip/error logic is exercised without
 * a network: image + title -> card, no image -> Ok(null), image but no
 * title -> Ok(null), age gate -> Ok(null), fetch error -> propagated Err.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createBahamutProvider,
  type OgClient,
  type OpenGraphMeta,
} from '../../../../src/infra/link-preview';
import { ok, err, isOk, isErr } from '../../../../src/core/result';
import { invalidResponseError } from '../../../../src/infra/link-preview';

const u = (href: string): URL => new URL(href);

const makeOgClient = (meta: Partial<OpenGraphMeta> = {}): OgClient =>
  ({ fetch: vi.fn(async () => ok({ images: [], ...meta })) }) as unknown as OgClient;

describe('bahamut provider canHandle', () => {
  const provider = createBahamutProvider(makeOgClient({}));

  it('matches gamer.com.tw and its subdomains', () => {
    expect(provider.canHandle(u('https://gamer.com.tw/x'))).toBe(true);
    expect(provider.canHandle(u('https://forum.gamer.com.tw/C.php?bsn=1&snA=2'))).toBe(true);
    expect(provider.canHandle(u('https://home.gamer.com.tw/artwork.php?sn=1'))).toBe(true);
  });

  it('rejects look-alike and unrelated hosts', () => {
    expect(provider.canHandle(u('https://gamer.com/x'))).toBe(false);
    expect(provider.canHandle(u('https://notgamer.com.tw/x'))).toBe(false);
    expect(provider.canHandle(u('https://gamer.com.tw.attacker.com/x'))).toBe(false);
  });

  it('rejects the account host (login / profile pages)', () => {
    expect(provider.canHandle(u('https://user.gamer.com.tw/login.php'))).toBe(false);
  });
});

describe('bahamut provider build', () => {
  const url = u('https://forum.gamer.com.tw/C.php?bsn=1&snA=2');

  it('builds a card from OpenGraph metadata', async () => {
    const provider = createBahamutProvider(
      makeOgClient({
        title: 'Post title',
        description: 'desc',
        images: ['https://cdn.gamer/og.jpg'],
        url: 'https://forum.gamer.com.tw/C.php?bsn=1&snA=2',
        siteName: '巴哈姆特',
      }),
    );
    const result = await provider.build(url, { timeoutMs: 1000 });

    expect(isOk(result)).toBe(true);
    if (isOk(result) && result.value?.kind === 'card') {
      expect(result.value.card.title).toBe('Post title');
      expect(result.value.card.imageUrl).toBe('https://cdn.gamer/og.jpg');
      expect(result.value.card.siteName).toBe('巴哈姆特');
      expect(result.value.sourceUrl).toBe(url.href);
    } else {
      throw new Error('expected a card result');
    }
  });

  it('defaults the site label when og:site_name is absent', async () => {
    const provider = createBahamutProvider(
      makeOgClient({ title: 't', images: ['https://cdn/og.jpg'] }),
    );
    const result = await provider.build(url, { timeoutMs: 1000 });
    if (isOk(result) && result.value?.kind === 'card') {
      expect(result.value.card.siteName).toBe('Bahamut');
    } else {
      throw new Error('expected a card result');
    }
  });

  it('returns Ok(null) when there is no image to improve on', async () => {
    const provider = createBahamutProvider(makeOgClient({ title: 'only title' }));
    const result = await provider.build(url, { timeoutMs: 1000 });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('returns Ok(null) when an image exists but the title is missing', async () => {
    const provider = createBahamutProvider(makeOgClient({ images: ['https://cdn/og.jpg'] }));
    const result = await provider.build(url, { timeoutMs: 1000 });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('returns Ok(null) for the age-gate interstitial, even when it carries a title', async () => {
    const provider = createBahamutProvider(
      makeOgClient({
        title: 'Age check',
        description: 'Verify your age to continue.',
        images: ['https://i2.bahamut.com.tw/child-protection.png'],
      }),
    );
    const result = await provider.build(url, { timeoutMs: 1000 });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  it('propagates a fetch error from the OgClient', async () => {
    const failing = {
      fetch: vi.fn(async () => err(invalidResponseError('bahamut'))),
    } as unknown as OgClient;
    const provider = createBahamutProvider(failing);
    const result = await provider.build(url, { timeoutMs: 1000 });
    expect(isErr(result)).toBe(true);
  });
});
