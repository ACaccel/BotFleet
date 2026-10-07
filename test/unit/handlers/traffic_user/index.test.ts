/**
 * Privacy-invariant coverage for the `/traffic user` handler. The visible
 * channel set is gated by the INVOKER (clearance + native ViewChannel)
 * while the stats focus the TARGET:
 *   - a target active only in an invoker-hidden channel yields the neutral
 *     no-data reply (the hidden activity is never counted or surfaced),
 *   - an invoker who is active but is NOT the target also yields no-data
 *     (the focus is the target, never the invoker),
 *   - a target active in a visible channel renders the stats.
 */
import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import type { BaseBot } from '@bot';

import { createPermissionRankPolicy } from '../../../../src/core/plugin';
import { ok } from '../../../../src/core/result';
import TrafficUser from '../../../../src/handlers/commands/traffic';
import type { Repos } from '../../../../src/persistence/repositories';
import type { MessageDoc } from '../../../../src/persistence/schemas/message.schema';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const GUILD = 'g1';
const INVOKER = 'invoker';
const TARGET = 'target';
const DAY = 86_400_000;
const NO_DATA = 'replies:traffic_user.no_data';

// Invoker is unranked -> clearance ceiling 0. 'pub' is rank-0 (visible);
// 'secret' is rank-2, above the invoker, so it stays invisible to them
// regardless of native ViewChannel.
const policy = createPermissionRankPolicy({
  [GUILD]: { channels: { secret: 2 }, roles: {} },
});

let seq = 0;
const doc = (channelId: string, userId: string): MessageDoc =>
  ({
    channelId,
    channelName: `name-${channelId}`,
    userId,
    userName: `user-${userId}`,
    content: '',
    messageId: `m-${seq++}`,
    attachments: [],
    reactions: [],
    stickers: [],
    // Relative to the handler's own `Date.now()` window, not a fixed epoch.
    timestamp: Date.now() - DAY,
  }) as unknown as MessageDoc;

const fakeRepo = (docs: readonly MessageDoc[]): Pick<Repos, 'message'> =>
  ({
    message: {
      findByTimestampRange: async (start: number, end: number) =>
        ok(docs.filter((d) => d.timestamp >= start && d.timestamp < end)),
    },
  }) as unknown as Pick<Repos, 'message'>;

const makeBot = (docs: readonly MessageDoc[]): BaseBot =>
  ({
    translator: { t: (key: string) => key },
    getRepos: () => fakeRepo(docs),
    permissionRankPolicy: policy,
  }) as unknown as BaseBot;

interface ReplyPayload {
  readonly content?: string;
  readonly embeds?: readonly unknown[];
}

const channels = (): ReturnType<typeof buildTextChannel>[] => [
  buildTextChannel({ id: 'pub', viewableByAll: true }),
  buildTextChannel({ id: 'secret', viewableByAll: true }),
];

const runHandler = async (docs: readonly MessageDoc[]): Promise<ReplyPayload[]> => {
  const edits: ReplyPayload[] = [];
  const invokerMember = buildGuildMember({ id: INVOKER, roleIds: [] });
  const guild = buildGuild({ id: GUILD, channels: channels() });
  (guild.members as unknown as { fetch: (id: string) => Promise<unknown> }).fetch = async () =>
    invokerMember;
  const interaction = {
    guild,
    guildId: GUILD,
    channelId: 'pub',
    user: { id: INVOKER },
    options: {
      getSubcommand: () => 'user',
      getSubcommandGroup: () => null,
      get: () => null,
      getUser: () => ({ id: TARGET, username: 'target-name' }),
      getMember: () => null,
    },
    deferReply: async () => {},
    editReply: async (payload: ReplyPayload) => {
      edits.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;

  await new TrafficUser().execute(interaction, makeBot(docs));
  return edits;
};

describe('/traffic user privacy invariant', () => {
  it('excludes the target activity in channels the invoker cannot see', async () => {
    // Target is busy only in `secret`, which the unranked invoker cannot see.
    const edits = await runHandler([doc('secret', TARGET), doc('secret', TARGET)]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe(NO_DATA);
    expect(edits[0]?.embeds).toBeUndefined();
  });

  it('focuses the target, not the invoker, even when the invoker is active', async () => {
    // The invoker is active in a visible channel; the target is not. If the
    // handler aggregated the invoker, it would render stats — it must not.
    const edits = await runHandler([doc('pub', INVOKER), doc('pub', INVOKER)]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe(NO_DATA);
  });

  it('renders the stats for the target activity in a visible channel', async () => {
    const edits = await runHandler([doc('pub', TARGET)]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBeUndefined();
    expect(edits[0]?.embeds).toHaveLength(2);
  });
});
