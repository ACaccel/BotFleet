/**
 * Lifecycle tests for the earthquake plugin: the alert API's configuration
 * fails fast and the API stays off without a port; the CWA report poller
 * stays off without a key, polls with one, and leaves no timer behind
 * after shutdown. The alert API's HTTP contract is covered by
 * `test/integration/plugins/earthquake-route.int.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { TOKENS } from '../../../src/bot/tokens';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import type { Translator } from '../../../src/core/i18n';
import { createContainer } from '../../../src/core/ioc';
import type { Logger } from '../../../src/core/logger';
import type { PluginRuntimeContext } from '../../../src/core/plugin';
import { systemClock } from '../../../src/core/time';
import { boundedHttp } from '../../../src/infra/http';
import { createEarthquakePlugin } from '../../../src/plugins/earthquake';

const POLL_INTERVAL_MS = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const buildContext = (): { ctx: PluginRuntimeContext; info: ReturnType<typeof vi.fn> } => {
  const info = vi.fn();
  const logger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  const container = createContainer();
  container.registerSingleton(
    TOKENS.DiscordClient,
    () => ({ guilds: { cache: new Map() } }) as unknown as Client,
  );
  container.registerSingleton(
    TOKENS.GuildRegistry,
    () => ({ getChannel: () => undefined }) as unknown as GuildRegistry,
  );
  const ctx = {
    logger,
    translator: { t: (key: string) => key } as unknown as Translator,
    clock: systemClock,
    resolve: container.resolve.bind(container),
  } as unknown as PluginRuntimeContext;
  return { ctx, info };
};

describe('earthquake plugin report poller', () => {
  it('stays off without a CWA key and says so once', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(boundedHttp, 'get');
    const fetchReports = vi.fn();
    const plugin = createEarthquakePlugin({}, { fetchReports });
    const { ctx, info } = buildContext();

    await plugin.onReady?.(ctx);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(fetchReports).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/CWA_API_KEY is not set/));
    expect(vi.getTimerCount()).toBe(0);
    await plugin.onShutdown?.(ctx);
  });

  it('polls with the configured key once a minute', async () => {
    vi.useFakeTimers();
    const fetchReports = vi.fn(async () => ({ reports: [], rejected: [] }));
    const plugin = createEarthquakePlugin({ cwaApiKey: 'cwa-test-key' }, { fetchReports });
    const { ctx } = buildContext();

    await plugin.onReady?.(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReports).toHaveBeenCalledTimes(1);
    expect(fetchReports).toHaveBeenCalledWith('cwa-test-key');

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchReports).toHaveBeenCalledTimes(2);
    await plugin.onShutdown?.(ctx);
  });

  it('clears the poll timer on shutdown', async () => {
    vi.useFakeTimers();
    const fetchReports = vi.fn(async () => ({ reports: [], rejected: [] }));
    const plugin = createEarthquakePlugin({ cwaApiKey: 'cwa-test-key' }, { fetchReports });
    const { ctx } = buildContext();

    await plugin.onReady?.(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await plugin.onShutdown?.(ctx);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(fetchReports).toHaveBeenCalledTimes(1);
  });

  it('tolerates shutdown before it ever started', async () => {
    const plugin = createEarthquakePlugin({ cwaApiKey: 'cwa-test-key' });
    const { ctx } = buildContext();

    await expect(plugin.onShutdown?.(ctx)).resolves.toBeUndefined();
  });
});

describe('earthquake plugin alert API', () => {
  it('rejects a port without a long enough key', () => {
    expect(() => createEarthquakePlugin({ alertPort: 4000 })).toThrow(/at least 32 characters/);
    expect(() => createEarthquakePlugin({ alertPort: 4000, alertKey: 'e'.repeat(31) })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects a malformed earthquake_alert block at composition', () => {
    expect(() =>
      createEarthquakePlugin({ alertConfig: { ping_min_local_intensity: '8' } }),
    ).toThrow(/earthquake_alert\.ping_min_local_intensity/);
    expect(() => createEarthquakePlugin({ alertConfig: { extra: true } })).toThrow(
      /Invalid earthquake_alert config/,
    );
  });

  it('logs that it is disabled without a port and binds nothing', async () => {
    const plugin = createEarthquakePlugin({ alertKey: 'e'.repeat(32) });
    const { ctx, info } = buildContext();

    await plugin.start?.(ctx);

    expect(info).toHaveBeenCalledWith(expect.stringMatching(/EARTHQUAKE_ALERT_PORT is not set/));
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/listening/));
    await expect(plugin.onShutdown?.(ctx)).resolves.toBeUndefined();
  });
});
