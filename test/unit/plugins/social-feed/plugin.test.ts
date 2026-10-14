/**
 * Unit tests for the social-feed plugin shell: config validation at
 * composition time, and the self-rescheduling poll loop's resilience and
 * teardown. The pass itself is mocked out — `poll.test.ts` covers it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../../../src/core/logger';
import { TOKENS } from '../../../../src/bot/tokens';
import type { PluginRuntimeContext } from '../../../../src/core/plugin';
import { createSocialFeedPlugin } from '../../../../src/plugins/social-feed';
import { runFeedPass } from '../../../../src/plugins/social-feed/internal';
import { FeedPlatformRegistry } from '../../../../src/infra/social-feed';

// Replace the pass with a controllable spy so the loop tests can force a
// throw without touching the network, Mongo, or Discord. `vi.mock` is
// hoisted above the imports, so the spy is registered before the plugin
// module loads.
vi.mock('../../../../src/plugins/social-feed/internal', () => ({
  runFeedPass: vi.fn(),
}));

const POLL_INTERVAL_MS = 60_000;
const platforms = new FeedPlatformRegistry([]);

const enabledConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  platforms: { x: {} },
  pollIntervalMs: POLL_INTERVAL_MS,
  ...overrides,
});

describe('createSocialFeedPlugin — shape and config', () => {
  it('accepts an absent config block', () => {
    expect(() => createSocialFeedPlugin(undefined)).not.toThrow();
  });

  it('accepts an enabled feed that configures a platform', () => {
    expect(createSocialFeedPlugin(enabledConfig()).id).toBe('social-feed');
  });

  it('rejects an unknown key so a typo fails at boot', () => {
    expect(() => createSocialFeedPlugin(enabledConfig({ pollIntervalMS: 60_000 }))).toThrow();
  });

  it('rejects an enabled feed with no platform configured', () => {
    expect(() => createSocialFeedPlugin({ enabled: true, platforms: {} })).toThrow();
  });

  it('rejects an unknown platform key', () => {
    expect(() => createSocialFeedPlugin(enabledConfig({ platforms: { bluesky: {} } }))).toThrow();
  });

  it.each([0, -1, 21])('rejects an out-of-range maxPostsPerPoll (%s)', (maxPostsPerPoll) => {
    // The cap bounds the blast radius of a cursor reset: without it one
    // stale page could drain a whole timeline into a channel.
    expect(() => createSocialFeedPlugin(enabledConfig({ maxPostsPerPoll }))).toThrow();
  });

  it('accepts maxPostsPerPoll exactly at its ceiling', () => {
    expect(() => createSocialFeedPlugin(enabledConfig({ maxPostsPerPoll: 20 }))).not.toThrow();
  });

  it.each([0, -1, 1.5])(
    'rejects a non-positive fullSweepEveryPolls (%s)',
    (fullSweepEveryPolls) => {
      // Zero would make `passCount % n` throw on the first pass; a
      // fraction would make the sweep fire at unpredictable intervals.
      expect(() => createSocialFeedPlugin(enabledConfig({ fullSweepEveryPolls }))).toThrow();
    },
  );

  it.each([59_999, 0, -1, 2_147_483_648])(
    'rejects an out-of-range pollIntervalMs (%s)',
    (pollIntervalMs) => {
      expect(() => createSocialFeedPlugin(enabledConfig({ pollIntervalMs }))).toThrow();
    },
  );

  it('accepts pollIntervalMs exactly at Node’s timer ceiling', () => {
    expect(() =>
      createSocialFeedPlugin(enabledConfig({ pollIntervalMs: 2_147_483_647 })),
    ).not.toThrow();
  });
});

describe('createSocialFeedPlugin — poll loop', () => {
  const mockedRunFeedPass = vi.mocked(runFeedPass);

  const buildCtx = (): PluginRuntimeContext =>
    ({
      logger: createLogger({ level: 'silent', pretty: false }),
      translator: { t: (key: string) => key },
      // The pass is mocked, so empty stubs satisfy the seams `onReady`
      // resolves; only the platform registry has a real instance, to
      // prove the container fallback path resolves at all.
      resolve: (t: unknown) => (t === TOKENS.FeedPlatformRegistry ? platforms : {}),
    }) as unknown as PluginRuntimeContext;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedRunFeedPass.mockReset();
    mockedRunFeedPass.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async (
    config: Record<string, unknown>,
    deps?: { platforms?: FeedPlatformRegistry },
  ): Promise<{ shutdown: () => Promise<void> }> => {
    const plugin = createSocialFeedPlugin(config, deps);
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) {
      throw new Error('social-feed plugin must expose onReady/onShutdown');
    }
    const ctx = buildCtx();
    await onReady(ctx);
    return { shutdown: async () => onShutdown(ctx) };
  };

  it('does not poll at all when disabled', async () => {
    const { shutdown } = await start({ enabled: false });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(mockedRunFeedPass).not.toHaveBeenCalled();
    await shutdown();
  });

  it('defaults an absent config block to disabled, so it never polls', async () => {
    const { shutdown } = await start({});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(mockedRunFeedPass).not.toHaveBeenCalled();
    await shutdown();
  });

  it('runs one pass immediately, then again on each interval', async () => {
    const { shutdown } = await start(enabledConfig());
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(2);

    await shutdown();
  });

  it('passes the injected registry through to the pass', async () => {
    const injected = new FeedPlatformRegistry([]);
    const { shutdown } = await start(enabledConfig(), { platforms: injected });

    expect(mockedRunFeedPass).toHaveBeenCalledWith(
      expect.objectContaining({ platforms: injected }),
      true,
    );
    await shutdown();
  });

  it('falls back to the container when no registry is injected', async () => {
    const { shutdown } = await start(enabledConfig());

    expect(mockedRunFeedPass).toHaveBeenCalledWith(expect.objectContaining({ platforms }), true);
    await shutdown();
  });

  it('makes the first pass a full sweep, then uses the cursor path', async () => {
    const { shutdown } = await start(enabledConfig({ fullSweepEveryPolls: 3 }));
    expect(mockedRunFeedPass).toHaveBeenLastCalledWith(expect.anything(), true);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenLastCalledWith(expect.anything(), false);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenLastCalledWith(expect.anything(), false);

    // Every third pass re-reads the whole timeline.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenLastCalledWith(expect.anything(), true);

    await shutdown();
  });

  it('keeps the loop alive after a failing first pass', async () => {
    mockedRunFeedPass
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(undefined);
    const { shutdown } = await start(enabledConfig());

    // The immediate pass fails internally but must not reject onReady.
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(2);

    await shutdown();
  });

  it('keeps the loop alive after a scheduled pass rejects', async () => {
    // The failure the timer body's own try/catch exists for: a rejection
    // on a scheduled tick has no caller to await it, so without that
    // catch it would surface as an unhandledRejection and the `finally`
    // would never reschedule — a loop that dies silently after one blip.
    mockedRunFeedPass
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(undefined);
    const { shutdown } = await start(enabledConfig());

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(3);

    await shutdown();
  });

  it('does not reject onReady when the immediate pass throws', async () => {
    mockedRunFeedPass.mockRejectedValue(new Error('boom'));
    const plugin = createSocialFeedPlugin(enabledConfig());
    const { onReady, onShutdown } = plugin;
    if (onReady === undefined || onShutdown === undefined) throw new Error('missing hooks');
    const ctx = buildCtx();

    await expect(onReady(ctx)).resolves.toBeUndefined();
    await onShutdown(ctx);
  });

  it('stops polling after shutdown', async () => {
    const { shutdown } = await start(enabledConfig());
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockedRunFeedPass).toHaveBeenCalledTimes(2);

    await shutdown();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);

    expect(mockedRunFeedPass).toHaveBeenCalledTimes(2);
  });
});
