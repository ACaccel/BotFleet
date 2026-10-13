import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import TempRoleList from '../../../../src/handlers/commands/temp_role_list/action';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const role = (roleId: string, expiresAt: number) => ({
  role_id: roleId,
  creator_id: `creator-${roleId}`,
  role_name: '@everyone',
  expires_at: expiresAt,
});

const build = () => {
  const listAll = vi.fn().mockResolvedValue(ok([]));
  const getRepos = vi.fn().mockReturnValue({ tempRole: { listAll } });
  const { bot, logger } = buildFakeBot({ getRepos, translator: echoTranslatorWithParams() });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({ guildId: 'g1', sink });
  return { bot, logger, sink, interaction, listAll, getRepos };
};

describe('/role temp list', () => {
  it('lists role and creator mentions in expiry order without echoing untrusted role names', async () => {
    const input = [role('later', 2_999), role('sooner', 1_001)];
    const { bot, sink, interaction, listAll } = build();
    listAll.mockResolvedValue(ok(input));

    await new TempRoleList().execute(interaction, bot);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.replies).toEqual([]);
    expect(sink.editReplies).toEqual([
      {
        content: [
          'replies:temp_role.list_header:{"count":2}',
          'replies:temp_role.list_line:{"role":"<@&sooner>","creator":"<@creator-sooner>","expiry":"<t:1:R>"}',
          'replies:temp_role.list_line:{"role":"<@&later>","creator":"<@creator-later>","expiry":"<t:2:R>"}',
        ].join('\n'),
      },
    ]);
    expect(input.map((doc) => doc.role_id)).toEqual(['later', 'sooner']);
    expect(sink.editReplies[0]?.content).not.toContain('@everyone');
  });

  it('answers an empty registry privately', async () => {
    const { bot, sink, interaction } = build();
    await new TempRoleList().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'replies:temp_role.list_empty' }]);
    expect(sink.followUps).toEqual([]);
  });

  it('uses private follow-ups for listings exceeding Discord message limits', async () => {
    const { bot, sink, interaction, listAll } = build();
    listAll.mockResolvedValue(
      ok(Array.from({ length: 50 }, (_, index) => role(`${index}`, 1_000))),
    );

    await new TempRoleList().execute(interaction, bot);

    expect(sink.editReplies).toHaveLength(1);
    expect(sink.followUps.length).toBeGreaterThan(0);
    for (const page of [...sink.editReplies, ...sink.followUps]) {
      expect(page.content?.length).toBeLessThanOrEqual(2_000);
    }
    for (const page of sink.followUps) expect(page.flags).toBe(MessageFlags.Ephemeral);
    const content = [...sink.editReplies, ...sink.followUps].map((page) => page.content).join('\n');
    expect(content.match(/replies:temp_role.list_line/g)).toHaveLength(50);
  });

  it('reports unavailable repositories without attempting a list', async () => {
    const { bot, sink, interaction, getRepos, listAll } = build();
    getRepos.mockReturnValue(undefined);
    await new TempRoleList().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'errors:db.not_found' }]);
    expect(listAll).not.toHaveBeenCalled();
  });

  it('rejects use outside a guild before resolving repositories', async () => {
    const { bot, getRepos, listAll } = build();
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ guildId: null, sink });
    await new TempRoleList().execute(interaction, bot);
    expect(sink.editReplies).toEqual([{ content: 'errors:command.guild_only' }]);
    expect(getRepos).not.toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
  });

  it('logs a failed list and edits the deferred reply with the error fallback', async () => {
    const { bot, logger, sink, interaction, listAll } = build();
    listAll.mockResolvedValue(
      err(databaseErrorFrom(new Error('database unavailable'), { operation: 'temp_role.test' })),
    );
    await new TempRoleList().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toMatch(/^replies:temp_role.failed:/);
    expect(logger.error).toHaveBeenCalled();
    expect(sink.replies).toEqual([]);
  });
});
