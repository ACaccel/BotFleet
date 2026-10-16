/**
 * Live model-catalog cache for the LLM Strategy.
 *
 * Wraps each provider's SDK list-models call and caches the result
 * with a TTL so `/ai settings` can build a Discord StringSelectMenu
 * synchronously (the interaction has a ~3-second window before
 * Discord auto-acks). Cache misses return `[]` immediately and kick
 * off a background fetch that fills the cache for the next caller —
 * the empty-array contract gives the UI a clear "no models available"
 * signal instead of a stale guess.
 *
 * The cache and API keys are instance state on the `ModelCatalog`
 * class (not a module-scope holder), so the catalog carries no
 * ambient global state. It is published by `LlmChatPlugin.init`
 * through `ctx.registerInstance(TOKENS.ModelCatalog, ...)` and
 * consumers (the `/ai settings` handler) reach it via
 * `bot.modelCatalog`.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../../core/logger';
import { type LLMProviderName } from './types';
import type { LlmProviderApiKeys } from './registry';

/** TTL for cached model lists. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Discord StringSelectMenu hard limit. */
const SELECT_MENU_MAX_OPTIONS = 25;

/**
 * Wall-clock budget for one provider's list-models round trip. Every
 * fetch path is bounded by it: an SDK pagination loop that stalls
 * mid-stream would otherwise leave the provider permanently marked
 * in-flight, and `/ai settings` would show an empty model list for the
 * lifetime of the process.
 */
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  list: string[];
  expiresAt: number;
}

/** Reject `op` once `ms` elapses, always clearing the timer. */
const withTimeout = async <T>(op: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class ModelCatalog {
  private readonly cache = new Map<LLMProviderName, CacheEntry>();
  private readonly inFlight = new Set<LLMProviderName>();

  /**
   * @param apiKeys Per-provider API keys, derived from the typed Env.
   * @param logger  Optional sink for background-fetch failures. Without
   *   it a provider that never lists models is silent, and the operator
   *   sees only an empty `/ai settings` menu with no explanation.
   */
  public constructor(
    private readonly apiKeys: LlmProviderApiKeys,
    private readonly logger?: Logger,
  ) {}

  /**
   * Returns the live model list for a provider, **synchronously**.
   *
   *   - cache hit  -> live list from a successful prior SDK call
   *   - cache miss -> empty array, plus a fire-and-forget background fetch that
   *                   fills the cache for the next caller
   *
   * Returning an empty array (rather than a hardcoded fallback) is intentional:
   * the caller is expected to surface a clear "no available models" message so
   * the user knows their provider/API key/network is the actual problem instead
   * of seeing a stale guess as the canonical list.
   */
  public list(provider: LLMProviderName): string[] {
    const cached = this.cache.get(provider);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.list;
    }

    this.scheduleBackgroundFetch(provider);
    return [];
  }

  /**
   * Fetch a provider's model list **authoritatively**, awaiting the SDK
   * call instead of returning a cached/empty snapshot. Used by
   * {@link DefaultModelResolver}'s periodic refresh, where blocking on
   * the live result is the whole point.
   *
   * Returns the *full* deduped list — deliberately NOT capped to
   * {@link SELECT_MENU_MAX_OPTIONS}. That cap exists only to fit a
   * Discord select menu; applying it here would let the cheapest model
   * fall outside the alphabetical top-25 and be silently dropped before
   * the resolver ranks by price. The cache it refreshes (consumed by the
   * synchronous {@link list} for the menu) is still capped.
   *
   * Rejects when the provider has no API key or the SDK call fails — the
   * caller decides whether to keep its existing default.
   */
  public async listLive(provider: LLMProviderName): Promise<string[]> {
    const full = dedupeSort(await this.fetchModels(provider));
    if (full.length > 0) {
      this.cache.set(provider, {
        list: full.slice(0, SELECT_MENU_MAX_OPTIONS),
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    return full;
  }

  private scheduleBackgroundFetch(provider: LLMProviderName): void {
    if (this.inFlight.has(provider)) return;
    this.inFlight.add(provider);
    void this.fetchModels(provider)
      .then((raw) => {
        const list = normalizeList(raw);
        // Only cache non-empty results; an empty list means the upstream
        // returned nothing usable and we want the next caller to retry
        // rather than be stuck with no options for the full TTL.
        if (list.length > 0) {
          this.cache.set(provider, { list, expiresAt: Date.now() + CACHE_TTL_MS });
        }
      })
      .catch((err: unknown) => {
        // Not fatal — the next call retries and callers see an empty
        // list — but a provider that consistently fails to list models
        // is an operator problem (bad key, blocked egress), so it is
        // recorded rather than swallowed.
        this.logger?.warn(
          { err: err instanceof Error ? err : new Error(String(err)), provider },
          'ModelCatalog: background model-list fetch failed',
        );
      })
      .finally(() => {
        this.inFlight.delete(provider);
      });
  }

  private async fetchModels(provider: LLMProviderName): Promise<string[]> {
    const apiKey = this.apiKeys[provider];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`API key for ${provider} not set`);
    }

    return withTimeout(
      fetchProviderModels(provider, apiKey),
      FETCH_TIMEOUT_MS,
      `${provider} listModels`,
    );
  }
}

function fetchProviderModels(provider: LLMProviderName, apiKey: string): Promise<string[]> {
  switch (provider) {
    case 'openai':
      return fetchOpenAICompatibleModels(apiKey, undefined, /^(gpt-|o\d|chatgpt-)/i);
    case 'xai':
      return fetchOpenAICompatibleModels(apiKey, 'https://api.x.ai/v1', /grok/i);
    case 'anthropic':
      return fetchAnthropicModels(apiKey);
    case 'gemini':
      return fetchGeminiModels(apiKey);
  }
}

async function fetchOpenAICompatibleModels(
  apiKey: string,
  baseURL: string | undefined,
  chatIdPattern: RegExp,
): Promise<string[]> {
  const client = new OpenAI({ apiKey, baseURL, timeout: FETCH_TIMEOUT_MS });
  const ids: string[] = [];
  for await (const model of client.models.list()) {
    if (chatIdPattern.test(model.id)) ids.push(model.id);
  }
  return ids;
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, timeout: FETCH_TIMEOUT_MS });
  const ids: string[] = [];
  for await (const model of client.models.list()) {
    ids.push(model.id);
  }
  return ids;
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  // The @google/generative-ai SDK does not expose listModels; use the REST
  // endpoint directly and keep only models supporting generateContent.
  // The key travels in `x-goog-api-key`, never the query string: a URL
  // reaches request logs, proxy access logs, and error messages verbatim,
  // where the log redactor cannot reach inside it.
  const url = 'https://generativelanguage.googleapis.com/v1/models?pageSize=200';
  const res = await fetch(url, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Gemini listModels HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const ids: string[] = [];
  for (const m of json.models ?? []) {
    if (!m.name) continue;
    if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes('generateContent'))
      continue;
    // Strip the `models/` prefix returned by the REST API.
    ids.push(m.name.replace(/^models\//, ''));
  }
  return ids;
}

/** Dedupe + alphabetical sort, with no length cap. */
function dedupeSort(list: string[]): string[] {
  return Array.from(new Set(list)).sort();
}

/** Dedupe + sort, then cap to the Discord select-menu option limit. */
function normalizeList(list: string[]): string[] {
  return dedupeSort(list).slice(0, SELECT_MENU_MAX_OPTIONS);
}
