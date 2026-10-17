/**
 * `/feed unsubscribe`'s autocomplete hook: which of the channel's
 * subscribed targets to offer for the `target` option.
 *
 * A database read and nothing else. The upstream platform is never
 * consulted — an autocomplete response is due within three seconds of
 * a keystroke, and the answer is already stored: the option names
 * accounts *this guild subscribed*, not accounts that exist.
 *
 * Scope mirrors what the command would delete if sent now (the `channel`
 * option, else the invoking channel, narrowed by `platform`), so nothing
 * suggested is then refused or missed.
 *
 * The command's visibility gate applies here too, so a channel the invoker
 * cannot see does not leak its subscriptions through the dropdown; the
 * refusal is silent because autocomplete cannot explain itself.
 */
import type { AutocompleteInteraction } from 'discord.js';
import type { BaseBot } from '@bot';

import { bindTranslator } from '../../../core/i18n';
import { logSystem, ops } from '../../../core/logger';
import { getOptionalString } from '../../../infra/discord/options';
import { gateFeedChannel } from '../../feed-channel-gate';
import { lookupGuildRepos } from '../../require-guild-repos';
import type { CommandSuggestions } from '../command';
import { buildAccountSuggestions } from './account-suggestions';

/**
 * Suggestions for the focused `target` segment, or an empty list.
 *
 * Every unusable state — a DM, a guild with no database, a channel the
 * invoker cannot view, a failed read — resolves to no suggestions
 * rather than an error. The member simply sees nothing to pick, and the
 * command itself still explains the situation properly when they send
 * it.
 */
export const suggestUnsubscribeAccounts = async (
  interaction: AutocompleteInteraction,
  bot: BaseBot,
): Promise<CommandSuggestions> => {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'target') return [];

  const guild = interaction.guild;
  if (guild === null) return [];
  const lookup = lookupGuildRepos(bot, guild.id);
  if (lookup.kind !== 'ready') return [];

  // `options.getChannel` is unavailable on an autocomplete interaction
  // — Discord resolves entities only once the command is submitted —
  // so the raw option value is read instead, which for a channel option
  // is its id.
  const chosenChannelId = getOptionalString(interaction, 'channel');
  const gate = gateFeedChannel(
    guild,
    chosenChannelId ?? interaction.channelId,
    interaction.user.id,
  );
  if (gate.kind !== 'visible') return [];

  const stored = await lookup.repos.feedSubscription.listByChannel(gate.channel.id);
  if (!stored.ok) {
    // Info, not error, and not a throw: this fires once per keystroke,
    // so a degraded connection would otherwise either spam the error
    // log or — the worse failure — leave an operator with no signal at
    // all while every member's suggestions silently went empty.
    logSystem(bot.logger, ops.feed.suggestionsUnavailable(gate.channel.id, stored.error.code));
    return [];
  }

  return buildAccountSuggestions(
    stored.value,
    { platform: getOptionalString(interaction, 'platform'), focused: focused.value },
    bindTranslator(bot.translator),
  );
};
