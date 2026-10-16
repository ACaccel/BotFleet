/**
 * LlmChatPlugin — Konata's chat lifecycle on the plugin host.
 *
 * Listens for `messageCreate` events. Behaviour:
 *   - whitelisted users only (via `UserApiSettingRepo`);
 *   - @-mention starts a new session;
 *   - a reply to an active session message continues it (owner-only);
 *   - placeholder reply edited with the LLM response, chunked
 *     paragraph-aware under the 2000-char limit, with a usage footer;
 *   - all bot output sanitised with `allowedMentions: { parse: [] }`
 *     so prompt-induced @everyone/@role/@user pings cannot fire.
 *
 * Bot identity is injected via `clientId`: it strips the plugin's own
 * mention from input, drives the new-vs-continue branching, and tags
 * error logs.
 */
import type { Message } from 'discord.js';

import type { Translator } from '../../core/i18n';
import { TOKENS } from '../../bot/tokens';
import type { GuildRegistry } from '../../bot/guild-registry';
import type { Plugin } from '../../core/plugin';
import {
  DefaultModelResolver,
  LLMService,
  ModelCatalog,
  createDefaultRegistry,
  formatUsageFooter,
  type AnyLlmProviderError,
  type LLMMessage,
  type LLMProviderName,
  type LLMResult,
  type LLMSettings,
} from '../../infra/llm';
import { JobManager } from '../../core/scheduling';
import { effectiveModel, type AiPolicy } from '../../application/ai/policy';
import { gateChatRequest, releaseChatRequest, SessionManager } from './internal';
import { logError, type Logger } from '../../core/logger';

const PLUGIN_ID = 'llm-chat';
const PLUGIN_VERSION = '1.0.0';
const PREWARM_PROVIDERS: LLMProviderName[] = ['xai', 'openai', 'anthropic', 'gemini'];
const NO_MENTIONS = { parse: [] as const };
const MAX_DISCORD_MESSAGE_LENGTH = 2000;
/** Job key + cron for the weekly default-model refresh (Monday 04:00). */
const DEFAULT_MODEL_REFRESH_JOB_KEY = 'llm-chat:refresh-default-models';
const DEFAULT_MODEL_REFRESH_CRON = '0 4 * * 1';

interface LlmChatPluginConfig {
  readonly clientId: string;
  /** Model allowlist and rate limits; bot admins are exempt from both. */
  readonly policy: AiPolicy;
  readonly isAdmin: (userId: string) => boolean;
}

/** The message path's dependencies, built once by `init`. */
interface LlmChatRuntime {
  readonly service: LLMService;
  readonly registry: GuildRegistry;
  /** Bot-root logger: chat failures are per-guild operator events. */
  readonly logger: Logger;
}

interface UserApiDoc {
  userId: string;
  provider: string;
  model: string;
  temperature: number;
  system_prompt: string;
  web_search: boolean;
}

const toSettings = (doc: UserApiDoc, model: { provider: string; model: string }): LLMSettings => ({
  provider: model.provider as LLMProviderName,
  model: model.model,
  temperature: doc.temperature,
  systemPrompt: doc.system_prompt,
  webSearch: doc.web_search,
});

const stripMention = (content: string, clientId: string): string =>
  content.replace(new RegExp(`<@!?${clientId}>`, 'g'), '').trim();

const appendUsageFooter = (result: LLMResult, model: string, translator: Translator): string => {
  const footer = formatUsageFooter(
    model,
    result.usage,
    translator.t('replies:llm_chat.cost_unknown'),
  );
  return footer.length > 0 ? `${result.content}\n${footer}` : result.content;
};

const deliverChunked = async (
  message: Message,
  placeholder: Message,
  text: string,
): Promise<Message[]> => {
  if (text.length <= MAX_DISCORD_MESSAGE_LENGTH) {
    const edited = await placeholder.edit({ content: text, allowedMentions: NO_MENTIONS });
    return [edited];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_DISCORD_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_DISCORD_MESSAGE_LENGTH);
    if (splitAt < MAX_DISCORD_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf('\n', MAX_DISCORD_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_DISCORD_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_DISCORD_MESSAGE_LENGTH);
    }
    if (splitAt <= 0) splitAt = MAX_DISCORD_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  const sent: Message[] = [];
  sent.push(await placeholder.edit({ content: chunks[0]!, allowedMentions: NO_MENTIONS }));
  for (let i = 1; i < chunks.length; i += 1) {
    if (message.channel.isSendable()) {
      sent.push(
        (await message.channel.send({
          content: chunks[i]!,
          allowedMentions: NO_MENTIONS,
        })) as Message,
      );
    }
  }
  return sent;
};

/**
 * Render an LLM failure into a Discord reply. The error has already been
 * translated into a typed {@link LlmProviderError} by `LLMService.chat`,
 * so this handler does not need to discriminate on instance kinds — it
 * reads `messageKey` + `messageParams` directly. The log line keeps
 * the err object intact so pino's serialiser captures the cause
 * chain.
 */
const handleChatError = async (
  llmErr: AnyLlmProviderError,
  logger: Logger | undefined,
  guildId: string | null,
  placeholder: Message,
  translator: Translator,
): Promise<void> => {
  logError(logger, guildId, llmErr);
  const content = translator.t(
    llmErr.messageKey,
    llmErr.messageParams as Record<string, string | number> | undefined,
  );
  try {
    await placeholder.edit({ content, allowedMentions: NO_MENTIONS });
  } catch {
    if (placeholder.channel.isSendable()) {
      await placeholder.channel.send({ content, allowedMentions: NO_MENTIONS });
    }
  }
};

export const createLlmChatPlugin = (config: LlmChatPluginConfig): Plugin => {
  const sessions = new SessionManager();
  // Requests each member has waiting on a provider, for the concurrency limit.
  const inFlight = new Map<string, number>();
  // Everything the message path needs, built in `init()` from the
  // resolved typed Env rather than at factory time, so the provider
  // registry's API-key gate sees the values supplied through DI rather
  // than direct `process.env` reads — and so a message event costs no
  // container lookups.
  let runtime: LlmChatRuntime | undefined;
  /** See the `init` contract in `core/plugin/types.ts`: unreachable. */
  const requireRuntime = (): LlmChatRuntime => {
    if (runtime === undefined) {
      throw new TypeError('llm-chat: event dispatched before init built the runtime');
    }
    return runtime;
  };
  // Holds the cheapest-still-listed default model per provider. Created
  // in `init` alongside the catalog and refreshed weekly from `onReady`
  // so a model going legacy never strands the whitelist-entry default.
  let defaultModelResolver: DefaultModelResolver | undefined;

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async init(ctx): Promise<void> {
      const env = ctx.resolve(TOKENS.Env);
      runtime = {
        service: new LLMService(createDefaultRegistry(env)),
        registry: ctx.resolve(TOKENS.GuildRegistry),
        logger: ctx.resolve(TOKENS.Logger),
      };
      // Build a per-bot ModelCatalog with the typed-Env-derived
      // API-key map and publish it through the IoC container via
      // `ctx.registerInstance` so the catalog reaches handlers through
      // the bot's typed resolver (`bot.modelCatalog`); encapsulating the
      // cache + api-key map in a class keeps multiple bots in one
      // process from clobbering each other's API keys.
      const modelCatalog = new ModelCatalog(
        {
          xai: env.XAI_API_KEY,
          openai: env.OPENAI_API_KEY,
          anthropic: env.ANTHROPIC_API_KEY,
          gemini: env.GEMINI_API_KEY,
        },
        ctx.logger,
      );
      ctx.registerInstance(TOKENS.ModelCatalog, modelCatalog);
      defaultModelResolver = new DefaultModelResolver(modelCatalog, ctx.logger);
      ctx.registerInstance(TOKENS.DefaultModelResolver, defaultModelResolver);
      // Pre-warm each provider's live model catalog at boot. The call
      // returns a fallback sync while kicking off the SDK fetch, so by
      // the time `/ai settings` is invoked the cache is usually warm.
      for (const provider of PREWARM_PROVIDERS) {
        modelCatalog.list(provider);
      }
    },

    async onReady(ctx): Promise<void> {
      if (defaultModelResolver === undefined) return;
      const resolver = defaultModelResolver;
      // Initial resolve runs in the background so a slow provider does
      // not delay readiness; the weekly cron keeps it current thereafter.
      void resolver.refresh().catch((err: unknown) => logError(ctx.logger, null, err));
      new JobManager(ctx.resolve(TOKENS.JobMap), ctx.logger).scheduleRecurring(
        DEFAULT_MODEL_REFRESH_JOB_KEY,
        DEFAULT_MODEL_REFRESH_CRON,
        () => resolver.refresh().catch((err: unknown) => logError(ctx.logger, null, err)),
      );
    },

    events: {
      messageCreate: async (ctx, message) => {
        const { service: llmService, registry, logger } = requireRuntime();
        if (message.author.bot || message.guildId === null) return;
        const repos = registry.getRepos(message.guildId);
        if (repos === undefined) return;

        // findByUserId returns Result<UserApiSettingDoc | undefined,
        // DatabaseError>. An `err` is re-thrown so it propagates to the
        // dispatcher's catch.
        const userDocResult = await repos.userApiSetting.findByUserId(message.author.id);
        if (!userDocResult.ok) throw userDocResult.error;
        const userDoc = userDocResult.value as UserApiDoc | undefined;
        if (userDoc === undefined || userDoc === null) return; // not whitelisted

        // Case 1: @-mention -> new session. `ignoreRepliedUser` is
        // critical so a reply to the bot does not get classed as a
        // fresh @-tag. Case 2: a reply to a bot message belonging to an
        // active session continues that session.
        const refId = message.reference?.messageId;
        const isNew = message.mentions.has(config.clientId, { ignoreRepliedUser: true });
        const userId = message.author.id;
        if (isNew) {
          if (stripMention(message.content, config.clientId).length === 0) return;
        } else {
          if (refId === undefined || message.content.trim().length === 0) return;
          const session = sessions.resolveSessionByBotMessage(refId);
          if (session === undefined || session.userId !== userId) return;
        }

        const exempt = config.isAdmin(userId);
        if (!exempt) {
          const gate = await gateChatRequest(
            repos.aiUsage,
            inFlight,
            userId,
            ctx.clock.now(),
            config.policy.rateLimit,
          );
          if (!gate.ok) throw gate.error;
          if (gate.value.kind !== 'admitted') {
            const content =
              gate.value.kind === 'busy'
                ? ctx.translator.t('replies:llm_chat.busy')
                : ctx.translator.t('replies:llm_chat.rate_limited', {
                    at: `<t:${String(Math.ceil(gate.value.retryAt / 1000))}:R>`,
                  });
            await message.reply({ content, allowedMentions: NO_MENTIONS });
            return;
          }
        }
        const model = exempt ? userDoc : effectiveModel(config.policy, userDoc);
        const settings = toSettings(userDoc, model);

        if (exempt) inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
        try {
          if (isNew) {
            await handleNewSession(
              message,
              settings,
              sessions,
              llmService,
              logger,
              config.clientId,
              ctx.translator,
            );
          } else if (refId !== undefined) {
            await handleContinueSession(
              message,
              refId,
              settings,
              sessions,
              llmService,
              logger,
              ctx.translator,
            );
          }
        } finally {
          releaseChatRequest(inFlight, userId);
        }
      },
    },
  };
};

const sendPlaceholder = async (message: Message, translator: Translator): Promise<Message> =>
  (await message.reply({
    content: translator.t('replies:llm_chat.thinking'),
    allowedMentions: NO_MENTIONS,
  })) as Message;

const handleNewSession = async (
  message: Message,
  settings: LLMSettings,
  sessions: SessionManager,
  llmService: LLMService,
  logger: Logger | undefined,
  clientId: string,
  translator: Translator,
): Promise<void> => {
  const userText = stripMention(message.content, clientId);
  if (userText.length === 0) return;

  const userMsg: LLMMessage = { role: 'user', content: userText };
  const placeholder = await sendPlaceholder(message, translator);

  const chatResult = await llmService.chat([userMsg], settings);
  if (!chatResult.ok) {
    await handleChatError(chatResult.error, logger, message.guildId, placeholder, translator);
    return;
  }
  const result: LLMResult = chatResult.value;

  // Create the session before the user can send a follow-up so
  // back-to-back messages do not race the session table.
  sessions.startSession(message.author.id, message.guildId as string, message.channelId);

  const finalText = appendUsageFooter(result, settings.model, translator);
  const botMsgs = await deliverChunked(message, placeholder, finalText);
  const assistantMsg: LLMMessage = { role: 'assistant', content: result.content };
  sessions.appendToHistory(
    message.author.id,
    message.channelId,
    userMsg,
    assistantMsg,
    botMsgs.map((m) => m.id),
  );
};

const handleContinueSession = async (
  message: Message,
  refBotMessageId: string,
  settings: LLMSettings,
  sessions: SessionManager,
  llmService: LLMService,
  logger: Logger | undefined,
  translator: Translator,
): Promise<void> => {
  const session = sessions.resolveSessionByBotMessage(refBotMessageId);
  if (session === null || session === undefined) return;
  // Only the session owner can continue — prevents hijacking by a
  // bystander replying to the bot.
  if (session.userId !== message.author.id) return;

  const userText = message.content.trim();
  if (userText.length === 0) return;

  const userMsg: LLMMessage = { role: 'user', content: userText };
  const history = [...session.history, userMsg];
  const placeholder = await sendPlaceholder(message, translator);

  const chatResult = await llmService.chat(history, settings);
  if (!chatResult.ok) {
    await handleChatError(chatResult.error, logger, message.guildId, placeholder, translator);
    return;
  }
  const result: LLMResult = chatResult.value;

  const finalText = appendUsageFooter(result, settings.model, translator);
  const botMsgs = await deliverChunked(message, placeholder, finalText);
  const assistantMsg: LLMMessage = { role: 'assistant', content: result.content };
  sessions.appendToHistory(
    session.userId,
    session.channelId,
    userMsg,
    assistantMsg,
    botMsgs.map((m) => m.id),
  );
};
