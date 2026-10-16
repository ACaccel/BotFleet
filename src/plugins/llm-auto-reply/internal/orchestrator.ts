/**
 * Orchestrates a single LLM auto-reply attempt once the plugin's cheap
 * guards have passed and either the probability gate fired or the message
 * @-mentioned the bot.
 *
 * Sequence: fetch the latest N messages -> require exactly N -> require they
 * form a tight burst within the window (skipped for an @-mention) -> build
 * the transcript (bot/blank lines dropped, the bot's mention stripped) ->
 * call the self-hosted LLM -> post one reply. Any short-circuit returns
 * silently; an LLM failure is logged but never surfaced to the channel.
 *
 * Returns `true` iff a reply was actually posted, so the caller records the
 * per-channel cooldown only when a message really went out.
 */
import type { Message } from 'discord.js';

import { logError, type Logger } from '../../../core/logger';
import type { SelfHostedLlmClient } from '../../../infra/llm';
import type { LlmAutoReplyPluginConfig } from '../config';
import { buildTranscript, isWithinWindow, type TranscriptMessage } from './transcript';
import { clampReply } from './reply';
import { mentionsBot, stripBotMention } from './trigger';

/**
 * Collaborators for {@link runLlmAutoReply}. `client` is narrowed to the
 * single method used so tests can inject a fake without the HTTP layer.
 */
export interface RunLlmAutoReplyDeps {
  readonly client: Pick<SelfHostedLlmClient, 'reply'>;
  readonly logger: Logger;
  readonly config: Pick<LlmAutoReplyPluginConfig, 'messageCount' | 'windowSeconds'>;
  /** Bot client id — drives @-mention detection and mention-stripping. */
  readonly clientId: string;
}

/** Mentions are stripped so an LLM-authored reply cannot ping @everyone/@role. */
const NO_MENTIONS = { parse: [] as const };

export const runLlmAutoReply = async (
  deps: RunLlmAutoReplyDeps,
  message: Message,
): Promise<boolean> => {
  const channel = message.channel;
  // The plugin already guarded `isSendable()`; re-narrow here so both
  // `messages.fetch` and `send` are statically typed for this scope.
  if (!channel.isTextBased() || !channel.isSendable()) return false;

  const fetched = await channel.messages
    .fetch({ limit: deps.config.messageCount })
    .catch((e: unknown) => {
      // A genuine fetch failure (missing access/permissions, rate limit,
      // transient network) must stay observable — unlike the by-design
      // `size < N` short-circuit below, which is silent. Mirrors the
      // reply-error branch further down.
      logError(deps.logger, message.guildId, e);
      return null;
    });
  // Require exactly N: a quiet/new channel that cannot supply N recent
  // messages lacks enough context to be worth interrupting.
  if (fetched === null || fetched.size < deps.config.messageCount) return false;

  // discord.js returns newest -> oldest; reverse to chronological order.
  const chronological = [...fetched.values()].reverse();
  // An @-mention skips the burst-window requirement: the user explicitly
  // asked for a reply, so the recent N messages are used as context
  // regardless of how spread out in time they are. The messageCount
  // requirement above still applies.
  const forced = mentionsBot(message, deps.clientId);
  const windowMs = deps.config.windowSeconds * 1000;
  if (
    !forced &&
    !isWithinWindow(
      chronological.map((m) => m.createdTimestamp),
      windowMs,
    )
  )
    return false;

  const items: readonly TranscriptMessage[] = chronological.map((m) => ({
    // Global display name only (User.displayName = globalName ?? username);
    // deliberately NOT m.member.displayName, which would be the guild nickname.
    displayName: m.author.displayName,
    // Strip the bot's @-mention so the control marker never reaches the
    // prompt; mentions of other users pass through unchanged.
    content: stripBotMention(m.content, deps.clientId),
    createdTimestamp: m.createdTimestamp,
    isBot: m.author.bot,
  }));
  const transcript = buildTranscript(items);
  if (transcript.length === 0) return false; // only bot/blank messages remained

  const result = await deps.client.reply(transcript);
  if (!result.ok) {
    // An auto-reply that fails stays silent; the typed error is logged.
    logError(deps.logger, message.guildId, result.error);
    return false;
  }
  // A blank reply has nothing to post and would make `send` reject; an
  // over-long reply would too, so clamp it to Discord's per-message limit.
  if (result.value.trim().length === 0) return false;
  await channel.send({ content: clampReply(result.value), allowedMentions: NO_MENTIONS });
  return true;
};
