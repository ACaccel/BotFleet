/**
 * `scheduleActivity` outcome union.
 *
 * The deferred participant roll-up used to return raw English sentences
 * ("Guild not found", "Activity channel not found"). They were the only
 * signal a caller had, and the delete handler interpolated the same
 * shape straight into localised copy. Each precondition now has a
 * stable, translatable status.
 */
import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../src/core/result';
import { scheduleActivity } from '../../../src/application/activity/activity';
import type { ActivityDeps } from '../../../src/application/activity/activity';

const GUILD_ID = 'guild-1';
const ACTIVITY_ID = 'a1';
const CHANNEL_ID = 'chan-1';

const activityDoc = () => ({
  activity_id: ACTIVITY_ID,
  message_id: 'msg-1',
  channel_id: CHANNEL_ID,
  title: 'Movie night',
  description: '',
  expired_at: 0,
  participants: [],
});

interface DepsFixture {
  readonly guildCached?: boolean;
  readonly hasRepos?: boolean;
  readonly activity?: ReturnType<typeof activityDoc> | null;
  readonly channelSendable?: boolean;
  readonly messageFound?: boolean;
}

const makeDeps = (fixture: DepsFixture = {}): ActivityDeps => {
  const {
    guildCached = true,
    hasRepos = true,
    activity = activityDoc(),
    channelSendable = true,
    messageFound = true,
  } = fixture;

  const channel = {
    isSendable: () => channelSendable,
    messages: {
      fetch: vi
        .fn()
        .mockResolvedValue(
          messageFound ? { reactions: { cache: { get: () => undefined } } } : null,
        ),
    },
    send: vi.fn().mockResolvedValue(undefined),
  };

  const repos = {
    activity: {
      findByActivityId: vi.fn().mockResolvedValue(ok(activity)),
      setParticipants: vi.fn().mockResolvedValue(ok(true)),
    },
  };

  return {
    client: {
      guilds: {
        cache: guildCached
          ? new Map([
              [
                GUILD_ID,
                {
                  channels: { cache: { get: () => channel } },
                  members: { cache: new Map() },
                },
              ],
            ])
          : new Map(),
      },
    },
    registry: {
      getRepos: () => (hasRepos ? repos : undefined),
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [GUILD_ID],
    },
    jobMap: new Map(),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    translator: { t: (key: string) => key },
  } as unknown as ActivityDeps;
};

describe('scheduleActivity outcomes', () => {
  it('reports completion for a resolvable activity', async () => {
    await expect(scheduleActivity(makeDeps(), GUILD_ID, ACTIVITY_ID)).resolves.toEqual({
      status: 'completed',
    });
  });

  it('reports guild_not_found for an uncached guild', async () => {
    await expect(
      scheduleActivity(makeDeps({ guildCached: false }), GUILD_ID, ACTIVITY_ID),
    ).resolves.toEqual({ status: 'guild_not_found' });
  });

  it('reports no_db when the guild has no repository bag', async () => {
    await expect(
      scheduleActivity(makeDeps({ hasRepos: false }), GUILD_ID, ACTIVITY_ID),
    ).resolves.toEqual({ status: 'no_db' });
  });

  it('reports activity_not_found when the row is gone', async () => {
    await expect(
      scheduleActivity(makeDeps({ activity: null }), GUILD_ID, ACTIVITY_ID),
    ).resolves.toEqual({ status: 'activity_not_found' });
  });

  it('reports channel_not_found when the channel cannot be posted to', async () => {
    await expect(
      scheduleActivity(makeDeps({ channelSendable: false }), GUILD_ID, ACTIVITY_ID),
    ).resolves.toEqual({ status: 'channel_not_found' });
  });

  it('reports message_not_found when the announcement is gone', async () => {
    await expect(
      scheduleActivity(makeDeps({ messageFound: false }), GUILD_ID, ACTIVITY_ID),
    ).resolves.toEqual({ status: 'message_not_found' });
  });
});
