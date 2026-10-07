/**
 * Unit coverage for `localizeCommandConfig`.
 *
 * Handlers carry no inline CJK command / option / choice metadata: the
 * descriptions are resolved from the `commands` i18n namespace by a key
 * derived from the command + option names.
 */
import { describe, expect, it } from 'vitest';

import { ApplicationCommandType, PermissionFlagsBits } from 'discord.js';

import type { Translator } from '../../../src/core/i18n';
import { localizeCommandConfig, type CommandConfig } from '../../../src/handlers/commands/command';

/** Translator stub that echoes the requested key. */
const echoTranslator = (): Translator =>
  ({
    t: (key: string) => `[${key}]`,
    tStrict: (key: string) => `[${key}]`,
  }) as unknown as Translator;

describe('localizeCommandConfig', () => {
  it('localizes groups, nested subcommands, options, and choices without mutation', () => {
    const config: CommandConfig = {
      name: 'archive',
      guildOnly: true,
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      subcommandGroups: [
        {
          name: 'schedule',
          subcommands: [
            {
              name: 'interval',
              options: {
                string: [{ name: 'preset', required: true, choices: [{ value: 'hourly' }] }],
              },
            },
          ],
        },
      ],
    };
    const snapshot = structuredClone(config);
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.guildOnly).toBe(true);
    expect(localized.defaultMemberPermissions).toBe(PermissionFlagsBits.ManageGuild);
    expect(localized.subcommandGroups?.[0]).toEqual({
      name: 'schedule',
      description: '[commands:archive.groups.schedule.description]',
      subcommands: [
        {
          name: 'interval',
          description: '[commands:archive.groups.schedule.subcommands.interval.description]',
          options: {
            string: [
              {
                name: 'preset',
                required: true,
                description:
                  '[commands:archive.groups.schedule.subcommands.interval.options.preset.description]',
                choices: [
                  {
                    value: 'hourly',
                    name: '[commands:archive.groups.schedule.subcommands.interval.options.preset.choices.hourly]',
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(config).toEqual(snapshot);
  });
  it('resolves a chat-input command description from commands:<name>.description', () => {
    const config: CommandConfig = { name: 'add_reply' };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.name).toBe('add_reply');
    expect(localized.description).toBe('[commands:add_reply.description]');
  });

  it('resolves each option description from commands:<name>.options.<opt>.description', () => {
    const config: CommandConfig = {
      name: 'add_reply',
      options: {
        string: [
          { name: 'keyword', required: true },
          { name: 'reply', required: true },
        ],
      },
    };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.options?.string?.[0]?.description).toBe(
      '[commands:add_reply.options.keyword.description]',
    );
    expect(localized.options?.string?.[1]?.description).toBe(
      '[commands:add_reply.options.reply.description]',
    );
  });

  it('carries the autocomplete flag through to the localised option', () => {
    // Localisation sits between `setConfig` and the REST builder, so a
    // flag it dropped would disable autocomplete with nothing to show
    // for it — the handler still declares the hook, Discord never asks.
    const config: CommandConfig = {
      name: 'feed_unsubscribe',
      options: { string: [{ name: 'account', required: false, autocomplete: true }] },
    };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.options?.string?.[0]?.autocomplete).toBe(true);
  });

  it('resolves a choice label by stable value when the choice carries no name', () => {
    const config: CommandConfig = {
      name: 'emoji_frequency',
      options: {
        string: [{ name: 'frequency', required: false, choices: [{ value: 'asc' }] }],
      },
    };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.options?.string?.[0]?.choices?.[0]).toEqual({
      value: 'asc',
      name: '[commands:emoji_frequency.options.frequency.choices.asc]',
    });
  });

  it('keeps a data-file-sourced choice name verbatim', () => {
    const config: CommandConfig = {
      name: 'change_avatar',
      options: {
        string: [
          {
            name: 'identity',
            required: true,
            choices: [{ name: '高松燈', value: '高松燈' }],
          },
        ],
      },
    };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.options?.string?.[0]?.choices?.[0]).toEqual({
      name: '高松燈',
      value: '高松燈',
    });
  });

  it('resolves a context-menu command name from commands:<id>.name and leaves description empty', () => {
    const config: CommandConfig = {
      name: 'menu_get_avatar',
      type: ApplicationCommandType.User,
    };
    const localized = localizeCommandConfig(config, echoTranslator());
    expect(localized.name).toBe('[commands:menu_get_avatar.name]');
    expect(localized.description).toBe('');
    expect(localized.type).toBe(ApplicationCommandType.User);
  });

  it('does not mutate the input config', () => {
    const config: CommandConfig = { name: 'help' };
    localizeCommandConfig(config, echoTranslator());
    expect(config).toEqual({ name: 'help' });
  });

  it('degrades to empty strings when the translator is unbound', () => {
    const localized = localizeCommandConfig({ name: 'help' }, undefined);
    expect(localized.description).toBe('');
  });
});
