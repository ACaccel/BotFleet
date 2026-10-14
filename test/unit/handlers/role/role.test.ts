import { ApplicationCommandOptionType, MessageFlags } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Role from '../../../../src/handlers/commands/role';
import RolePanelAction from '../../../../src/handlers/commands/role_message/action';
import TempRoleCreateAction from '../../../../src/handlers/commands/temp_role/action';
import TempRoleListAction from '../../../../src/handlers/commands/temp_role_list/action';
import TempRoleDeleteAction from '../../../../src/handlers/commands/temp_role_delete/action';
import LevelRoleSyncAction from '../../../../src/handlers/commands/update_role/action';
import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const routedInteraction = (group: string | null, name: string) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'role',
    subcommand: name,
    subcommandGroup: group,
    sink,
  });
  return { interaction, sink };
};

afterEach(() => vi.restoreAllMocks());

describe('/role', () => {
  it('keeps member actions accessible and registers the grouped role options', () => {
    const { bot } = buildFakeBot();
    const body = buildCommandJsonBody(localizeCommandConfig(new Role().config, bot.translator));
    expect(body.name).toBe('role');
    expect(body.dm_permission).toBe(false);
    expect(body.default_member_permissions ?? null).toBeNull();
    expect(body.options?.map(({ name, type }) => [name, type])).toEqual([
      ['temp', ApplicationCommandOptionType.SubcommandGroup],
      ['panel', ApplicationCommandOptionType.Subcommand],
      ['sync', ApplicationCommandOptionType.Subcommand],
    ]);
    expect(body.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'panel',
          options: [expect.objectContaining({ name: 'roles', type: 3, required: true })],
        }),
        expect.objectContaining({
          name: 'temp',
          options: [
            expect.objectContaining({
              name: 'create',
              options: [
                expect.objectContaining({
                  name: 'name',
                  type: 3,
                  required: true,
                  min_length: 1,
                  max_length: 90,
                }),
                expect.objectContaining({
                  name: 'days',
                  type: 4,
                  required: false,
                  min_value: 1,
                  max_value: 30,
                }),
              ],
            }),
            expect.objectContaining({ name: 'list' }),
            expect.objectContaining({
              name: 'delete',
              options: [expect.objectContaining({ name: 'role', type: 8, required: true })],
            }),
          ],
        }),
      ]),
    );
  });

  it.each([
    { group: null, name: 'panel', action: RolePanelAction },
    { group: null, name: 'sync', action: LevelRoleSyncAction },
    { group: 'temp', name: 'create', action: TempRoleCreateAction },
    { group: 'temp', name: 'list', action: TempRoleListAction },
    { group: 'temp', name: 'delete', action: TempRoleDeleteAction },
  ])('routes $group/$name to its action', async ({ group, name, action }) => {
    const actions = [
      RolePanelAction,
      LevelRoleSyncAction,
      TempRoleCreateAction,
      TempRoleListAction,
      TempRoleDeleteAction,
    ];
    const spies = actions.map((command) =>
      vi.spyOn(command.prototype, 'execute').mockResolvedValue(undefined),
    );
    const { interaction, sink } = routedInteraction(group, name);
    const { bot } = buildFakeBot();

    await new Role().execute(interaction, bot);

    for (const [index, command] of actions.entries()) {
      if (command === action) expect(spies[index]).toHaveBeenCalledWith(interaction, bot);
      else expect(spies[index]).not.toHaveBeenCalled();
    }
    expect(sink.replies).toEqual([]);
  });

  it.each([
    { group: null, name: 'create' },
    { group: 'temp', name: 'panel' },
    { group: 'unknown', name: 'list' },
  ])('rejects an unknown path privately: $group/$name', async ({ group, name }) => {
    const { interaction, sink } = routedInteraction(group, name);
    const { bot } = buildFakeBot();
    await new Role().execute(interaction, bot);
    expect(sink.replies).toEqual([
      { content: 'errors:command.not_found', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('validates the member role cap through the grouped root', () => {
    const command = new Role();
    expect(() => command.validateBotConfig({})).not.toThrow();
    expect(() => command.validateBotConfig({ temp_role: { maxActivePerMember: 0 } })).toThrow();
  });
});
