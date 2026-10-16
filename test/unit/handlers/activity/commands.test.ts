/**
 * `/activity cancel`, `/activity list` and `/activity create` against an
 * in-memory activity store: what the member is told, and what the store
 * holds afterwards. Visibility matters on every path — an activity in a
 * channel the member cannot see must look exactly like a missing one.
 */
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';

import ActivityCancel from '../../../../src/handlers/commands/activity_cancel/action';
import ActivityCreate from '../../../../src/handlers/commands/activity_create/action';
import ActivityList from '../../../../src/handlers/commands/activity_list/action';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildAutocompleteInteraction,
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'g-1';
const NOW = Date.now();

interface StoredActivity {
  readonly activity_id: string;
  readonly message_id: string;
  readonly channel_id: string;
  readonly title: string;
  readonly creator_id?: string;
  readonly expired_at: number;
  status: 'open' | 'closed' | 'cancelled';
  readonly participants: string[];
  purge_at?: Date;
}

const activity = (overrides: Partial<StoredActivity> = {}): StoredActivity => ({
  activity_id: 'a1',
  message_id: 'a1',
  channel_id: 'c-public',
  title: 'Games night',
  creator_id: 'creator',
  expired_at: NOW + 3_600_000,
  status: 'open',
  participants: ['p1', 'p2'],
  ...overrides,
});

type Failure = 'list' | 'find';

/** Activity store whose `finish` applies the same status guard as the Mongo repo. */
const buildStore = (docs: readonly StoredActivity[], fail?: Failure) => {
  const store = new Map(docs.map((doc) => [doc.activity_id, { ...doc }]));
  const failure = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));
  const repo = {
    listAll: async () => (fail === 'list' ? failure() : ok([...store.values()])),
    findByActivityId: async (id: string) => (fail === 'find' ? failure() : ok(store.get(id))),
    finish: async (id: string, from: readonly string[], to: StoredActivity['status'], at: Date) => {
      const doc = store.get(id);
      if (doc === undefined || !from.includes(doc.status)) return ok(false);
      doc.status = to;
      doc.purge_at = at;
      return ok(true);
    },
  };
  return { store, repo };
};

/** A guild with one channel everyone sees and one only `insider` sees. */
const guild = () =>
  buildGuild({
    id: GUILD_ID,
    channels: [
      buildTextChannel({ id: 'c-public' }),
      buildTextChannel({ id: 'c-private', viewableByAll: false, viewableBy: new Set(['insider']) }),
    ],
  });

const setup = (docs: readonly StoredActivity[], options: { fail?: Failure; db?: boolean } = {}) => {
  const { store, repo } = buildStore(docs, options.fail);
  const repos = options.db === false ? undefined : { activity: repo };
  const getRepos = (id: string) => (id === GUILD_ID ? repos : undefined);
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    isAdmin: (id: string) => id === 'admin',
    getRepos,
    connectionManager: undefined,
    // `cancelActivity` re-renders the post through these; an empty guild
    // cache makes that refresh a no-op, leaving the store as the outcome.
    guildRegistry: { getRepos },
    client: { guilds: { cache: new Map() } },
    jobMap: new Map(),
  });
  return { bot, store };
};

const cancel = async (
  docs: readonly StoredActivity[],
  input: {
    userId?: string;
    activityId?: string;
    permissions?: readonly bigint[];
    fail?: Failure;
    db?: boolean;
  } = {},
) => {
  const { bot, store } = setup(docs, input);
  const sink = newInteractionSink();
  await new ActivityCancel().execute(
    buildChatInputInteraction({
      commandName: 'activity',
      userId: input.userId ?? 'creator',
      guild: guild(),
      options: { activity: input.activityId ?? 'a1' },
      ...(input.permissions === undefined ? {} : { memberPermissions: input.permissions }),
      sink,
    }),
    bot,
  );
  return { sink, store, content: sink.editReplies[0]?.content };
};

describe('/activity cancel', () => {
  it('lets the creator cancel, privately, and records the cancellation', async () => {
    const { sink, store, content } = await cancel([activity()]);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(content).toBe('replies:activity.cancelled');
    expect(store.get('a1')?.status).toBe('cancelled');
    expect(store.get('a1')?.purge_at).toBeInstanceOf(Date);
  });

  it.each([
    ['an admin', { userId: 'admin' }],
    ['an event manager', { userId: 'member', permissions: [PermissionFlagsBits.ManageEvents] }],
    ['a message manager', { userId: 'member', permissions: [PermissionFlagsBits.ManageMessages] }],
  ])('lets %s cancel an activity they did not create', async (_who, input) => {
    const { store, content } = await cancel([activity()], input);

    expect(content).toBe('replies:activity.cancelled');
    expect(store.get('a1')?.status).toBe('cancelled');
  });

  it('refuses any other member and leaves the activity open', async () => {
    const { store, content } = await cancel([activity()], { userId: 'member' });

    expect(content).toBe('replies:activity.manage_forbidden');
    expect(store.get('a1')?.status).toBe('open');
  });

  it('needs a manager for an activity from before creators were recorded', async () => {
    const legacy = activity({ creator_id: undefined });

    expect((await cancel([legacy], { userId: 'member' })).content).toBe(
      'replies:activity.manage_forbidden',
    );
  });

  it('answers a hidden activity exactly like a missing one', async () => {
    const hidden = await cancel([activity({ channel_id: 'c-private' })]);
    const missing = await cancel([activity()], { activityId: 'nope' });

    expect(hidden.content).toBe('replies:activity.not_found');
    expect(missing.content).toBe('replies:activity.not_found');
    expect(hidden.store.get('a1')?.status).toBe('open');
  });

  it('says an already cancelled activity is no longer open', async () => {
    const { content } = await cancel([activity({ status: 'cancelled' })]);

    expect(content).toBe('replies:activity.not_open');
  });

  it('turns a lookup failure into the trace-stamped failure reply', async () => {
    const { store, content } = await cancel([activity()], { fail: 'find' });

    expect(content).toMatch(/^replies:activity\.failed:\{"traceId":"[0-9a-z]{6}"\}$/);
    expect(store.get('a1')?.status).toBe('open');
  });

  it('answers a guild without a database in the deferred reply', async () => {
    const { content } = await cancel([activity()], { db: false });

    expect(content).toBe('errors:db.not_found');
  });

  it('suggests only visible, still-active activities the member may cancel', async () => {
    const { bot } = setup([
      activity({ activity_id: 'mine', title: 'Board games' }),
      activity({ activity_id: 'theirs', title: 'Board meeting', creator_id: 'other' }),
      activity({ activity_id: 'hidden', title: 'Board secrets', channel_id: 'c-private' }),
      activity({ activity_id: 'gone', title: 'Board old', status: 'cancelled' }),
      activity({ activity_id: 'other', title: 'Karaoke' }),
    ]);

    const suggestions = await new ActivityCancel().autocomplete(
      buildAutocompleteInteraction({ userId: 'creator', guild: guild(), focused: 'BOARD' }),
      bot,
    );

    expect(suggestions).toEqual([{ name: 'Board games', value: 'mine' }]);
  });

  it('suggests nothing when the store cannot be read', async () => {
    const { bot } = setup([activity()], { fail: 'list' });

    const suggestions = await new ActivityCancel().autocomplete(
      buildAutocompleteInteraction({ userId: 'creator', guild: guild() }),
      bot,
    );

    expect(suggestions).toEqual([]);
  });
});

describe('/activity list', () => {
  const list = async (
    docs: readonly StoredActivity[],
    input: { userId?: string; fail?: Failure } = {},
  ) => {
    const { bot } = setup(docs, input);
    const sink = newInteractionSink();
    await new ActivityList().execute(
      buildChatInputInteraction({ userId: input.userId ?? 'member', guild: guild(), sink }),
      bot,
    );
    return sink;
  };

  it('lists open activities the member can see, soonest deadline first', async () => {
    const sink = await list([
      activity({ activity_id: 'late', message_id: 'late', title: 'Late', expired_at: NOW + 9e6 }),
      activity({ activity_id: 'soon', message_id: 'soon', title: 'Soon', expired_at: NOW + 6e4 }),
      activity({ activity_id: 'closed', title: 'Closed', status: 'closed' }),
      activity({ activity_id: 'hidden', title: 'Hidden', channel_id: 'c-private' }),
    ]);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    const [header, ...lines] = (sink.editReplies[0]?.content ?? '').split('\n');
    expect(header).toBe('replies:activity.list_header:{"count":2}');
    expect(lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))).title)).toEqual([
      'Soon',
      'Late',
    ]);
    expect(lines[0]).toContain(`"link":"https://discord.com/channels/${GUILD_ID}/c-public/soon"`);
    expect(lines[0]).toContain('"count":2');
  });

  it('shows a member the private activities of channels they can see', async () => {
    const sink = await list([activity({ channel_id: 'c-private' })], { userId: 'insider' });

    expect(sink.editReplies[0]?.content).toContain('replies:activity.list_header:{"count":1}');
  });

  it('says so when nothing is open', async () => {
    const sink = await list([activity({ status: 'cancelled' })]);

    expect(sink.editReplies).toEqual([{ content: 'replies:activity.list_empty' }]);
  });

  it('turns a read failure into the trace-stamped failure reply', async () => {
    const sink = await list([activity()], { fail: 'list' });

    expect(sink.editReplies[0]?.content).toMatch(/^replies:activity\.failed:/);
  });
});

describe('/activity create', () => {
  const create = async (options: Readonly<Record<string, string>>) => {
    const { bot } = setup([]);
    const sink = newInteractionSink();
    await new ActivityCreate().execute(buildChatInputInteraction({ options, sink }), bot);
    return sink;
  };

  it('opens the form without replying, carrying the chosen role in its custom ID', async () => {
    const sink = await create({ role: 'role-9' });

    expect(sink.replies).toEqual([]);
    expect(sink.defers).toEqual([]);
    expect(sink.modals).toHaveLength(1);
    expect(sink.modals[0]).toMatchObject({
      data: { custom_id: 'activity_create|role-9', title: 'replies:activity.modal_title' },
    });
  });

  it('opens the form with the bare custom ID when no role is chosen', async () => {
    const sink = await create({});

    expect(sink.modals[0]).toMatchObject({ data: { custom_id: 'activity_create' } });
  });
});
