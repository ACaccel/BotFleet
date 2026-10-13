/**
 * Unit tests for {@link parseSocialLinkPreviewConfig}: an absent or disabled
 * block needs no embed-proxy host lists and still yields fully-defaulted
 * scalars, while enabling the feature makes all six lists mandatory — a
 * missing one must fail with an issue naming its key, so an operator can act
 * on the startup error. Also pins the range caps and the `.strict()`
 * unknown-key rejection.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseSocialLinkPreviewConfig } from '../../../../src/plugins/social-link-preview/config';

/** Every embed-proxy host list the enabled branch demands. */
const PROXY_HOST_KEYS = [
  'twitterProxyHosts',
  'instagramProxyHosts',
  'threadsProxyHosts',
  'facebookProxyHosts',
  'redditProxyHosts',
  'bilibiliProxyHosts',
] as const;

/** A complete, minimal set of host lists — one distinct host per source. */
const proxyHosts = (): Record<(typeof PROXY_HOST_KEYS)[number], string[]> => ({
  twitterProxyHosts: ['vxtwitter.com', 'fxtwitter.com'],
  instagramProxyHosts: ['uuinstagram.com'],
  threadsProxyHosts: ['viewthreads.com'],
  facebookProxyHosts: ['facebed.com'],
  redditProxyHosts: ['vxreddit.com'],
  bilibiliProxyHosts: ['vxbilibili.com'],
});

/** Parse and return the ZodError, failing the test if the input was accepted. */
const parseFailure = (raw: unknown): z.ZodError => {
  try {
    parseSocialLinkPreviewConfig(raw);
  } catch (error) {
    if (error instanceof z.ZodError) return error;
    throw error;
  }
  throw new Error('expected parseSocialLinkPreviewConfig to reject this block');
};

const issuePaths = (error: z.ZodError): string[] =>
  error.issues.map((issue) => issue.path.join('.'));

describe('parseSocialLinkPreviewConfig', () => {
  it('returns the disabled, fully-defaulted config when the block is absent', () => {
    const config = parseSocialLinkPreviewConfig(undefined);
    expect(config.enabled).toBe(false);
    expect(config.originalMessageStrategy).toBe('suppress');
    expect(config.maxUrlsPerMessage).toBe(1);
    expect(config.timeoutMs).toBe(4000);
    expect(config.maxVideoBytes).toBe(8 * 1024 * 1024);
    expect(config.videoTimeoutMs).toBe(15_000);
    expect(config.providers).toBeUndefined();
    expect(config.allowedBotIds).toEqual([]);
    // No host list is invented in code: a disabled feature probes nothing.
    for (const key of PROXY_HOST_KEYS) {
      expect(config[key]).toBeUndefined();
    }
  });

  it.each([false, true])('accepts bot IDs when enabled is %s', (enabled) => {
    const allowedBotIds = ['111111111111111111', '222222222222222222'];
    expect(
      parseSocialLinkPreviewConfig({ enabled, ...proxyHosts(), allowedBotIds }).allowedBotIds,
    ).toEqual(allowedBotIds);
  });

  it.each(['gopher', '', '123', '1'.repeat(21), ' 111111111111111111', 123])(
    'rejects an invalid bot ID: %s',
    (id) => {
      expect(issuePaths(parseFailure({ allowedBotIds: [id] }))).toContain('allowedBotIds.0');
    },
  );

  it.each([null, '111111111111111111', {}])(
    'rejects a non-array bot allow-list: %j',
    (allowedBotIds) => {
      expect(issuePaths(parseFailure({ allowedBotIds }))).toContain('allowedBotIds');
    },
  );

  it('accepts an explicitly disabled block with no host lists at all', () => {
    const config = parseSocialLinkPreviewConfig({ enabled: false, maxUrlsPerMessage: 3 });
    expect(config.enabled).toBe(false);
    expect(config.maxUrlsPerMessage).toBe(3);
    expect(config.twitterProxyHosts).toBeUndefined();
  });

  it('keeps host lists an operator parked alongside a disabled feature', () => {
    const config = parseSocialLinkPreviewConfig({ enabled: false, ...proxyHosts() });
    expect(config.enabled).toBe(false);
    expect(config.threadsProxyHosts).toEqual(['viewthreads.com']);
  });

  it('returns every configured host list verbatim when enabled', () => {
    const hosts = proxyHosts();
    const config = parseSocialLinkPreviewConfig({
      enabled: true,
      providers: ['twitter', 'bahamut'],
      ...hosts,
    });
    expect(config.enabled).toBe(true);
    expect(config.providers).toEqual(['twitter', 'bahamut']);
    for (const key of PROXY_HOST_KEYS) {
      expect(config[key]).toEqual(hosts[key]);
    }
    expect(config.originalMessageStrategy).toBe('suppress');
  });

  it.each(PROXY_HOST_KEYS)('rejects an enabled block missing %s, naming the key', (key) => {
    const hosts: Record<string, string[]> = proxyHosts();
    delete hosts[key];
    expect(issuePaths(parseFailure({ enabled: true, ...hosts }))).toContain(key);
  });

  it('rejects an unknown key (strict schema)', () => {
    expect(() =>
      parseSocialLinkPreviewConfig({ enabled: true, ...proxyHosts(), bogus: 1 }),
    ).toThrow(z.ZodError);
    expect(() => parseSocialLinkPreviewConfig({ bogus: 1 })).toThrow(z.ZodError);
  });

  it('rejects the removed scalar proxy-host keys (migrated to arrays)', () => {
    expect(() => parseSocialLinkPreviewConfig({ twitterProxyHost: 'fxtwitter.com' })).toThrow(
      z.ZodError,
    );
  });

  it('rejects an empty proxy-host list whether the feature is enabled or not', () => {
    expect(issuePaths(parseFailure({ twitterProxyHosts: [] }))).toContain('twitterProxyHosts');
    expect(
      issuePaths(parseFailure({ enabled: true, ...proxyHosts(), redditProxyHosts: [] })),
    ).toContain('redditProxyHosts');
  });

  it.each([0, -1, 1.5, 25 * 1024 * 1024 + 1])(
    'rejects an invalid video byte limit: %s',
    (maxVideoBytes) => {
      expect(issuePaths(parseFailure({ maxVideoBytes }))).toContain('maxVideoBytes');
    },
  );

  it.each([0, -1, 1.5, 60_001])('rejects an invalid video timeout: %s', (videoTimeoutMs) => {
    expect(issuePaths(parseFailure({ videoTimeoutMs }))).toContain('videoTimeoutMs');
  });

  it('rejects an out-of-range timeout and an invalid provider name', () => {
    expect(() => parseSocialLinkPreviewConfig({ timeoutMs: 999_999 })).toThrow(z.ZodError);
    expect(() => parseSocialLinkPreviewConfig({ providers: ['myspace'] })).toThrow(z.ZodError);
  });
});
