/**
 * Pins the `/db list` detail menu: only the admin who owns the panel may
 * open a row, the choice must be a row index, and the document opens in a
 * new private reply rather than replacing the panel.
 */
import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { DbInspectError } from '../../../../src/core/errors';
import db_view from '../../../../src/handlers/select-menus/db_view';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import {
  ADMIN_ID,
  GUILD_ID,
  documentView,
  embedJson,
  fakeService,
  markedTranslator,
  withClient,
} from './fixtures';

const EXPIRED = {
  content: '[replies:db_inspect.session_expired]',
  flags: MessageFlags.Ephemeral,
};

const setup = (
  run: { customId?: string; values?: string[]; userId?: string; withService?: boolean } = {},
) => {
  const sink = newInteractionSink();
  const { service, mocks } = fakeService();
  const { bot, logger } = buildFakeBot({
    translator: markedTranslator(),
    isAdmin: (id: string) => id === ADMIN_ID,
    ...(run.withService === false ? {} : { dbInspectService: service }),
  });
  const interaction = withClient(
    buildStringSelectInteraction({
      customId: run.customId ?? 'db_view|tok1',
      values: run.values ?? ['3'],
      userId: run.userId ?? ADMIN_ID,
      sink,
    }),
    { [GUILD_ID]: 'Guild One' },
  );
  return { sink, mocks, logger, execute: () => new db_view().execute(interaction, bot) };
};

describe('db_view menu', () => {
  it('refuses a non-admin privately without deferring', async () => {
    const { sink, mocks, execute } = setup({ userId: 'someone-else' });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
    expect(sink.defers).toEqual([]);
    expect(mocks['documentAt']).not.toHaveBeenCalled();
  });

  it('refuses when the service is not published', async () => {
    const { sink, execute } = setup({ withService: false });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
    expect(sink.defers).toEqual([]);
  });

  it.each(['db_view', 'db_view|bad token', 'db_page|tok1|1'])(
    'refuses the undecodable id %j',
    async (customId) => {
      const { sink, mocks, execute } = setup({ customId });

      await execute();

      expect(sink.replies).toEqual([EXPIRED]);
      expect(mocks['assertSession']).not.toHaveBeenCalled();
    },
  );

  it.each([['abc'], ['1.5'], ['NaN']])('refuses the non-integer choice %j', async (value) => {
    const { sink, mocks, execute } = setup({ values: [value] });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
    expect(sink.defers).toEqual([]);
    expect(mocks['documentAt']).not.toHaveBeenCalled();
  });

  it('refuses a missing choice', async () => {
    const { sink, execute } = setup({ values: [] });

    await execute();

    expect(sink.replies).toEqual([EXPIRED]);
  });

  it('refuses another admin before deferring', async () => {
    const { sink, mocks, execute } = setup();
    mocks['assertSession']?.mockImplementation(() => {
      throw new DbInspectError('DB_INSPECT_NOT_INVOKER');
    });

    await execute();

    expect(sink.replies).toEqual([
      { content: '[replies:db_inspect.not_invoker]', flags: MessageFlags.Ephemeral },
    ]);
    expect(sink.defers).toEqual([]);
    expect(mocks['documentAt']).not.toHaveBeenCalled();
  });

  it('defers ephemerally, then shows the chosen row as a document', async () => {
    const { sink, mocks, execute } = setup({ values: ['3'] });
    mocks['documentAt']?.mockResolvedValue(documentView());

    await execute();

    expect(mocks['assertSession']).toHaveBeenCalledWith('tok1', ADMIN_ID);
    expect(mocks['documentAt']).toHaveBeenCalledWith('tok1', 3, ADMIN_ID);
    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.replies).toEqual([]);
    expect(sink.editReplies).toHaveLength(1);
    const [edit] = sink.editReplies;
    expect(edit).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    const embed = embedJson(edit?.embeds?.[0]);
    expect(embed.title).toContain('bugtickets');
    expect(embed.footer?.text).toBe('Guild One (100000000000000001)');
  });

  it('replaces the deferred reply with the error when the row cannot be loaded', async () => {
    const { sink, mocks, logger, execute } = setup();
    mocks['documentAt']?.mockRejectedValue(new DbInspectError('DB_INSPECT_SESSION_EXPIRED'));

    await execute();

    expect(sink.defers).toHaveLength(1);
    expect(sink.editReplies).toEqual([
      {
        content: '[replies:db_inspect.session_expired]',
        embeds: [],
        components: [],
        files: [],
      },
    ]);
    expect(sink.followUps).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unexpected failure and shows a trace ID', async () => {
    const { sink, mocks, logger, execute } = setup();
    mocks['documentAt']?.mockRejectedValue(new Error('timeout'));

    await execute();

    expect(sink.editReplies[0]?.content).toContain('replies:db_inspect.failed');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
