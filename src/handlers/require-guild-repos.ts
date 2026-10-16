import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';

import { asGuildId } from '../core/ids';
import type { TranslationKey, TranslationParams } from '../core/i18n';
import { logSystem, ops } from '../core/logger';
import { isExpiredInteractionError } from '../infra/discord/expired-interaction';
import type { Repos } from '../persistence/repositories';

/**
 * Interactions that can both be replied/edited to.
 *
 * This helper centralises the null-check-then-reply guard every handler
 * needs, and folds in the disabled-guild distinction so operators see a
 * useful message instead of a generic `errors:db.not_found`.
 */
type RepliableHandlerInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction
  | ContextMenuCommandInteraction;

const replyOrEdit = async (
  bot: BaseBot,
  interaction: RepliableHandlerInteraction,
  content: string,
): Promise<void> => {
  if (content.length === 0) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (err) {
    if (isExpiredInteractionError(err)) {
      // The interaction is gone. Log once and swallow — there is
      // nothing else we can tell the user, and re-throwing would
      // just walk into the dispatcher's catch and try the same
      // reply again. The structured log preserves the trail.
      logSystem(bot.logger, ops.router.replySkipped(err.code));
      return;
    }
    throw err;
  }
};

/**
 * Outcome of resolving a guild's `Repos` bundle.
 *
 * A refusal carries its own catalog key and params rather than a code
 * the caller maps, so every surface answers the same situation with the
 * same words. The three ways it can fail are not separately
 * discriminated: the only caller that cannot reply discards the reason
 * anyway, and a field no one reads is one the compiler cannot tell you
 * has gone stale.
 */
type GuildReposLookup =
  | { readonly kind: 'ready'; readonly repos: Repos }
  | {
      readonly kind: 'unavailable';
      readonly key: TranslationKey;
      readonly params?: TranslationParams;
    };

/**
 * Resolve the guild's `Repos` bundle without touching the interaction.
 *
 * {@link requireGuildRepos} is built on this. The split exists for the
 * interaction kinds that cannot be replied to at all — an autocomplete
 * interaction answers with suggestions or with nothing — where those
 * reply branches are not merely unwanted but unreachable. One shared
 * resolution keeps the two from disagreeing about what "available"
 * means.
 */
export const lookupGuildRepos = (bot: BaseBot, guildId: string | undefined): GuildReposLookup => {
  if (guildId === undefined) {
    return { kind: 'unavailable', key: 'errors:command.guild_only' };
  }

  // Read the disabled state straight from the ConnectionManager: it
  // owns retry / transient-vs-persistent classification and stamps the
  // `traceId`, so `isDisabled` is the single source of truth. The
  // `traceId` surfaced here is exactly the one written to the
  // structured boot log, letting operators correlate a support ticket
  // ("got error xxxxxx") with the originating connection failure via
  // `grep traceId=<id>`.
  const disabled = bot.connectionManager?.isDisabled(asGuildId(guildId));
  if (disabled !== undefined) {
    return {
      kind: 'unavailable',
      key: 'errors:db.guild_disabled',
      params: { traceId: disabled.traceId },
    };
  }

  const repos = bot.getRepos(guildId);
  if (repos === undefined) {
    return { kind: 'unavailable', key: 'errors:db.not_found' };
  }
  return { kind: 'ready', repos };
};

/**
 * Resolve the guild's `Repos` bundle or reply to the user with the
 * most accurate error message available and return null.
 *
 * Returns `null` (not `undefined`) so the caller can use an
 * unambiguous early-return guard:
 *
 * ```ts
 * const repos = await requireGuildRepos(bot, interaction);
 * if (repos === null) return;
 * ```
 *
 * Handlers stay ignorant of the transient/persistent split behind
 * {@link lookupGuildRepos} and see only the resolved `Repos` — or an
 * already-sent reply.
 */
export const requireGuildRepos = async (
  bot: BaseBot,
  interaction: RepliableHandlerInteraction,
): Promise<Repos | null> => {
  const lookup = lookupGuildRepos(bot, interaction.guild?.id);
  if (lookup.kind === 'ready') return lookup.repos;
  await replyOrEdit(bot, interaction, bot.translator?.t(lookup.key, lookup.params) ?? '');
  return null;
};
