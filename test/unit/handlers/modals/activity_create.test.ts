/**
 * The `/activity create` form submit: every input problem is named
 * before anything is posted, a valid form posts the announcement and
 * stores the activity, and a failed write withdraws the post.
 */
import { MessageFlags } from 'discord.js';
import type { Job } from 'node-schedule';
import { afterEach, describe, expect, it } from 'vitest';

import ActivityCreateModal from '../../../../src/handlers/modals/activity_create';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildSendableChannel } from '../../../fixtures/discord/channel-builder';
import {
  buildModalSubmitInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'g-1';

const VALID_FORM = {
  title: '  Games night  ',
  description: 'Bring snacks',
  start: '',
  deadline: '2h',
  capacity: '8',
};

/** Jobs a successful create scheduled; cancelled so no timer outlives its test. */
const scheduled: Map<string, Job>[] = [];

afterEach(() => {
  for (const jobs of scheduled.splice(0)) for (const job of jobs.values()) job.cancel();
});

interface SubmitInput {
  readonly form?: Readonly<Record<string, string>>;
  readonly customId?: string;
  readonly sendable?: boolean;
  readonly db?: boolean;
  readonly createFails?: boolean;
  readonly sendFails?: boolean;
}

const submit = async (input: SubmitInput = {}) => {
  const created: Record<string, unknown>[] = [];
  const activity = {
    create: async (doc: Record<string, unknown>) => {
      if (input.createFails === true) {
        return err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));
      }
      const stored = { ...doc, participants: [], attendance: [], status: 'open' };
      created.push(stored);
      return ok(stored);
    },
  };
  const getRepos = (id: string) =>
    id === GUILD_ID && input.db !== false ? { activity } : undefined;
  const jobMap = new Map<string, Job>();
  scheduled.push(jobMap);
  const { bot, logger } = buildFakeBot({
    getRepos,
    guildRegistry: { getRepos },
    client: { guilds: { cache: new Map() } },
    jobMap,
    timeZone: 'UTC',
  });
  const posted = buildSendableChannel({
    id: 'c-events',
    sendable: input.sendable ?? true,
    messageId: 'post-1',
  });
  if (input.sendFails === true) posted.send.mockRejectedValueOnce(new Error('Missing Access'));
  const sink = newInteractionSink();
  await new ActivityCreateModal().execute(
    buildModalSubmitInteraction({
      customId: input.customId ?? 'activity_create',
      userId: 'organizer',
      channel: posted.channel,
      textInputs: input.form ?? VALID_FORM,
      sink,
    }),
    bot,
  );
  return { sink, created, posted, jobMap, logger, content: sink.editReplies[0]?.content };
};

describe('activity_create modal', () => {
  it('posts the announcement and stores the activity under the post ID', async () => {
    const { sink, created, posted, jobMap, content } = await submit({
      customId: 'activity_create|role-9',
    });

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(content).toBe('replies:activity.created');
    expect(posted.send).toHaveBeenCalledOnce();
    expect(created).toEqual([
      expect.objectContaining({
        activity_id: 'post-1',
        message_id: 'post-1',
        channel_id: 'c-events',
        title: 'Games night',
        description: 'Bring snacks',
        creator_id: 'organizer',
        role_id: 'role-9',
        capacity: 8,
      }),
    ]);
    expect(created[0]).not.toHaveProperty('starts_at');
    // The deadline close is scheduled, so sign-ups end without a restart.
    expect([...jobMap.keys()]).toEqual(['activity:close:post-1']);
  });

  it('stores a start time and schedules its reminder when one is given', async () => {
    const { created, jobMap } = await submit({ form: { ...VALID_FORM, start: '3h' } });

    expect(created[0]).toHaveProperty('starts_at', expect.any(Number));
    expect([...jobMap.keys()].sort()).toEqual(['activity:close:post-1', 'activity:start:post-1']);
  });

  it.each([
    ['missing_title', { title: '   ' }],
    ['invalid_deadline', { deadline: 'soon' }],
    ['invalid_start', { start: 'yesterday' }],
    ['invalid_capacity', { capacity: '0' }],
  ])('names the %s problem and posts nothing', async (problem, override) => {
    const { posted, created, content } = await submit({ form: { ...VALID_FORM, ...override } });

    expect(content).toBe(`replies:activity.${problem}`);
    expect(posted.send).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('refuses a channel it cannot post in', async () => {
    const { posted, content } = await submit({ sendable: false });

    expect(content).toBe('errors:command.channel_not_found');
    expect(posted.send).not.toHaveBeenCalled();
  });

  it('answers a guild without a database before posting', async () => {
    const { posted, content } = await submit({ db: false });

    expect(content).toBe('errors:db.not_found');
    expect(posted.send).not.toHaveBeenCalled();
  });

  it('says the post failed when the channel rejects it, storing nothing', async () => {
    const { created, content } = await submit({ sendFails: true });

    expect(content).toBe('replies:activity.announce_failed');
    expect(created).toEqual([]);
  });

  it('withdraws the post when the activity cannot be stored', async () => {
    const { posted, jobMap, logger, content } = await submit({ createFails: true });

    expect(content).toBe('replies:activity.create_failed');
    expect(posted.message.delete).toHaveBeenCalledOnce();
    expect(jobMap.size).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
});
