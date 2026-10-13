/**
 * Behaviour coverage for `/role_message`, the admin command that posts
 * the self-service role-claim panel.
 *
 * Two invariants carry real consequences and are pinned here: the
 * ManageRoles gate (the panel hands out roles, so an unprivileged caller
 * must never reach the builder), and the customId the buttons carry —
 * `toggle_role|<roleId>` is the contract the `toggle_role` button
 * handler parses, so a change on either side silently breaks the panel.
 */
import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import RoleMessage from '../../../../src/handlers/commands/role_message/action';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../../fixtures/discord/guild-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';

interface BuildInput {
  /** Raw `roles` option text, as Discord delivers it. */
  readonly roles: string;
  readonly canManageRoles?: boolean;
  /** Roles the guild actually resolves; positions default to 1. */
  readonly existingRoles?: readonly {
    readonly id: string;
    readonly name: string;
    readonly position?: number;
    readonly permissions?: readonly bigint[];
  }[];
  readonly inGuild?: boolean;
  /** Position of the caller's highest role. */
  readonly callerPosition?: number;
}

const build = ({
  roles,
  canManageRoles = true,
  existingRoles = [
    { id: ROLE_A, name: 'Alpha' },
    { id: ROLE_B, name: 'Beta' },
  ],
  inGuild = true,
  callerPosition = 5,
}: BuildInput) => {
  const guild = buildGuild({
    id: 'g1',
    roles: buildGuildRoles({ roles: existingRoles }),
    me: buildGuildMember({ id: 'bot', highestRolePosition: 10 }),
  });
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    deferred: true,
    replied: false,
    guild: inGuild ? guild : null,
    member: {
      id: 'caller',
      roles: { highest: { position: callerPosition } },
      permissions: { has: (flag: string) => canManageRoles && flag === 'ManageRoles' },
    },
    options: { get: (name: string) => (name === 'roles' ? { value: roles } : undefined) },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, editReply };
};

const run = async (input: BuildInput) => {
  const { interaction, editReply } = build(input);
  const { bot } = buildFakeBot();
  await new RoleMessage().execute(interaction, bot);
  return editReply;
};

describe('role_message', () => {
  it('renders one toggle_role button per mentioned role, keyed by role id', async () => {
    const editReply = await run({ roles: `<@&${ROLE_A}> <@&${ROLE_B}>` });

    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as {
      content: string;
      components: { components: { data: { custom_id?: string; label?: string } }[] }[];
    };
    expect(payload.content).toBe('replies:role_message.prompt');
    const buttons = payload.components.flatMap((row) => row.components.map((c) => c.data));
    expect(buttons.map((b) => b.custom_id)).toEqual([
      `toggle_role|${ROLE_A}`,
      `toggle_role|${ROLE_B}`,
    ]);
    expect(buttons.map((b) => b.label)).toEqual(['Alpha', 'Beta']);
  });

  it('refuses a caller without ManageRoles and builds no panel', async () => {
    const editReply = await run({ roles: `<@&${ROLE_A}>`, canManageRoles: false });

    expect(editReply).toHaveBeenCalledWith({ content: 'replies:role_message.no_permission' });
  });

  it('rejects an option that is not a list of role mentions', async () => {
    const editReply = await run({ roles: 'Alpha, Beta' });

    expect(editReply).toHaveBeenCalledWith({ content: 'replies:role_message.format_error' });
  });

  it('names the role it could not resolve rather than posting a dead button', async () => {
    const editReply = await run({
      roles: `<@&${ROLE_A}> <@&${ROLE_B}>`,
      existingRoles: [{ id: ROLE_A, name: 'Alpha' }],
    });

    expect(editReply).toHaveBeenCalledWith({
      content: 'replies:role_message.role_not_found',
    });
  });

  it('answers guild_not_found outside a guild', async () => {
    const editReply = await run({ roles: `<@&${ROLE_A}>`, inGuild: false });

    expect(editReply).toHaveBeenCalledWith({ content: 'errors:command.guild_not_found' });
  });

  it('refuses a role that grants a moderation permission', async () => {
    const editReply = await run({
      roles: `<@&${ROLE_A}>`,
      existingRoles: [
        { id: ROLE_A, name: 'Mods', permissions: [PermissionFlagsBits.ModerateMembers] },
      ],
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:role_message.role_not_assignable' }),
    );
  });

  it("refuses a role at or above the caller's highest role", async () => {
    const editReply = await run({
      roles: `<@&${ROLE_A}>`,
      existingRoles: [{ id: ROLE_A, name: 'Senior', position: 5 }],
      callerPosition: 5,
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:role_message.role_not_assignable' }),
    );
  });

  it('refuses a role the bot cannot manage', async () => {
    const editReply = await run({
      roles: `<@&${ROLE_A}>`,
      existingRoles: [{ id: ROLE_A, name: 'Above bot', position: 10 }],
      callerPosition: 20,
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:role_message.role_not_assignable' }),
    );
  });
});
