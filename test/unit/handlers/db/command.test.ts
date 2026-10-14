/**
 * Pins the `/db` command: only bot admins get past the gate, the target
 * database comes from the `guild` option or the current guild, each
 * subcommand reads through the service with the right arguments, and
 * failures answer privately without leaking internals.
 */
import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { DbInspectError } from '../../../../src/core/errors';
import db from '../../../../src/handlers/commands/db';
import { dbCommandConfig } from '../../../../src/handlers/commands/db/config';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import {
  ADMIN_ID,
  GUILD_ID,
  description,
  documentView,
  embedJson,
  fakeService,
  markedTranslator,
  queryPage,
  withClient,
} from './fixtures';

interface RunOptions {
  readonly subcommand?: string;
  readonly options?: Record<string, string>;
  readonly guildId?: string | null;
  readonly userId?: string;
  readonly withService?: boolean;
  readonly guilds?: Record<string, string>;
}

const setup = (run: RunOptions = {}) => {
  const sink = newInteractionSink();
  const { service, mocks } = fakeService();
  const { bot, logger } = buildFakeBot({
    translator: markedTranslator(),
    isAdmin: (id: string) => id === ADMIN_ID,
    ...(run.withService === false ? {} : { dbInspectService: service }),
  });
  const interaction = withClient(
    buildChatInputInteraction({
      commandName: 'db',
      userId: run.userId ?? ADMIN_ID,
      guildId: run.guildId === undefined ? GUILD_ID : run.guildId,
      subcommand: run.subcommand ?? 'stats',
      options: run.options ?? {},
      sink,
    }),
    run.guilds ?? { [GUILD_ID]: 'Guild One' },
  );
  const execute = () => new db().execute(interaction, bot);
  return { sink, mocks, logger, execute };
};

describe('/db access', () => {
  it('turns a non-admin away privately before deferring or querying', async () => {
    const { sink, mocks, execute } = setup({ userId: 'someone-else' });

    await execute();

    expect(sink.replies).toEqual([
      { content: '[errors:permission.admin_only_short]', flags: MessageFlags.Ephemeral },
    ]);
    expect(sink.defers).toEqual([]);
    expect(sink.editReplies).toEqual([]);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('defers ephemerally for an admin', async () => {
    const { sink, mocks, execute } = setup();
    mocks['stats']?.mockResolvedValue([]);

    await execute();

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
  });

  it('declares every subcommand admin-only', () => {
    expect(dbCommandConfig.subcommands?.map((s) => [s.name, s.adminOnly])).toEqual([
      ['stats', true],
      ['schema', true],
      ['list', true],
      ['get', true],
    ]);
  });
});

describe('/db target database', () => {
  it('says so when the inspection service is not published', async () => {
    const { sink, execute } = setup({ withService: false });

    await execute();

    expect(sink.editReplies).toEqual([
      { content: '[replies:db_inspect.unavailable]', embeds: [], components: [], files: [] },
    ]);
  });

  it('asks for the guild option in a DM', async () => {
    const { sink, mocks, execute } = setup({ guildId: null });

    await execute();

    expect(sink.editReplies[0]?.content).toBe('[replies:db_inspect.guild_required]');
    expect(mocks['stats']).not.toHaveBeenCalled();
  });

  it('inspects the guild given in the option, even from another guild', async () => {
    const { mocks, execute } = setup({ options: { guild: '200000000000000002' } });
    mocks['stats']?.mockResolvedValue([]);

    await execute();

    expect(mocks['stats']).toHaveBeenCalledWith(ADMIN_ID, '200000000000000002');
  });

  it('inspects a guild from a DM when the option is given', async () => {
    const { sink, mocks, execute } = setup({
      guildId: null,
      options: { guild: '200000000000000002' },
      guilds: {},
    });
    mocks['stats']?.mockResolvedValue([]);

    await execute();

    expect(mocks['stats']).toHaveBeenCalledWith(ADMIN_ID, '200000000000000002');
    expect(embedJson(sink.editReplies[0]?.embeds?.[0]).description).toMatch(
      /200000000000000002 \(.*not.*joined/,
    );
  });
});

describe('/db subcommands', () => {
  it('stats reads the guild statistics', async () => {
    const { sink, mocks, execute } = setup({ subcommand: 'stats' });
    mocks['stats']?.mockResolvedValue([
      {
        name: 'bugtickets',
        count: 3,
        size: 1,
        storageSize: 1,
        indexCount: 1,
        indexSize: 1,
        registered: true,
      },
    ]);

    await execute();

    expect(mocks['stats']).toHaveBeenCalledWith(ADMIN_ID, GUILD_ID);
    expect(sink.editReplies).toHaveLength(1);
    const [reply] = sink.editReplies;
    expect(reply).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    const embed = embedJson(reply?.embeds?.[0]);
    expect(embed.title).toBe('[replies:db_inspect.stats.title]');
    expect(embed.description).toContain('Guild One (100000000000000001)');
  });

  it('schema describes the chosen collection', async () => {
    const { sink, mocks, execute } = setup({
      subcommand: 'schema',
      options: { collection: 'bugtickets' },
    });
    mocks['describe']?.mockResolvedValue(description());

    await execute();

    expect(mocks['describe']).toHaveBeenCalledWith(ADMIN_ID, GUILD_ID, 'bugtickets');
    expect(sink.editReplies[0]).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    expect(sink.editReplies[0]?.embeds).toHaveLength(2);
  });

  it('list passes the filter and sort through', async () => {
    const { sink, mocks, execute } = setup({
      subcommand: 'list',
      options: {
        collection: 'bugtickets',
        field: 'title',
        operator: 'contains',
        value: 'crash',
        sort: 'number:asc',
      },
    });
    mocks['query']?.mockResolvedValue(queryPage());

    await execute();

    expect(mocks['query']).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      database: GUILD_ID,
      collection: 'bugtickets',
      filter: { field: 'title', operator: 'contains', value: 'crash' },
      sort: 'number:asc',
    });
    expect(sink.editReplies[0]).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    expect(sink.editReplies[0]?.components).toHaveLength(1);
  });

  it('list leaves the sort out when none is chosen', async () => {
    const { mocks, execute } = setup({
      subcommand: 'list',
      options: { collection: 'bugtickets' },
    });
    mocks['query']?.mockResolvedValue(queryPage());

    await execute();

    const input = mocks['query']?.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('sort');
    expect(input['filter']).toEqual({ field: undefined, operator: undefined, value: undefined });
  });

  it('get shows one document by ID', async () => {
    const { sink, mocks, execute } = setup({
      subcommand: 'get',
      options: { collection: 'bugtickets', id: 'aaa' },
    });
    mocks['get']?.mockResolvedValue(documentView());

    await execute();

    expect(mocks['get']).toHaveBeenCalledWith(ADMIN_ID, GUILD_ID, 'bugtickets', 'aaa');
    expect(sink.editReplies[0]).toMatchObject({ content: '', allowedMentions: { parse: [] } });
    expect(embedJson(sink.editReplies[0]?.embeds?.[0]).title).toContain('"id":"aaa"');
  });

  it('ignores a subcommand it does not know', async () => {
    const { sink, mocks, execute } = setup({ subcommand: 'drop' });

    await execute();

    expect(sink.editReplies).toEqual([]);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});

describe('/db failures', () => {
  it('shows an expected rejection as its translated message without logging it', async () => {
    const { sink, mocks, logger, execute } = setup({
      subcommand: 'schema',
      options: { collection: 'nope' },
    });
    mocks['describe']?.mockRejectedValue(
      new DbInspectError('DB_INSPECT_UNKNOWN_COLLECTION', { collection: 'nope' }),
    );

    await execute();

    expect(sink.editReplies).toEqual([
      {
        content: '[replies:db_inspect.unknown_collection]{"collection":"nope"}',
        embeds: [],
        components: [],
        files: [],
      },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers an unexpected error with a trace ID and logs it', async () => {
    const { sink, mocks, logger, execute } = setup();
    const boom = new Error('connection reset');
    mocks['stats']?.mockRejectedValue(boom);

    await execute();

    expect(sink.editReplies[0]?.content).toMatch(
      /^\[replies:db_inspect\.failed\]\{"traceId":"[0-9a-f]{8}"\}$/,
    );
    expect(sink.editReplies[0]?.content).not.toContain('connection reset');
    expect(logger.error).toHaveBeenCalledWith({ err: boom }, 'errorLogger');
  });

  it('treats a missing required option as an unexpected error', async () => {
    const { sink, logger, execute } = setup({ subcommand: 'schema' });

    await execute();

    expect(sink.editReplies[0]?.content).toContain('replies:db_inspect.failed');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
