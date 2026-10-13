import { ChannelType } from 'discord.js';
import type { SlashCommandBuilder, SlashCommandSubcommandBuilder } from '@discordjs/builders';
import type { LocalizedCommandConfig, LocalizedCommandOption } from './command';

/**
 * Reject option metadata Discord will not accept on the declared type:
 * `autocomplete` and length bounds on non-string options, value bounds
 * on non-numeric ones, and `autocomplete` alongside `choices`.
 *
 * Each is an authoring mistake in a handler's `setConfig` that would
 * otherwise surface as an opaque REST 400 during `npm run register` —
 * with no indication of which option of which command caused it.
 * Failing here catches them in the unit suite instead, since every
 * registration path funnels through this builder.
 *
 * A native `TypeError`, not a `DomainError`: nothing about this is
 * recoverable at runtime or reportable to a member.
 */
const assertOptionUsable = (
  commandName: string,
  optionType: string,
  option: LocalizedCommandOption,
): void => {
  const fail = (reason: string): never => {
    throw new TypeError(`command "${commandName}" option "${option.name}": ${reason}`);
  };
  if (option.autocomplete === true) {
    if (optionType !== 'string') {
      fail(`autocomplete applies to string options only, not ${optionType}.`);
    }
    if (option.choices !== undefined) fail('choices and autocomplete are mutually exclusive.');
  }
  const hasLength = option.minLength !== undefined || option.maxLength !== undefined;
  if (hasLength && optionType !== 'string') {
    fail(`minLength/maxLength apply to string options only, not ${optionType}.`);
  }
  const hasRange = option.min !== undefined || option.max !== undefined;
  if (hasRange && optionType !== 'integer' && optionType !== 'float') {
    fail(`min/max apply to integer and float options only, not ${optionType}.`);
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
          .addChannelTypes(...(e.channelTypes ?? channelTypes)),
      ),

    string: (e: LocalizedCommandOption) =>
      builder.addStringOption((o) => {
        o.setName(e.name).setDescription(e.description).setRequired(e.required);
        if (e.choices) {
          o.addChoices(...e.choices);
        }
        if (e.autocomplete === true) o.setAutocomplete(true);
        if (typeof e.minLength === 'number') o.setMinLength(e.minLength);
        if (typeof e.maxLength === 'number') o.setMaxLength(e.maxLength);
        return o;
      }),

    integer: (e: LocalizedCommandOption) =>
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

    boolean: (e: LocalizedCommandOption) =>
      builder.addBooleanOption((o) =>
        o.setName(e.name).setDescription(e.description).setRequired(e.required),
      ),

    role: (e: LocalizedCommandOption) =>
      builder.addRoleOption((o) =>
        o.setName(e.name).setDescription(e.description).setRequired(e.required),
      ),

    attachment: (e: LocalizedCommandOption) =>
      builder.addAttachmentOption((o) =>
        o.setName(e.name).setDescription(e.description).setRequired(e.required),
      ),
  } as const satisfies Record<
    keyof NonNullable<LocalizedCommandConfig['options']>,
    (e: LocalizedCommandOption) => unknown
  >;

  // Discord requires required options to precede optional ones.
  const allOptions: { type: keyof typeof optionHandlers; data: LocalizedCommandOption }[] = [];
  for (const [type, entries] of Object.entries(options)) {
    const handler = optionHandlers[type as keyof typeof optionHandlers];
    if (!handler) continue;

    entries.forEach((opt) => {
      assertOptionUsable(commandName, type, opt);
      allOptions.push({ type: type as keyof typeof optionHandlers, data: opt });
    });
  }

  allOptions
    .sort((a, b) => Number(b.data.required) - Number(a.data.required))
    .forEach(({ type, data }) => {
      optionHandlers[type](data);
    });
};
