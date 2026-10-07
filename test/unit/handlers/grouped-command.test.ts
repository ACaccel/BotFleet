import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { Command, type CommandConfig } from '../../../src/handlers/commands/command';
import { GroupedCommand } from '../../../src/handlers/commands/grouped-command';
import '../../../src/handlers/commands';
import { COMMAND_REGISTRY } from '../../../src/handlers/commands/registry.generated';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

class Action extends Command {
  public override execute = vi.fn(async () => undefined);
  public override autocomplete = vi.fn(async () => [{ name: 'Visible result', value: 'result' }]);
  public override validateBotConfig = vi.fn((_config: unknown): void => {});

  constructor(config: CommandConfig = { name: 'action' }) {
    super();
    this.setConfig(config);
  }
}

const request = (name: string | null, group: string | null = null) => ({
  options: {
    getSubcommand: () => name,
    getSubcommandGroup: () => group,
  },
  reply: vi.fn(async () => undefined),
});

const build = () => {
  const rootAction = new Action();
  const groupedAction = new Action();
  const command = new GroupedCommand({
    name: 'example',
    category: 'utility',
    routes: [
      { name: 'list', command: rootAction },
      { group: 'manager', name: 'add', command: groupedAction },
    ],
  });
  return { command, rootAction, groupedAction, bot: buildFakeBot().bot };
};

describe('GroupedCommand routing boundaries', () => {
  it.each([
    ['unknown subcommand', 'obsolete', null],
    ['missing subcommand', null, null],
    ['missing group', 'add', null],
    ['unknown group', 'add', 'obsolete'],
    ['wrong group for root action', 'list', 'manager'],
  ] as const)('rejects %s without executing an action', async (_label, name, group) => {
    const { command, rootAction, groupedAction, bot } = build();
    const interaction = request(name, group);
    await command.execute(interaction as unknown as ChatInputCommandInteraction, bot);
    expect(interaction.reply).toHaveBeenCalledExactlyOnceWith({
      content: 'errors:command.not_found',
      flags: MessageFlags.Ephemeral,
    });
    expect(rootAction.execute).not.toHaveBeenCalled();
    expect(groupedAction.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['obsolete', null],
    [null, null],
    ['add', null],
    ['add', 'obsolete'],
    ['list', 'manager'],
  ] as const)('returns no suggestions for invalid route %s/%s', async (name, group) => {
    const { command, rootAction, groupedAction, bot } = build();
    const interaction = request(name, group);
    expect(command.autocomplete).toBeTypeOf('function');
    const suggestions = await command.autocomplete!(
      interaction as unknown as AutocompleteInteraction,
      bot,
    );
    expect(suggestions).toEqual([]);
    expect(rootAction.autocomplete).not.toHaveBeenCalled();
    expect(groupedAction.autocomplete).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('GroupedCommand startup validation', () => {
  it('validates a shared child once while also validating distinct children', () => {
    const shared = new Action();
    const distinct = new Action();
    const command = new GroupedCommand({
      name: 'example',
      category: 'utility',
      routes: [
        { group: 'manager', name: 'add', command: shared },
        { group: 'manager', name: 'remove', command: shared },
        { name: 'list', command: distinct },
      ],
    });
    const config = { endpoint: 'https://example.test' };
    command.validateBotConfig(config);
    expect(shared.validateBotConfig).toHaveBeenCalledExactlyOnceWith(config);
    expect(distinct.validateBotConfig).toHaveBeenCalledExactlyOnceWith(config);
  });

  it('propagates child configuration failures so invalid roots cannot register silently', () => {
    const { command, groupedAction } = build();
    const failure = new Error('Required configuration is missing');
    groupedAction.validateBotConfig.mockImplementation(() => {
      throw failure;
    });
    expect(() => command.validateBotConfig({})).toThrow(failure);
  });

  it.each([undefined, 'manager'])('rejects ambiguous duplicate routes in group %s', (group) => {
    const route = { name: 'add', ...(group ? { group } : {}) };
    expect(
      () =>
        new GroupedCommand({
          name: 'example',
          category: 'utility',
          routes: [
            { ...route, command: new Action() },
            { ...route, command: new Action() },
          ],
        }),
    ).toThrow(/Duplicate command route/u);
  });

  it('rejects routes referring to child subcommands that do not exist', () => {
    const child = new Action({ name: 'manager', subcommands: [{ name: 'list' }] });
    expect(
      () =>
        new GroupedCommand({
          name: 'example',
          category: 'utility',
          routes: [{ group: 'manager', name: 'add', command: child }],
        }),
    ).toThrow(/Unknown child subcommand/u);
  });
});

describe('consolidated public registry', () => {
  it.each(['feed', 'reply', 'activity', 'giveaway', 'ai', 'thread', 'traffic'] as const)(
    'publishes a usable grouped %s command',
    (name) => {
      const command = new COMMAND_REGISTRY[name]();
      expect(command).toBeInstanceOf(GroupedCommand);
      expect(command.config.name).toBe(name);
      expect(command.config.subcommands?.length).toBeGreaterThan(0);
      expect(command.config.options).toBeUndefined();
    },
  );

  it.each([
    'feed_subscribe',
    'feed_unsubscribe',
    'feed_list',
    'add_reply',
    'delete_reply',
    'list_reply',
    'activity_create',
    'activity_delete',
    'giveaway_create',
    'giveaway_delete',
    'ai_settings',
    'ai_status',
    'ai_whitelist_add',
    'ai_whitelist_remove',
    'ai_whitelist_list',
    'thread_ban',
    'thread_allow',
    'thread_list',
    'thread_claim',
    'thread_manager',
    'traffic_me',
    'traffic_user',
  ])('does not publish the retired %s entry', (name) => {
    expect(COMMAND_REGISTRY).not.toHaveProperty(name);
  });
});
