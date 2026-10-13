/**
 * Behaviour coverage for the `delete_reply` select-menu handler.
 *
 * The selected value is a database id and the handler deletes on it, so
 * the two failure modes that matter are deleting a row that is already
 * gone (must answer, not throw) and a repo error (must propagate to the
 * dispatcher's catch rather than be swallowed into a success reply).
 */
import type { StringSelectMenuInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import delete_reply from '../../../../src/handlers/select-menus/delete_reply';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { Repos } from '../../../../src/persistence/repositories';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';

const GUILD_ID = 'g-1';
const RECORD_ID = 'row-7';

const dbErr = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));

interface ReplyRepoInput {
  /** The row `findById` resolves; `undefined` means already deleted. */
  readonly row?: { readonly input: string; readonly reply: string; readonly created_by?: string };
  readonly findFails?: boolean;
  readonly deleteFails?: boolean;
  /** Whether the clicker can manage messages. */
  readonly manager?: boolean;
}

const OWN_ROW = { input: 'ping', reply: 'pong', created_by: 'u-1' };

const build = (input: ReplyRepoInput = { row: OWN_ROW }) => {
  const deleteById = vi.fn(async () => (input.deleteFails === true ? dbErr() : ok(true)));
  const repos = {
    reply: {
      findById: vi.fn(async () => (input.findFails === true ? dbErr() : ok(input.row))),
      deleteById,
    },
  } as unknown as Repos;

  const { bot } = buildFakeBot({
    isAdmin: () => false,
    translator: echoTranslatorWithParams(),
    connectionManager: undefined,
    getRepos: (guildId: string) => (guildId === GUILD_ID ? repos : undefined),
  });

  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    customId: 'delete_reply|0',
    values: [RECORD_ID],
    user: { id: 'u-1' },
    memberPermissions: { has: () => input.manager === true },
    guild: { id: GUILD_ID },
    guildId: GUILD_ID,
    deferred: false,
    replied: false,
    reply,
    editReply: reply,
  } as unknown as StringSelectMenuInteraction;

  return { bot, interaction, reply, deleteById };
};

describe('delete_reply select menu', () => {
  it('deletes the selected row and confirms with the key and reply text', async () => {
    const { bot, interaction, reply, deleteById } = build();

    await new delete_reply().execute(interaction, bot);

    expect(deleteById).toHaveBeenCalledWith(RECORD_ID);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'replies:delete_reply.deleted:{"key":"ping","reply":"pong"}',
        allowedMentions: { parse: [] },
      }),
    );
  });

  it("refuses another member's reply unless the clicker manages messages", async () => {
    const othersRow = { ...OWN_ROW, created_by: 'someone-else' };
    const refused = build({ row: othersRow });

    await new delete_reply().execute(refused.interaction, refused.bot);

    expect(refused.deleteById).not.toHaveBeenCalled();
    expect(refused.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:delete_reply.none_deletable' }),
    );

    const manager = build({ row: othersRow, manager: true });
    await new delete_reply().execute(manager.interaction, manager.bot);
    expect(manager.deleteById).toHaveBeenCalledWith(RECORD_ID);
  });

  it('answers record_not_found and deletes nothing when the row is already gone', async () => {
    const { bot, interaction, reply, deleteById } = build({ row: undefined });

    await new delete_reply().execute(interaction, bot);

    expect(deleteById).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:delete_reply.record_not_found' }),
    );
  });

  it('propagates a lookup failure instead of reporting a deletion that never happened', async () => {
    const { bot, interaction, deleteById } = build({ findFails: true });

    await expect(new delete_reply().execute(interaction, bot)).rejects.toThrow();
    expect(deleteById).not.toHaveBeenCalled();
  });

  it('propagates a delete failure rather than confirming it', async () => {
    const { bot, interaction, reply } = build({ row: OWN_ROW, deleteFails: true });

    await expect(new delete_reply().execute(interaction, bot)).rejects.toThrow();
    expect(reply).not.toHaveBeenCalled();
  });

  it('stops at the guild guard when the guild has no database hookup', async () => {
    const { bot, interaction, deleteById } = build();
    const interactionElsewhere = {
      ...interaction,
      guild: { id: 'other' },
      guildId: 'other',
    } as unknown as StringSelectMenuInteraction;

    await new delete_reply().execute(interactionElsewhere, bot);

    expect(deleteById).not.toHaveBeenCalled();
  });
});
