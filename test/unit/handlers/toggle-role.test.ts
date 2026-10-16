/**
 * Unit tests for the `toggle_role` button handler after i18n routing.
 *
 * Covers the three reply branches: role missing, role added, role
 * removed. The handler reads `bot.translator`; the fake returns the key
 * so the test can assert which catalog string each branch selects.
 */
import { describe, expect, it } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import toggle_role from '../../../src/handlers/buttons/toggle_role';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import { buildGuild, buildGuildRoles } from '../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';
import { buildGuildMember, buildMemberRoles } from '../../fixtures/discord/member-builder';

const ROLE_ID = 'role-1';

const { bot } = buildFakeBot();

/**
 * Build the interaction plus the role spies the assertions read. `role`
 * absent means the guild no longer resolves it — the role_not_found
 * branch.
 */
const build = (opts: {
  readonly memberHasRole: boolean;
  readonly roleExists: boolean;
  readonly rolePermissions?: readonly bigint[];
}) => {
  const memberRoles = buildMemberRoles();
  const member = buildGuildMember({
    roleIds: opts.memberHasRole ? [ROLE_ID] : [],
    roles: memberRoles,
  });
  const guild = buildGuild({
    roles: buildGuildRoles({
      roles: opts.roleExists
        ? [{ id: ROLE_ID, name: 'Notify', permissions: opts.rolePermissions }]
        : [],
    }),
    me: buildGuildMember({ id: 'bot', highestRolePosition: 10 }),
  });
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: `toggle_role|${ROLE_ID}`,
    guild,
    member,
    sink,
  });
  return { interaction, memberRoles, sink };
};

describe('toggle_role button handler', () => {
  it('replies role_not_found when the role no longer exists', async () => {
    const { interaction, memberRoles, sink } = build({ memberHasRole: false, roleExists: false });

    await new toggle_role().execute(interaction, bot);

    expect(sink.replies).toEqual([
      { content: 'replies:toggle_role.role_not_found', flags: MessageFlags.Ephemeral },
    ]);
    expect(memberRoles.add).not.toHaveBeenCalled();
    expect(memberRoles.remove).not.toHaveBeenCalled();
  });

  it('removes the role and confirms when the member already has it', async () => {
    const { interaction, memberRoles, sink } = build({ memberHasRole: true, roleExists: true });

    await new toggle_role().execute(interaction, bot);

    expect(memberRoles.remove).toHaveBeenCalledWith(ROLE_ID);
    expect(memberRoles.add).not.toHaveBeenCalled();
    expect(sink.replies).toEqual([
      { content: 'replies:toggle_role.removed', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('adds the role and confirms when the member lacks it', async () => {
    const { interaction, memberRoles, sink } = build({ memberHasRole: false, roleExists: true });

    await new toggle_role().execute(interaction, bot);

    expect(memberRoles.add).toHaveBeenCalledWith(ROLE_ID);
    expect(memberRoles.remove).not.toHaveBeenCalled();
    expect(sink.replies).toEqual([
      { content: 'replies:toggle_role.added', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('refuses a role that has since gained a dangerous permission', async () => {
    const { interaction, memberRoles, sink } = build({
      memberHasRole: false,
      roleExists: true,
      rolePermissions: [PermissionFlagsBits.Administrator],
    });

    await new toggle_role().execute(interaction, bot);

    expect(memberRoles.add).not.toHaveBeenCalled();
    expect(memberRoles.remove).not.toHaveBeenCalled();
    expect(sink.replies).toEqual([
      { content: 'replies:toggle_role.role_not_assignable', flags: MessageFlags.Ephemeral },
    ]);
  });
});
