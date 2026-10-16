/**
 * Shared "translate then ephemeral reply" helper used by every
 * dispatcher (commands / buttons / modals / select-menus):
 *
 *   1. Resolve the i18n key via the (optionally bound) Translator —
 *      `BaseBot.translator` is `Translator | undefined` until `run()`
 *      finishes wiring it, though it is always bound in handler context.
 *   2. Skip the reply when the resolved string is empty (the translator
 *      was never bound, i.e. a dispatcher ran before `BaseBot.run()`).
 *   3. Always `await` the resulting promise so a `followUp` fallback
 *      can detect already-replied state (the handler-boundary contract).
 *
 * Returns `Promise<void>` rather than the discord.js `InteractionResponse`
 * because no call site uses the return value.
 */
import type { ContextMenuCommandInteraction, RepliableInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { Translator } from '../core/i18n';

/**
 * `executeCommand` is typed against the abstract
 * `ContextMenuCommandInteraction` base class (Chat + ContextMenu),
 * which is wider than the concrete `User|Message` subclasses that
 * `RepliableInteraction` lists. The base lacks `targetUser` /
 * `targetMember` so structural assignability fails. Widen the helper
 * to accept either form — every value at runtime carries `.reply(...)`.
 */
type DispatcherInteraction = RepliableInteraction | ContextMenuCommandInteraction;

export const replyTranslated = async (
  interaction: DispatcherInteraction,
  translator: Translator | undefined,
  key: string,
  params?: Record<string, string | number>,
): Promise<void> => {
  const content = translator?.t(key, params) ?? '';
  if (content.length === 0) return;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
};
