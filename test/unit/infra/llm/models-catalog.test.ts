/**
 * ModelCatalog DI integration smoke test.
 *
 * The catalog is not a module-scope holder — it is
 * built by `LlmChatPlugin.init` and published through
 * `ctx.registerInstance(TOKENS.ModelCatalog, ...)`. This test wires
 * the plugin against a real `PluginLifecycleRunner` + container,
 * stubs the typed Env, and asserts:
 *   - the container resolves a `ModelCatalog` after `runInit`;
 *   - bots that never register `LlmChatPlugin` resolve `undefined`,
 *     matching the `bot.modelCatalog` getter's contract.
 *
 * The catalog's HTTP-fetch behaviour is covered elsewhere; here we
 * only care about the DI hop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContainer } from '../../../../src/core/ioc';
import { TOKENS } from '../../../../src/bot/tokens';
import { EventDispatcher } from '../../../../src/core/plugin/event-dispatcher';
import {
  PluginLifecycleRunner,
  type LifecycleHost,
  type RegisteredPlugin,
} from '../../../../src/core/plugin/host/lifecycle';
import type { DisabledPlugin, Plugin, PluginId } from '../../../../src/core/plugin/types';
import { systemClock } from '../../../../src/core/time';
import { ModelCatalog } from '../../../../src/infra/llm/models-catalog';
import { DEFAULT_RATE_LIMIT } from '../../../../src/application/ai/policy';
import { createLlmChatPlugin } from '../../../../src/plugins/llm-chat';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';

const silent = silentLogger();

interface PartialEnv {
  readonly XAI_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
}

const stubEnv: PartialEnv = {
  XAI_API_KEY: 'sk-test-xai',
  OPENAI_API_KEY: 'sk-test-openai',
  ANTHROPIC_API_KEY: 'sk-test-anthropic',
  GEMINI_API_KEY: 'sk-test-gemini',
};

describe('ModelCatalog DI wiring', () => {
  it('LlmChatPlugin.init registers a ModelCatalog the container can resolve', async () => {
    const container = createContainer();
    // The plugin reads the four provider API keys off the typed Env.
    // Cast a minimal stub through unknown so we do not have to
    // synthesise the full schema.
    container.registerSingleton(TOKENS.Env, () => stubEnv as unknown as never);
    // `init` also resolves the message-path dependencies once, so both
    // have to be bound for the phase to complete.
    container.registerSingleton(TOKENS.Logger, () => silent);
    container.registerSingleton(TOKENS.GuildRegistry, () => ({
      getRepos: () => undefined,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    }));

    const plugin = createLlmChatPlugin({
      clientId: 'bot-1',
      policy: { rateLimit: DEFAULT_RATE_LIMIT },
      isAdmin: () => false,
    }) as Plugin;
    const registered = new Map<PluginId, RegisteredPlugin>([[plugin.id, { plugin }]]);
    const host: LifecycleHost = {
      registered,
      disabled: new Map<PluginId, DisabledPlugin>(),
      resolve: container.resolve.bind(container),
      container,
      dispatcher: new EventDispatcher(silent),
      logger: silent,
      translator: echoTranslator(),
      clock: systemClock,
    };

    const runner = new PluginLifecycleRunner(host);
    await runner.runInit();

    expect(host.disabled.size).toBe(0);
    const catalog = container.resolve(TOKENS.ModelCatalog);
    expect(catalog).toBeInstanceOf(ModelCatalog);
    // Cache miss returns an empty array (the synchronous contract the
    // `/ai settings` modal builder depends on); we only check the
    // shape, not the contents.
    expect(Array.isArray(catalog.list('openai'))).toBe(true);
  });

  it('leaves TOKENS.ModelCatalog unbound when LlmChatPlugin is not registered', () => {
    const container = createContainer();
    expect(container.tryResolve(TOKENS.ModelCatalog)).toBeUndefined();
  });
});

describe('ModelCatalog.listLive (uncapped vs cached cap)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the full live list while the cache stays capped to the menu limit', async () => {
    // 30 distinct Gemini models — above the 25-option select-menu cap.
    const models = Array.from({ length: 30 }, (_, i) => ({
      name: `models/gemini-test-${String(i).padStart(2, '0')}`,
      supportedGenerationMethods: ['generateContent'],
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ models }) }) as unknown as Response),
    );

    const catalog = new ModelCatalog({ gemini: 'test-key' });

    // listLive feeds the price-ranking resolver: it must see every model,
    // not an alphabetical top-25 slice (the cheapest could sit past #25).
    const live = await catalog.listLive('gemini');
    expect(live).toHaveLength(30);

    // The synchronous cache view feeds the Discord select menu and must
    // stay within the 25-option hard limit.
    expect(catalog.list('gemini')).toHaveLength(25);
  });

  it('sends the Gemini key as a header, never in the query string', async () => {
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => ({ models: [] }) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);

    await new ModelCatalog({ gemini: 'super-secret-key' }).listLive('gemini');

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    // A URL reaches request logs and error messages verbatim, where the
    // log redactor cannot reach inside it.
    expect(url).not.toContain('super-secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('super-secret-key');
  });
});

describe('ModelCatalog background fetch resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('logs a warning naming the provider when a background fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');

    const catalog = new ModelCatalog({ gemini: 'test-key' }, logger);
    expect(catalog.list('gemini')).toEqual([]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(warn.mock.calls[0]?.[0]).toMatchObject({ provider: 'gemini' });
  });

  it('releases the in-flight marker when a fetch never settles, so a later call retries', async () => {
    // A provider that hangs forever used to wedge the catalog: the
    // in-flight flag was never cleared and every later `list` call
    // returned an empty array without re-fetching.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Promise<Response>(() => {
          /* never settles */
        });
      }),
    );
    vi.useFakeTimers();
    const catalog = new ModelCatalog({ gemini: 'test-key' });

    expect(catalog.list('gemini')).toEqual([]);
    expect(calls).toBe(1);
    // A second call while the first is genuinely in flight must not
    // start a duplicate fetch.
    expect(catalog.list('gemini')).toEqual([]);
    expect(calls).toBe(1);

    // Once the bounded fetch times out, the marker clears and the next
    // call is free to retry.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(catalog.list('gemini')).toEqual([]);
    expect(calls).toBe(2);
  });
});
