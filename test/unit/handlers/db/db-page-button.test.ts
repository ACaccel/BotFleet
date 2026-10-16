/**
 * Pins the `/db list` page buttons: only the admin who owns the panel may
 * page; every refusal is private and leaves the panel untouched.
 */
import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { DbInspectError } from '../../../../src/core/errors';
import db_page from '../../../../src/handlers/buttons/db_page';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import {
  ADMIN_ID,
  GUILD_ID,
  expiredInteractionError,
  fakeService,
  markedTranslator,
  queryPage,
  rowJson,
  withClient,
} from './fixtures';

const EXPIRED = {
  content: '[replies:db_inspect.session_expired]',
  flags: MessageFlags.Ephemeral,
};

const setup = (run: { customId?: string; userId?: string; withService?: boolean } = {}) => {
  const sink = newInteractionSink();
  const { service, mocks } = fakeService();
  const { bot, logger } = buildFakeBot({
    translator: markedTranslator(),
    isAdmin: (id: string) => id === ADMIN_ID,
    ...(run.withService === false ? {} : { dbInspectService: service }),
  });
  const interaction = withClient(
    buildButtonInteraction({
      customId: run.customId ?? 'db_page|tok1|2',
      userId: run.userId ?? ADMIN_ID,
      sink,
    }),
    { [GUILD_ID]: 'Guild One' },
  );
  return {
    sink,
    mocks,
    logger,
    interaction,
    execute: () => new db_page().execute(interaction, bot),
  };
};

describe('db_page button', () => {
  it('refuses a non-admin privately without acknowledging the panel', async () => {
    const { sink, mocks, execute } = setup({ userId: 'someone-else' });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
    expect(sink.deferUpdates).toEqual([]);
    expect(sink.editReplies).toEqual([]);
    expect(mocks['page']).not.toHaveBeenCalled();
  });

  it('refuses when the service is not published', async () => {
    const { sink, execute } = setup({ withService: false });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
    expect(sink.deferUpdates).toEqual([]);
  });

  it.each(['db_page|tok1', 'db_page|tok 1|2', 'db_view|tok1|2'])(
    'refuses the undecodable id %j',
    async (customId) => {
      const { sink, mocks, execute } = setup({ customId });

      await execute();

      expect(sink.replies).toEqual([EXPIRED]);
      expect(sink.deferUpdates).toEqual([]);
      expect(mocks['assertSession']).not.toHaveBeenCalled();
      expect(mocks['page']).not.toHaveBeenCalled();
    },
  );

  it('refuses another admin before acknowledging or paging', async () => {
    const { sink, mocks, logger, execute } = setup();
    mocks['assertSession']?.mockImplementation(() => {
      throw new DbInspectError('DB_INSPECT_NOT_INVOKER');
    });

    await execute();

    expect(mocks['assertSession']).toHaveBeenCalledWith('tok1', ADMIN_ID);
    expect(sink.replies).toEqual([
      { content: '[replies:db_inspect.not_invoker]', flags: MessageFlags.Ephemeral },
    ]);
    expect(sink.deferUpdates).toEqual([]);
    expect(sink.editReplies).toEqual([]);
    expect(mocks['page']).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('acknowledges first, then replaces the panel with the requested page', async () => {
    const { sink, mocks, execute } = setup();
    mocks['page']?.mockResolvedValue(queryPage({ page: 2, pageCount: 4, token: 'tok1' }));

    await execute();

    expect(mocks['page']).toHaveBeenCalledWith('tok1', 2, ADMIN_ID);
    expect(sink.deferUpdates).toHaveLength(1);
    expect(sink.replies).toEqual([]);
    expect(sink.editReplies).toHaveLength(1);
    const [edit] = sink.editReplies;
    expect(edit).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    const buttons = rowJson(edit?.components?.[1]).components;
    expect(buttons.map((b) => b.custom_id)).toEqual(['db_page|tok1|1', 'db_page|tok1|3']);
  });

  it('names the page database in the panel', async () => {
    const { sink, mocks, execute } = setup();
    mocks['page']?.mockResolvedValue(queryPage());

    await execute();

    const embed = sink.editReplies[0]?.embeds?.[0] as { toJSON(): { description?: string } };
    expect(embed.toJSON().description).toContain('Guild One');
  });

  it('follows up privately and leaves the panel alone when paging fails after acknowledging', async () => {
    const { sink, mocks, logger, execute } = setup();
    mocks['page']?.mockRejectedValue(new DbInspectError('DB_INSPECT_SESSION_EXPIRED'));

    await execute();

    expect(sink.deferUpdates).toHaveLength(1);
    expect(sink.followUps).toEqual([EXPIRED]);
    expect(sink.editReplies).toEqual([]);
    expect(sink.replies).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unexpected paging failure and shows a trace ID', async () => {
    const { sink, mocks, logger, execute } = setup();
    mocks['page']?.mockRejectedValue(new Error('timeout'));

    await execute();

    expect(sink.followUps[0]?.content).toContain('replies:db_inspect.failed');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the interaction expired before the failure could be reported', async () => {
    const { interaction, mocks, execute } = setup();
    mocks['page']?.mockRejectedValue(new Error('timeout'));
    // The follow-up is the only reply path once deferUpdate has run.
    vi.spyOn(interaction, 'followUp').mockRejectedValue(expiredInteractionError());

    await expect(execute()).resolves.toBeUndefined();
  });
});
