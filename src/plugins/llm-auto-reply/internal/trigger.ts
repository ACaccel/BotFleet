/**
 * Bot-mention trigger handling for the LLM auto-reply plugin.
 *
 * A message that @-mentions the bot fires a reply deterministically,
 * bypassing the random probability gate (and the cooldown / in-flight /
 * window guards), mirroring konata's llm-chat trigger. The downstream `messageCount`
 * requirement still applies — a mention only skips the dice roll, not the
 * context check. The probabilistic automatic reply is unaffected.
 *
 * The mention token is a control marker, not conversation, so it is stripped
 * from a message's transcript content before the prompt is built.
 */
import type { Message } from 'discord.js';

/**
 * Whether `message` @-mentions the bot. Mirrors llm-chat: `ignoreRepliedUser`
 * is set so a *reply* to one of the bot's messages (which auto-mentions it)
 * is NOT treated as a fresh @-tag — only an explicit mention triggers.
 */
export const mentionsBot = (message: Message, clientId: string): boolean =>
  message.mentions.has(clientId, { ignoreRepliedUser: true });

/**
 * Remove the bot's mention token (`<@id>` / `<@!id>`) from `content` so the
 * control marker never reaches the LLM prompt. Only the bot's own mention is
 * stripped; mentions of other users pass through unchanged. Mirrors
 * llm-chat's `stripMention`.
 */
export const stripBotMention = (content: string, clientId: string): string =>
  content.replace(new RegExp(`<@!?${clientId}>`, 'g'), '').trim();
