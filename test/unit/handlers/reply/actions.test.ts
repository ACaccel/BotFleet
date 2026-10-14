/**
 * `/reply add` and `/reply delete` against an in-memory auto-reply store.
 * Adding must not duplicate a pair; deleting offers only the pairs the
 * member may remove, split across Discord's select-menu limits.
 */
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import AddReply from '../../../../src/handlers/commands/add_reply/action';
import DeleteReply from '../../../../src/handlers/commands/delete_reply/action';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'g-1';

interface StoredPair {
  readonly _id: Types.ObjectId;
  readonly input: string;
  readonly reply: string;
  readonly created_by?: string;
}

const pair = (input: string, reply: string, createdBy = 'author'): StoredPair => ({
  _id: new Types.ObjectId(),
  input,
  reply,
  created_by: createdBy,
});

type Failure = 'find' | 'create';

const buildStore = (pairs: readonly StoredPair[], fail?: Failure) => {
  const store = [...pairs];
  const failure = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));
  const reply = {
    findExactPair: async (input: string, text: string) =>
      fail === 'find'
        ? failure()
        : ok(store.filter((row) => row.input === input && row.reply === text)),
    findByInput: async (input: string) =>
      fail === 'find' ? failure() : ok(store.filter((row) => row.input === input)),
    create: async (input: string, text: string, createdBy: string) => {
      if (fail === 'create') return failure();
      const row = { _id: new Types.ObjectId(), input, reply: text, created_by: createdBy };
      store.push(row);
      return ok(row);
    },
  };
  return { store, reply };
};

interface RunInput {
  readonly userId?: string;
  readonly permissions?: readonly bigint[];
  readonly fail?: Failure;
  /** `false`: no database; `'disabled'`: the guild's connection was disabled. */
  readonly db?: false | 'disabled';
}

const setup = (pairs: readonly StoredPair[], input: RunInput) => {
  const { store, reply } = buildStore(pairs, input.fail);
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    isAdmin: (id: string) => id === 'admin',
    getRepos: (id: string) => (id === GUILD_ID && input.db === undefined ? { reply } : undefined),
    connectionManager: {
      isDisabled: () => (input.db === 'disabled' ? { traceId: 'tr4ce1' } : undefined),
    },
  });
  return { bot, store };
};

const interaction = (options: Readonly<Record<string, string>>, input: RunInput) => {
  const sink = newInteractionSink();
  return {
    sink,
    interaction: buildChatInputInteraction({
      commandName: 'reply',
      userId: input.userId ?? 'author',
      options,
      ...(input.permissions === undefined ? {} : { memberPermissions: input.permissions }),
      sink,
    }),
  };
};

describe('/reply add', () => {
  const add = async (pairs: readonly StoredPair[], input: RunInput = {}) => {
    const { bot, store } = setup(pairs, input);
    const { sink, interaction: built } = interaction({ keyword: 'hi', reply: '@everyone' }, input);
    await new AddReply().execute(built, bot);
    return { sink, store, sent: sink.editReplies[0] };
  };

  it('stores a new pair under its author and confirms it publicly without pinging', async () => {
    const { sink, store, sent } = await add([], { userId: 'writer' });

    expect(sink.defers).toEqual([{}]);
    expect(sent).toEqual({
      content: 'replies:add_reply.added:{"input":"hi","reply":"@everyone"}',
      allowedMentions: { parse: [] },
    });
    expect(store).toEqual([expect.objectContaining({ input: 'hi', created_by: 'writer' })]);
  });

  it('refuses a duplicate pair and leaves the store unchanged', async () => {
    const { store, sent } = await add([pair('hi', '@everyone')]);

    expect(sent?.content).toBe(
      'replies:add_reply.already_exists:{"input":"hi","reply":"@everyone"}',
    );
    expect(store).toHaveLength(1);
  });

  it.each(['find', 'create'] as const)(
    'turns a %s failure into the trace-stamped failure reply',
    async (fail) => {
      const { store, sent } = await add([], { fail });

      expect(sent?.content).toMatch(/^replies:add_reply\.failed:\{"traceId":"[0-9a-z]{6}"\}$/);
      expect(store).toEqual([]);
    },
  );

  it('answers a guild without a database', async () => {
    expect((await add([], { db: false })).sent?.content).toBe('errors:db.not_found');
  });

  it('names the trace of a disabled guild connection', async () => {
    expect((await add([], { db: 'disabled' })).sent?.content).toBe(
      'errors:db.guild_disabled:{"traceId":"tr4ce1"}',
    );
  });
});

/** The select menus of a reply, as Discord receives them. */
const selectMenus = (components: readonly unknown[] | undefined) =>
  (
    JSON.parse(JSON.stringify(components ?? [])) as Array<{
      components: Array<{ custom_id: string; options: Array<{ label: string; value: string }> }>;
    }>
  ).flatMap((row) => row.components);

describe('/reply delete', () => {
  const remove = async (pairs: readonly StoredPair[], input: RunInput = {}) => {
    const { bot } = setup(pairs, input);
    const { sink, interaction: built } = interaction({ keyword: 'hi' }, input);
    await new DeleteReply().execute(built, bot);
    return { sink, sent: sink.editReplies[0] };
  };

  it("offers the member's own pairs privately, valued by record ID", async () => {
    const own = pair('hi', 'hello there');
    const image = pair('hi', 'https://cdn.example/cat.png');
    const { sink, sent } = await remove([own, image, pair('hi', 'not mine', 'someone')]);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    const [menu, ...others] = selectMenus(sent?.components);
    expect(others).toEqual([]);
    expect(menu?.custom_id).toBe('delete_reply|0');
    expect(menu?.options).toEqual([
      { label: '1. hello there', value: own._id.toString() },
      { label: '2. https://cdn.example/cat.png', value: image._id.toString() },
    ]);
    // Image replies are previewed by number so the member can tell them apart.
    expect(sent?.content).toBe(
      'replies:delete_reply.image_preview_header2 - https://cdn.example/cat.png\n',
    );
  });

  it('truncates a long reply in its option label', async () => {
    const { sent } = await remove([pair('hi', 'x'.repeat(80))]);

    expect(selectMenus(sent?.components)[0]?.options[0]?.label).toBe(`1. ${'x'.repeat(60)}...`);
  });

  it('lets a message manager remove any pair, 25 per menu and 5 menus at most', async () => {
    const many = Array.from({ length: 130 }, (_, index) => pair('hi', `r${String(index)}`, 'x'));
    const { sent } = await remove(many, {
      userId: 'mod',
      permissions: [PermissionFlagsBits.ManageMessages],
    });

    const menus = selectMenus(sent?.components);
    expect(menus.map((menu) => menu.custom_id)).toEqual([
      'delete_reply|0',
      'delete_reply|1',
      'delete_reply|2',
      'delete_reply|3',
      'delete_reply|4',
    ]);
    expect(menus.map((menu) => menu.options.length)).toEqual([25, 25, 25, 25, 25]);
    expect(menus[1]?.options[0]?.label).toBe('26. r25');
  });

  it('lets a bot admin remove pairs from before authors were recorded', async () => {
    const legacy: StoredPair = { _id: new Types.ObjectId(), input: 'hi', reply: 'old' };

    expect(
      selectMenus((await remove([legacy], { userId: 'admin' })).sent?.components),
    ).toHaveLength(1);
    expect((await remove([legacy], { userId: 'member' })).sent?.content).toBe(
      'replies:delete_reply.none_deletable',
    );
  });

  it('says when the keyword has no pairs', async () => {
    const { sent } = await remove([pair('other', 'x')]);

    expect(sent).toEqual({ content: 'replies:delete_reply.not_found:{"keyword":"hi"}' });
  });

  it('says when every pair belongs to someone else', async () => {
    const { sent } = await remove([pair('hi', 'theirs', 'someone')]);

    expect(sent).toEqual({ content: 'replies:delete_reply.none_deletable' });
  });

  it('turns a lookup failure into the trace-stamped failure reply', async () => {
    const { sent } = await remove([pair('hi', 'x')], { fail: 'find' });

    expect(sent?.content).toMatch(/^replies:delete_reply\.failed:/);
    expect(sent?.components).toBeUndefined();
  });
});
