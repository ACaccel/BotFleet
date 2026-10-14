/**
 * `infra/llm` barrel: provider adapters, the registry, error translation and
 * provider knowledge (`models-catalog`, `pricing`). Feature state such as
 * `SessionManager` belongs in `src/plugins/llm-chat/internal/`.
 */
export {
  type LLMMessage,
  type LLMProvider,
  type LLMProviderName,
  type LLMResult,
  type LLMSettings,
  type LLMUsage,
  DEFAULT_MODELS,
  PROVIDER_API_KEY_ENV,
  MissingApiKeyError,
} from './types';

export type { AnyLlmProviderError } from './errors';
export { LlmProviderRegistry } from './registry';
export { LLMService } from './llm-service';
export { createDefaultRegistry } from './default-registry';
export { translateProviderError } from './error-translator';

export { OpenAIProvider } from './openai-provider';
export { AnthropicProvider } from './anthropic-provider';
export { GeminiProvider } from './gemini-provider';
export { XAIProvider } from './xai-provider';

export { ModelCatalog } from './models-catalog';
export { DefaultModelResolver } from './default-model-resolver';
export type { LlmProviderApiKeys } from './registry';
export { calculateCost, cheapestModel, formatUsageFooter } from './pricing';

export { SelfHostedLlmClient } from './selfhosted-client';
