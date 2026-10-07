/**
 * `/feed_list`'s Discord side: who sees which rows, the paging hand-off
 * from `editReply` to `followUp`, and the failure boundary.
 *
 * Rendering itself is covered by `format-subscriptions.test.ts`. What
 * matters here is that the listing is bounded by the invoker's own
 * channel access, that a multi-page reply arrives complete and in
 * order, and that it stays ephemeral throughout.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Types } from 'mongoose';

import FeedList from '../../../../src/handlers/commands/feed_list/action';
import { formatSubscriptionPages } from '../../../../src/handlers/commands/feed_list/format-subscriptions';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GUILD_ID = 'g-1';
const USER_ID = 'u-1';
const OPEN_CHANNEL = 'chan-open';
const PRIVATE_CHANNEL = 'chan-private';

/** Echo translator matching the one the fake bot installs. */
const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`;

const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'fake',
  // Long enough that sixty of them cannot fit in one message.
  account: 'account-x'.padEnd(40, 'x'),
  channel_id: OPEN_CHANNEL,
  created_by: USER_ID,
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
  ...overrides,
});

const manyIn = (channelId: string, count: number): FeedSubscriptionDoc[] =>
  Array.from({ length: count }, (_, index) =>
    subscription({ channel_id: channelId, account: `account-${String(index)}`.padEnd(40, 'x') }),
  );

const build = (fixture: { docs?: readonly FeedSubscriptionDoc[]; repoFails?: boolean } = {}) => {
  const guild = buildGuild({
    id: GUILD_ID,
    channels: [
      buildTextChannel({
        id: OPEN_CHANNEL,
        permissionsBySubject: { [USER_ID]: [PermissionFlagsBits.ViewChannel] },
      }),
      // The invoker holds nothing here, so its rows must not appear.
      buildTextChannel({ id: PRIVATE_CHANNEL, permissionsBySubject: { [USER_ID]: [] } }),
    ],
    members: [{ id: USER_ID }],
  });
  const list = vi.fn(async () =>
    fixture.repoFails === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok(fixture.docs ?? []),
  );
  const { bot } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    connectionManager: { isDisabled: () => undefined },
    getRepos: () => ({ feedSubscription: { list } }),
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'feed_list',
    guild,
    userId: USER_ID,
    sink,
  });
  return { bot, interaction, sink, list };
};

/** Everything the command put on screen, in delivery order. */
const sentPages = (sink: ReturnType<typeof newInteractionSink>): string[] => [
  sink.editReplies[0]?.content ?? '',
  ...sink.followUps.map((f) => f.content ?? ''),
];

describe('/feed_list', () => {
  it('answers ephemerally', async () => {
    const { bot, interaction, sink } = build();

    await new FeedList().execute(interaction, bot);

    expect(sink.defers[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('reports an empty list without paging anything', async () => {
    const { bot, interaction, sink } = build();

    await new FeedList().execute(interaction, bot);

    expect(sink.editReplies).toHaveLength(1);
    expect(sink.editReplies[0]?.content).toContain('replies:feed.list_empty');
    expect(sink.followUps).toHaveLength(0);
  });

  it('hides subscriptions in channels the invoker cannot see', async () => {
    const { bot, interaction, sink } = build({
      docs: [
        subscription({ channel_id: OPEN_CHANNEL, account: 'visible' }),
        subscription({ channel_id: PRIVATE_CHANNEL, account: 'secret' }),
      ],
    });

    await new FeedList().execute(interaction, bot);

    const content = sentPages(sink).join('\n');
    expect(content).toContain('@visible');
    expect(content).not.toContain('@secret');
    expect(content).not.toContain(PRIVATE_CHANNEL);
  });

  it('counts only what it shows, and hints at nothing it withheld', async () => {
    // A "1 more you cannot see" would leak the very fact the channel's
    // permissions exist to hide.
    const { bot, interaction, sink } = build({
      docs: [
        subscription({ channel_id: OPEN_CHANNEL }),
        subscription({ channel_id: PRIVATE_CHANNEL }),
      ],
    });

    await new FeedList().execute(interaction, bot);

    expect(sink.editReplies[0]?.content).toContain('replies:feed.list_header:{"total":1}');
  });

  it('reports an empty list when every subscription is out of reach', async () => {
    const { bot, interaction, sink } = build({
      docs: [subscription({ channel_id: PRIVATE_CHANNEL })],
    });

    await new FeedList().execute(interaction, bot);

    expect(sink.editReplies[0]?.content).toContain('replies:feed.list_empty');
  });

  it('sends a single-page list as the deferred reply alone', async () => {
    const { bot, interaction, sink } = build({ docs: [subscription()] });

    await new FeedList().execute(interaction, bot);

    expect(sink.editReplies[0]?.content).toContain('replies:feed.list_header');
    expect(sink.followUps).toHaveLength(0);
  });

  it('delivers every page, in the order the formatter produced them', async () => {
    const docs = manyIn(OPEN_CHANNEL, 60);
    const { bot, interaction, sink } = build({ docs });

    await new FeedList().execute(interaction, bot);

    expect(sink.followUps.length).toBeGreaterThan(0);
    expect(sentPages(sink)).toEqual([...formatSubscriptionPages(docs, t)]);
  });

  it('keeps the overflow pages ephemeral', async () => {
    const { bot, interaction, sink } = build({ docs: manyIn(OPEN_CHANNEL, 60) });

    await new FeedList().execute(interaction, bot);

    for (const followUp of sink.followUps) {
      expect(followUp.flags).toBe(MessageFlags.Ephemeral);
    }
  });

  it('falls back to the traced failure copy when the database refuses', async () => {
    const { bot, interaction, sink } = build({ repoFails: true });

    await new FeedList().execute(interaction, bot);

    expect(sink.editReplies).toHaveLength(1);
    expect(sink.editReplies[0]?.content).toContain('replies:feed.failed');
    expect(sink.editReplies[0]?.content).toContain('traceId');
  });
});
