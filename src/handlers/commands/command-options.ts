import { ChannelType } from 'discord.js';
import type { SlashCommandBuilder, SlashCommandSubcommandBuilder } from '@discordjs/builders';
import type { LocalizedCommandConfig, LocalizedCommandOption } from './command';

/**
 * Reject the two ways `autocomplete` can be declared on an option
 * Discord will not accept it on.
 *
 * Both are authoring mistakes in a handler's `setConfig`, and both
 * would otherwise surface as an opaque REST 400 during `npm run register` —
 * with no indication of which option of which command caused it.
 * Failing here catches them in the unit suite instead, since every
 * registration path funnels through this builder.
 *
 * A native `TypeError`, not a `DomainError`: nothing about this is
 * recoverable at runtime or reportable to a member.
 */
const assertAutocompleteUsable = (
  commandName: string,
  optionType: string,
  option: LocalizedCommandOption,
): void => {
  if (option.autocomplete !== true) return;
  if (optionType !== 'string') {
    throw new TypeError(
      `command "${commandName}" option "${option.name}": autocomplete applies to string options only, not ${optionType}.`,
    );
  }
  if (option.choices !== undefined) {
    throw new TypeError(
      `command "${commandName}" option "${option.name}": choices and autocomplete are mutually exclusive.`,
    );
  }
};

export const addCommandOptions = (
  builder: SlashCommandBuilder | SlashCommandSubcommandBuilder,
  options: LocalizedCommandConfig['options'],
  commandName: string,
): void => {
  if (options === undefined) return;

  const channelTypes = [
    ChannelType.GuildText,
    ChannelType.GuildVoice,
    ChannelType.GuildAnnouncement,
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.GuildStageVoice,
    ChannelType.GuildForum,
  ] as const;

  const optionHandlers = {
    user: (e: LocalizedCommandOption) =>
      builder.addUserOption((o) =>
        o.setName(e.name).setDescription(e.description).setRequired(e.required),
      ),

    channel: (e: LocalizedCommandOption) =>
      builder.addChannelOption((o) =>
        o
          .setName(e.name)
          .setDescription(e.description)
          .setRequired(e.required)
          .addChannelTypes(...channelTypes),
      ),

    string: (e: LocalizedCommandOption) =>
      builder.addStringOption((o) => {
        o.setName(e.name).setDescription(e.description).setRequired(e.required);
        if (e.choices) {
          o.addChoices(...e.choices);
        }
        if (e.autocomplete === true) o.setAutocomplete(true);
        return o;
      }),

    number: (e: LocalizedCommandOption) =>
      builder.addIntegerOption((o) => {
        o.setName(e.name).setDescription(e.description).setRequired(e.required);
        if (typeof e.min === 'number') o.setMinValue(e.min);
        if (typeof e.max === 'number') o.setMaxValue(e.max);
        return o;
      }),

    float: (e: LocalizedCommandOption) =>
      builder.addNumberOption((o) => {
        o.setName(e.name).setDescription(e.description).setRequired(e.required);
        if (typeof e.min === 'number') o.setMinValue(e.min);
        if (typeof e.max === 'number') o.setMaxValue(e.max);
        return o;
      }),

    attachment: (e: LocalizedCommandOption) =>
      builder.addAttachmentOption((o) =>
        o.setName(e.name).setDescription(e.description).setRequired(e.required),
      ),
  } as const;

  // Discord requires required options to precede optional ones.
  const allOptions: { type: keyof typeof optionHandlers; data: LocalizedCommandOption }[] = [];
  for (const [type, entries] of Object.entries(options)) {
    const handler = optionHandlers[type as keyof typeof optionHandlers];
    if (!handler) continue;

    entries.forEach((opt) => {
      assertAutocompleteUsable(commandName, type, opt);
      allOptions.push({ type: type as keyof typeof optionHandlers, data: opt });
    });
  }

  allOptions
    .sort((a, b) => Number(b.data.required) - Number(a.data.required))
    .forEach(({ type, data }) => {
      optionHandlers[type](data);
    });
};
