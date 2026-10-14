/**
 * `DefaultModelResolver`: keeps the per-provider default chat model pointed
 * at the cheapest model that is *still listed* by the provider.
 *
 * {@link DEFAULT_MODELS} is a static seed. Providers retire cheap models
 * without notice, which would strand a new whitelist entry on an id the API
 * no longer accepts. This resolver re-derives the default on a schedule (the
 * LLM-chat plugin runs it weekly) by intersecting each provider's live model
 * list with the local pricing table and picking the cheapest priced survivor.
 *
 * It is conservative: when a provider's live list cannot be fetched (no API
 * key, network error) or yields no priced model, the existing default is
 * kept; a stale-but-valid default beats an empty one.
 */
import type { Logger } from '../../core/logger';
import type { ModelCatalog } from './models-catalog';
import { cheapestModel } from './pricing';
import { DEFAULT_MODELS, type LLMProviderName } from './types';

const PROVIDERS: readonly LLMProviderName[] = ['xai', 'openai', 'anthropic', 'gemini'];

export class DefaultModelResolver {
  private readonly defaults: Map<LLMProviderName, string>;

  public constructor(
    private readonly catalog: ModelCatalog,
    private readonly logger?: Logger,
  ) {
    this.defaults = new Map(PROVIDERS.map((provider) => [provider, DEFAULT_MODELS[provider]]));
  }

  /** Current default model for a provider — never undefined. */
  public current(provider: LLMProviderName): string {
    return this.defaults.get(provider) ?? DEFAULT_MODELS[provider];
  }

  /**
   * Re-resolve every provider's default from its live model list. Each
   * provider is handled independently: one failing provider never blocks
   * the others, and a failure leaves that provider's previous default
   * untouched.
   */
  public async refresh(): Promise<void> {
    for (const provider of PROVIDERS) {
      await this.refreshProvider(provider);
    }
  }

  private async refreshProvider(provider: LLMProviderName): Promise<void> {
    let live: string[];
    try {
      live = await this.catalog.listLive(provider);
    } catch (err: unknown) {
      this.logger?.warn(
        { provider, err },
        'DefaultModelResolver: live model fetch failed; keeping previous default',
      );
      return;
    }

    if (live.length === 0) {
      this.logger?.warn(
        { provider },
        'DefaultModelResolver: empty live model list; keeping previous default',
      );
      return;
    }

    const cheapest = cheapestModel(live);
    if (cheapest === undefined) {
      this.logger?.warn(
        { provider, liveCount: live.length },
        'DefaultModelResolver: no priced model among live list; keeping previous default',
      );
      return;
    }

    const previous = this.current(provider);
    if (cheapest !== previous) {
      this.defaults.set(provider, cheapest);
      this.logger?.info(
        { provider, previous, current: cheapest },
        'DefaultModelResolver: updated default model',
      );
    }
  }
}
