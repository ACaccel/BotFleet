/**
 * Handler-level tests for `handleActivityDelete`.
 *
 * The failure replies must be catalog keys. `deleteActivity` used to
 * return raw English reasons ("Database not found") that the handler
 * interpolated straight into the localised template, so a zh-TW user
 * read "無法刪除活動: Database not found".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import { ok } from '../../../src/core/result';
import { handleActivityDelete } from '../../../src/handlers/commands/activity-shared/interactions';
import type { BaseBot } from '../../../src/bot';

const GUILD_ID = 'guild-1';
const ACTIVITY_ID = 'a1';

const translator = { t: (key: string) => key } as unknown as BaseBot['translator'];

const makeRepos = () => ({
  activity: {
    deleteByActivityId: vi.fn().mockResolvedValue(ok(true)),
  },
});

interface BotOverrides {
  readonly guildCached?: boolean;
  readonly hasRepos?: boolean;
}

const makeBot = (repos: ReturnType<typeof makeRepos>, overrides: BotOverrides = {}) => {
  const { guildCached = true, hasRepos = true } = overrides;
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    child: (): unknown => logger,
  };
  return {
    client: { guilds: { cache: guildCached ? new Map([[GUILD_ID, {}]]) : new Map() } },
    getRepos: (guildId: string) => (hasRepos && guildId === GUILD_ID ? repos : undefined),
    guildRegistry: {
      getRepos: (guildId: string) => (hasRepos && guildId === GUILD_ID ? repos : undefined),
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [],
    },
    jobMap: new Map(),
    requireLogger: () => logger,
    logger,
    translator,
  } as unknown as BaseBot;
};

const makeInteraction = (activityId: string | null) =>
  ({
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferred: true,
    replied: false,
    guild: { id: GUILD_ID },
    options: { get: () => (activityId === null ? undefined : { value: activityId }) },
  }) as unknown as ChatInputCommandInteraction;

afterEach(() => vi.clearAllMocks());

describe('handleActivityDelete', () => {
  it('deletes the activity and confirms', async () => {
    const repos = makeRepos();
    const interaction = makeInteraction(ACTIVITY_ID);

    await handleActivityDelete(interaction, makeBot(repos));

    expect(repos.activity.deleteByActivityId).toHaveBeenCalledWith(ACTIVITY_ID);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'replies:activity.delete_success',
    });
  });

  it('answers a missing activity id through the error boundary', async () => {
    const repos = makeRepos();
    const interaction = makeInteraction(null);

    await handleActivityDelete(interaction, makeBot(repos));

    // `activity_id` is declared `required: true`, so an absent value is
    // a contract violation rather than user error: the typed accessor
    // throws and the boundary answers with a trace id.
    expect(repos.activity.deleteByActivityId).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:activity.failed' }),
    );
  });

  it('answers a missing per-guild database with a catalog key', async () => {
    const repos = makeRepos();
    const interaction = makeInteraction(ACTIVITY_ID);

    await handleActivityDelete(interaction, makeBot(repos, { hasRepos: false }));

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'errors:db.not_found' });
  });

  it('answers an unknown guild with the shared guild-not-found key', async () => {
    const repos = makeRepos();
    const interaction = makeInteraction(ACTIVITY_ID);

    await handleActivityDelete(interaction, makeBot(repos, { guildCached: false }));

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:command.guild_not_found',
    });
  });

  it('routes an unexpected failure through the trace-id error boundary', async () => {
    const repos = makeRepos();
    repos.activity.deleteByActivityId.mockRejectedValue(new Error('mongo down'));
    const interaction = makeInteraction(ACTIVITY_ID);

    await handleActivityDelete(interaction, makeBot(repos));

    // `replies:activity.failed` was an orphan key before this wiring.
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'replies:activity.failed' }),
    );
  });
});
