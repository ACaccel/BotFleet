import { describe, expect, it } from 'vitest';
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
} from 'discord.js';

import { buildCommandJsonBody } from '../../../src/handlers/commands/command-builder';
import type { LocalizedCommandConfig } from '../../../src/handlers/commands/command';

describe('buildCommandJsonBody', () => {
  it('combines root subcommands with a group and preserves autocomplete', () => {
    const json = buildCommandJsonBody({
      name: 'archive',
      description: 'Archive controls',
      subcommandGroups: [
        {
          name: 'schedule',
          description: 'Schedule',
          subcommands: [{ name: 'status', description: 'Status' }],
        },
      ],
      subcommands: [
        {
          name: 'apply',
          description: 'Apply plan',
          options: {
            string: [{ name: 'run_id', description: 'Run ID', required: true, autocomplete: true }],
          },
        },
      ],
    });
    expect(json.options).toMatchObject([
      { name: 'schedule', type: ApplicationCommandOptionType.SubcommandGroup },
      {
        name: 'apply',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'run_id', autocomplete: true }],
      },
    ]);
  });
  it('rejects root value options beside root subcommands', () => {
    expect(() =>
      buildCommandJsonBody({
        name: 'archive',
        description: 'Archive controls',
        options: { string: [{ name: 'note', description: 'Note', required: false }] },
        subcommands: [{ name: 'audit', description: 'Audit' }],
      }),
    ).toThrow(/subcommands cannot be combined/);
  });

  it('builds guild-only nested subcommands with permissions and numeric bounds', () => {
    const json = buildCommandJsonBody({
      name: 'archive',
      description: 'Manage archive schedules',
      guildOnly: true,
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      subcommandGroups: [
        {
          name: 'schedule',
          description: 'Schedule settings',
          subcommands: [
            { name: 'status', description: 'Show status' },
            {
              name: 'interval',
              description: 'Set interval',
              options: {
                number: [
                  {
                    name: 'minutes',
                    description: 'Interval in minutes',
                    required: true,
                    min: 1,
                    max: 10_080,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(json).toMatchObject({
      dm_permission: false,
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
      options: [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'schedule',
          options: [
            { type: ApplicationCommandOptionType.Subcommand, name: 'status' },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: 'interval',
              options: [
                {
                  type: ApplicationCommandOptionType.Integer,
                  name: 'minutes',
                  required: true,
                  min_value: 1,
                  max_value: 10_080,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('rejects combining root options with a subcommand group', () => {
    expect(() =>
      buildCommandJsonBody({
        name: 'archive',
        description: 'Manage archive schedules',
        options: { string: [{ name: 'note', description: 'A note', required: false }] },
        subcommandGroups: [
          {
            name: 'schedule',
            description: 'Settings',
            subcommands: [{ name: 'status', description: 'Show status' }],
          },
        ],
      }),
    ).toThrow(/subcommands cannot be combined/);
  });

  it('validates autocomplete within nested subcommands', () => {
    expect(() =>
      buildCommandJsonBody({
        name: 'archive',
        description: 'Manage archive schedules',
        subcommandGroups: [
          {
            name: 'schedule',
            description: 'Settings',
            subcommands: [
              {
                name: 'interval',
                description: 'Set interval',
                options: {
                  number: [
                    { name: 'minutes', description: 'Minutes', required: true, autocomplete: true },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/string options only/);
  });
  it('builds a bare chat-input command with name and description', () => {
    const config: LocalizedCommandConfig = {
      name: 'ping',
      description: 'Check latency',
    };

    const json = buildCommandJsonBody(config);

    expect(json.name).toBe('ping');
    expect('description' in json && json.description).toBe('Check latency');
  });

  it('builds a context-menu command without description or options', () => {
    const config: LocalizedCommandConfig = {
      name: 'Report Message',
      description: 'unused for context menus',
      type: ApplicationCommandType.Message,
    };

    const json = buildCommandJsonBody(config);

    expect(json.name).toBe('Report Message');
    expect(json.type).toBe(ApplicationCommandType.Message);
  });

  it('orders required options before optional ones', () => {
    const config: LocalizedCommandConfig = {
      name: 'remind',
      description: 'Set a reminder',
      options: {
        string: [
          { name: 'note', description: 'Optional note', required: false },
          { name: 'when', description: 'When to remind', required: true },
        ],
      },
    };

    const json = buildCommandJsonBody(config);
    const options = 'options' in json ? (json.options ?? []) : [];

    expect(options.map((o) => o.name)).toEqual(['when', 'note']);
  });

  it('renders every supported option kind', () => {
    const config: LocalizedCommandConfig = {
      name: 'configure',
      description: 'Configure settings',
      options: {
        string: [
          {
            name: 'mode',
            description: 'Mode',
            required: true,
            choices: [{ name: 'Fast', value: 'fast' }],
          },
        ],
        number: [{ name: 'count', description: 'Count', required: true, min: 1, max: 9 }],
        float: [{ name: 'ratio', description: 'Ratio', required: false, min: 0, max: 1 }],
        user: [{ name: 'target', description: 'Target user', required: true }],
        channel: [{ name: 'where', description: 'Target channel', required: false }],
        attachment: [{ name: 'file', description: 'A file', required: false }],
      },
    };

    const json = buildCommandJsonBody(config);
    const options = 'options' in json ? (json.options ?? []) : [];

    expect(options.map((o) => o.name).sort()).toEqual(
      ['count', 'file', 'mode', 'ratio', 'target', 'where'].sort(),
    );
  });

  it('marks a string option autocomplete so Discord queries the handler hook', () => {
    const config: LocalizedCommandConfig = {
      name: 'feed_unsubscribe',
      description: 'Stop forwarding posts',
      options: {
        string: [{ name: 'account', description: 'Account', required: false, autocomplete: true }],
      },
    };

    const json = buildCommandJsonBody(config);
    const options = 'options' in json ? (json.options ?? []) : [];

    // Read off the REST payload rather than the config: `setAutocomplete`
    // is the only thing that makes Discord send the interaction at all,
    // and a builder that dropped the call would look identical upstream.
    expect(options[0]).toMatchObject({ name: 'account', autocomplete: true });
  });

  it('leaves autocomplete off an option that did not ask for it', () => {
    const config: LocalizedCommandConfig = {
      name: 'remind',
      description: 'Set a reminder',
      options: { string: [{ name: 'note', description: 'Note', required: false }] },
    };

    const json = buildCommandJsonBody(config);
    const options = 'options' in json ? (json.options ?? []) : [];

    expect(options[0]).not.toHaveProperty('autocomplete', true);
  });

  it('rejects a string option carrying both choices and autocomplete', () => {
    // Discord answers this combination with an opaque 400 at deploy
    // time, naming neither the command nor the option.
    const config: LocalizedCommandConfig = {
      name: 'feed_unsubscribe',
      description: 'Stop forwarding posts',
      options: {
        string: [
          {
            name: 'account',
            description: 'Account',
            required: false,
            autocomplete: true,
            choices: [{ name: 'One', value: 'one' }],
          },
        ],
      },
    };

    expect(() => buildCommandJsonBody(config)).toThrow(TypeError);
    expect(() => buildCommandJsonBody(config)).toThrow(/mutually exclusive/);
  });

  it('rejects autocomplete on an option kind Discord does not support it on', () => {
    const config: LocalizedCommandConfig = {
      name: 'remind',
      description: 'Set a reminder',
      options: {
        number: [{ name: 'count', description: 'Count', required: false, autocomplete: true }],
      },
    };

    expect(() => buildCommandJsonBody(config)).toThrow(/string options only/);
  });
});
