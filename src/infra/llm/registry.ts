/**
 * Strategy lookup for LLM providers, keyed by provider name.
 *
 * Holds factories rather than instances so a deployment configuring only one
 * provider's key does not crash at startup when other SDKs reject missing
 * credentials. Instances are built on first use and cached.
 *
 * `tryResolve` returns a `Result` for the recoverable missing-key path so
 * `LLMService` stays on the Result rail; `resolve` throws
 * `MissingApiKeyError` for callers that handle it directly. Both throw a
 * native `TypeError` for an unknown provider (a programmer error).
 *
 * Adding a provider: implement {@link LLMProvider}, append its name to
 * {@link LLMProviderName}, pass its key in `apiKeys`, and register it in
 * {@link createDefaultRegistry}.
 */
import { LlmProviderError } from '../../core/errors';
import { err, ok, type Result } from '../../core/result';
import type { AnyLlmProviderError } from './errors';
import {
  MissingApiKeyError,
  PROVIDER_API_KEY_ENV,
  type LLMProvider,
  type LLMProviderName,
} from './types';

type LlmProviderFactory = () => LLMProvider;

/** Pre-resolved per-provider API keys. `undefined` = unset / unused. */
export type LlmProviderApiKeys = Readonly<Partial<Record<LLMProviderName, string | undefined>>>;

const missingApiKeyToLlmError = (provider: LLMProviderName, envVar: string): AnyLlmProviderError =>
  new LlmProviderError({
    code: 'LLM_INVALID_API_KEY',
    messageKey: 'errors:llm.invalid_api_key',
    messageParams: { provider, envVar },
    context: { operation: 'LlmProviderRegistry.tryResolve' },
    cause: new MissingApiKeyError(provider, envVar),
  }) as AnyLlmProviderError;

export class LlmProviderRegistry {
  private readonly factories: Map<LLMProviderName, LlmProviderFactory>;
  private readonly apiKeys: LlmProviderApiKeys;
  private readonly instances = new Map<LLMProviderName, LLMProvider>();

  public constructor(
    factories: Iterable<readonly [LLMProviderName, LlmProviderFactory]>,
    apiKeys: LlmProviderApiKeys = {},
  ) {
    this.factories = new Map(factories);
    this.apiKeys = apiKeys;
  }

  /**
   * Resolve a provider by name. Throws {@link MissingApiKeyError} if
   * the provider's API key is empty / unset; throws a native
   * `TypeError` if the name is not registered. Prefer
   * {@link tryResolve} for new code so the missing-key path stays
   * on the Result rail.
   */
  public resolve(name: LLMProviderName): LLMProvider {
    const cached = this.instances.get(name);
    if (cached !== undefined) return cached;

    const keyValue = this.apiKeys[name];
    if (keyValue === undefined || keyValue.length === 0) {
      throw new MissingApiKeyError(name, PROVIDER_API_KEY_ENV[name]);
    }

    const factory = this.factories.get(name);
    if (factory === undefined) {
      // Programmer error: a hard-coded LLMProviderName slipped past the
      // registry's known set. Native TypeError per the DomainError
      // convention ("DomainError is for expected failure modes only").
      throw new TypeError(`LlmProviderRegistry.resolve: unknown provider "${name}"`);
    }
    const instance = factory();
    this.instances.set(name, instance);
    return instance;
  }

  /**
   * Result-shaped resolution. Returns `Ok(LLMProvider)` on success,
   * `Err(LlmProviderError)` for the recoverable missing-key path
   * (already translated through the i18n catalog). Throws `TypeError`
   * only for the programmer-error case (unknown provider name) — a
   * domain that is genuinely uncatchable.
   */
  public tryResolve(name: LLMProviderName): Result<LLMProvider, AnyLlmProviderError> {
    const cached = this.instances.get(name);
    if (cached !== undefined) return ok(cached);

    const keyValue = this.apiKeys[name];
    if (keyValue === undefined || keyValue.length === 0) {
      return err(missingApiKeyToLlmError(name, PROVIDER_API_KEY_ENV[name]));
    }

    const factory = this.factories.get(name);
    if (factory === undefined) {
      throw new TypeError(`LlmProviderRegistry.tryResolve: unknown provider "${name}"`);
    }
    const instance = factory();
    this.instances.set(name, instance);
    return ok(instance);
  }

  /** True if the provider is registered (regardless of whether its key is set). */
  public has(name: LLMProviderName): boolean {
    return this.factories.has(name);
  }

  /** Snapshot of every registered provider name. */
  public names(): readonly LLMProviderName[] {
    return [...this.factories.keys()];
  }
}
