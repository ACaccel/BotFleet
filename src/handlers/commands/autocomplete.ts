/**
 * Terminal stage for an `ApplicationCommandAutocomplete` interaction.
 *
 * Separate from `executeCommand` because autocomplete may only `respond`
 * once, within three seconds, and cannot report failure. Every unusable
 * state therefore resolves to an empty list: an unknown command, a missing
 * {@link Command.autocomplete} hook, a hook that threw, or a refused
 * `respond`. Only the last two are logged; the first two are configuration
 * mismatches caught by `command-autocomplete-pairing.test.ts`, and logging
 * them would write a line per keystroke.
 *
 * Hooks return suggestions rather than sending them so Discord's limits are
 * applied here; a payload the API rejects is invisible to the member and
 * easily survives unnoticed.
 */
import type { AutocompleteInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

import { logError, logSystem, ops } from '../../core/logger';
import {
  MAX_AUTOCOMPLETE_CHOICES,
  MAX_AUTOCOMPLETE_FIELD_LENGTH,
} from '../../infra/discord/autocomplete-limits';
import { isExpiredInteractionError } from '../../infra/discord/expired-interaction';

import type { CommandSuggestions } from './command';

/**
 * Cut `suggestions` down to what Discord will accept.
 *
 * Truncation is the backstop, not the design: a hook that can produce
 * an over-long value should drop the candidate itself, because half a
 * value is usually worse than no suggestion. What this guarantees is
 * only that a careless hook cannot turn into a 400 the member never
 * sees.
 */
const boundToDiscordLimits = (suggestions: CommandSuggestions): CommandSuggestions =>
  suggestions.slice(0, MAX_AUTOCOMPLETE_CHOICES).map((choice) => ({
    name: choice.name.slice(0, MAX_AUTOCOMPLETE_FIELD_LENGTH),
    value: choice.value.slice(0, MAX_AUTOCOMPLETE_FIELD_LENGTH),
  }));

/** Record a failure the member will never see, with its cause attached. */
const logFailure = (interaction: AutocompleteInteraction, bot: BaseBot, err: unknown): void => {
  logError(
    bot.logger,
    interaction.guildId,
    new Error(ops.command.autocompleteFailed(interaction.commandName), { cause: err }),
  );
};

/**
 * The hook's suggestions, already bounded — or an empty list if the
 * command has no hook or the hook threw. Never rejects; the caller
 * still has to answer Discord.
 *
 * Bounding happens inside this guard on purpose: a hook returning a
 * malformed choice fails here, where it is classified as the handler
 * defect it is, rather than downstream where it would be filed as a
 * delivery problem.
 */
const collectSuggestions = async (
  interaction: AutocompleteInteraction,
  bot: BaseBot,
): Promise<CommandSuggestions> => {
  try {
    const handler = bot.commandHandlers.get(interaction.commandName);
    const suggestions = (await handler?.autocomplete?.(interaction, bot)) ?? [];
    return boundToDiscordLimits(suggestions);
  } catch (err) {
    // The hook is the handler's own code, so a throw is a defect.
    logFailure(interaction, bot, err);
    return [];
  }
};

/**
 * Answer an autocomplete interaction with the named command's
 * suggestions, or with an empty list when there are none to give.
 *
 * Never rejects, so the middleware chain that called it still runs its
 * remaining stages.
 */
export const executeAutocomplete = async (
  interaction: AutocompleteInteraction,
  bot: BaseBot,
): Promise<void> => {
  const suggestions = await collectSuggestions(interaction, bot);
  try {
    await interaction.respond(suggestions);
  } catch (err) {
    // The two rejections are not the same event. A closed window is
    // routine under load and nobody's defect; anything else — a
    // rejected payload, a revoked token, a rate limit — is a fault that
    // would otherwise be invisible, since this surface has no way to
    // report one to the member.
    if (isExpiredInteractionError(err)) {
      logSystem(bot.logger, ops.command.autocompleteExpired(interaction.commandName, err.code));
      return;
    }
    logFailure(interaction, bot, err);
  }
};
