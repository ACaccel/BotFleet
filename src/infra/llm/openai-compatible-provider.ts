/**
 * Template for providers that speak the OpenAI wire protocol (Strategy +
 * Template Method, mirroring `link-preview/providers/rewrite-provider`).
 *
 * OpenAI itself and xAI both expose two endpoints behind one `openai`
 * SDK client:
 *   - `/v1/chat/completions` for plain chat;
 *   - `/v1/responses` with a server-side web-search tool when the caller
 *     enables web search.
 *
 * Only three things vary between them: the provider name that stamps
 * error codes, the `baseURL`, and the `tools` discriminator the Responses
 * API expects. Subclasses supply those as an {@link OpenAICompatibleSpec}.
 *
 * Every SDK throw is funnelled through {@link translateProviderError}, so
 * callers see a typed {@link LlmProviderError} sub-code.
 */
import OpenAI from 'openai';

import { emptyResponseError, translateProviderError } from './error-translator';
import type { LLMMessage, LLMProvider, LLMProviderName, LLMResult, LLMSettings } from './types';

export interface OpenAICompatibleSpec {
  /** Provider name carried into the translated error codes. */
  readonly name: LLMProviderName;
  /** Operation label stamped on every error's `context.operation`. */
  readonly operation: string;
  /** Omitted for OpenAI itself, which uses the SDK's default host. */
  readonly baseURL?: string;
  /** Web-search tool entry the Responses API call sends. */
  readonly webSearchTool: OpenAI.Responses.Tool;
}

export abstract class OpenAICompatibleProvider implements LLMProvider {
  public readonly supportsWebSearch = true;

  private readonly client: OpenAI;
  private readonly spec: OpenAICompatibleSpec;

  protected constructor(spec: OpenAICompatibleSpec, apiKey?: string, client?: OpenAI) {
    // `client` injection exists so contract tests can pass a
    // pre-configured instance with a custom `baseURL` (the nock
    // interceptor binds to whatever host the test sets). `apiKey`
    // arrives from the typed `Env` via the composition root; the
    // registry's missing-key gate at `resolve()` runs first so a
    // missing value never reaches this constructor in production.
    this.client = client ?? new OpenAI({ apiKey, baseURL: spec.baseURL });
    this.spec = spec;
  }

  public async chat(messages: readonly LLMMessage[], settings: LLMSettings): Promise<LLMResult> {
    try {
      if (settings.webSearch) {
        return await this.chatWithWebSearch(messages, settings);
      }
      return await this.chatStandard(messages, settings);
    } catch (err: unknown) {
      throw translateProviderError(this.spec.name, this.spec.operation, err);
    }
  }

  private async chatStandard(
    messages: readonly LLMMessage[],
    settings: LLMSettings,
  ): Promise<LLMResult> {
    const response = await this.client.chat.completions.create({
      model: settings.model,
      temperature: settings.temperature,
      messages: [
        ...(settings.systemPrompt.length > 0
          ? [{ role: 'system' as const, content: settings.systemPrompt }]
          : []),
        ...messages,
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (content === null || content === undefined || content.length === 0) {
      throw emptyResponseError(this.spec.name, `${this.spec.operation}.chat_completions`);
    }
    const u = response.usage;
    return {
      content,
      usage:
        u === null || u === undefined
          ? null
          : { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens },
    };
  }

  private async chatWithWebSearch(
    messages: readonly LLMMessage[],
    settings: LLMSettings,
  ): Promise<LLMResult> {
    const inputMessages: OpenAI.Responses.EasyInputMessage[] = [
      ...(settings.systemPrompt.length > 0
        ? [{ role: 'system' as const, content: settings.systemPrompt }]
        : []),
      ...messages,
    ];
    const response = await this.client.responses.create({
      model: settings.model,
      temperature: settings.temperature,
      tools: [this.spec.webSearchTool],
      input: inputMessages,
    });
    const content = response.output_text;
    if (content === null || content === undefined || content.length === 0) {
      throw emptyResponseError(this.spec.name, `${this.spec.operation}.responses`);
    }
    const u = response.usage;
    return {
      content,
      usage:
        u === null || u === undefined
          ? null
          : { inputTokens: u.input_tokens, outputTokens: u.output_tokens },
    };
  }
}
