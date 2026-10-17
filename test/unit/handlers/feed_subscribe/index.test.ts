/**
 * `/feed subscribe` end to end, driven entirely through a fake platform.
 *
 * One invocation may name several accounts, so the suite covers both
 * halves of that: the channel is gated once for the whole call, and
 * each account then succeeds or fails on its own.
 *
 * The fake is the point: if any branch here needed X's snowflake
 * arithmetic or its HTTP client, the command would not be the
 * platform-neutral surface the feed framework claims to have.
 *
 * Two properties are pinned deliberately because a future edit would
 * plausibly break them without failing anything else: the reply is
 * ephemeral, and there is no authority gate. The permission checks the
 * command does make are about deliverability and about not writing into
 * a channel the invoker cannot see.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, MessageFlags, PermissionFlagsBits, type Message } from 'discord.js';
import { Types } from 'mongoose';

import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import FeedSubscribe from '../../../../src/handlers/commands/feed_subscribe/action';
import { FEED_BATCH_BUDGET_MS } from '../../../../src/handlers/feed-panel/batch-policy';
import { FeedError } from '../../../../src/core/errors';
import { err, ok } from '../../../../src/core/result';
import {
  FeedPlatformRegistry,
  XPlatform,
  MAX_FEED_ACCOUNTS,
  MAX_FEED_KEYWORD_LENGTH,
  type FeedFailure,
  type FeedPlatform,
} from '../../../../src/infra/social-feed';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildButtonInteraction,
  buildChatInputInteraction,
  buildModalSubmitInteraction,
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import FeedPanelButton from '../../../../src/handlers/buttons/feed_panel';
import FeedPanelModal from '../../../../src/handlers/modals/feed_panel';
import FeedPanelSelect from '../../../../src/handlers/select-menus/feed_panel';
import { panelComponents } from '../feed-panel/helpers';
import { buildFakeFeedPlatform, buildFeedPost } from '../../../fixtures/social-feed/fake-platform';

const GUILD_ID = 'g-1';
const HOME_CHANNEL = 'chan-home';
const OTHER_CHANNEL = 'chan-other';
const THREAD_CHANNEL = 'chan-thread';
const BOT_ID = 'bot-1';
const USER_ID = 'u-1';

const ALL_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
];

const NEWEST_POST = buildFeedPost({ id: '42', createdTimestamp: 1_700_000_500 });

const subscription = (overrides: Partial<FeedSubscriptionDoc> = {}): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform: 'fake',
  account: 'someone',
  channel_id: HOME_CHANNEL,
  created_by: USER_ID,
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
  ...overrides,
});

interface Fixture {
  readonly botPermissions?: readonly bigint[];
  readonly invokerPermissions?: readonly bigint[];
  readonly homeChannelType?: ChannelType;
  readonly platformUnregistered?: boolean;
  /** Leaves `guild.members.me` null, as it is before the member cache fills. */
  readonly botMemberMissing?: boolean;
  /** Leaves the invoker out of the member cache — permissions unknowable. */
  readonly invokerMemberMissing?: boolean;
  readonly invalidAccounts?: ReadonlySet<string>;
  readonly failWith?: FeedFailure;
  readonly posts?: readonly ReturnType<typeof buildFeedPost>[];
  readonly upsertFails?: boolean;
  readonly created?: boolean;
  readonly platformOverrides?: Partial<FeedPlatform>;
  /** Subscription the repository already holds for this triple. */
  readonly existing?: FeedSubscriptionDoc;
  readonly options?: Readonly<Record<string, string | null>>;
  readonly channelOption?: string;
  readonly edits?: { readonly media?: string; readonly keyword?: string };
  /** Save interaction age, which is what the batch budget is measured from. */
  readonly saveCreatedTimestamp?: number;
}

const editorFixtures = new WeakMap<
  ReturnType<typeof buildChatInputInteraction>,
  {
    sink: ReturnType<typeof newInteractionSink>;
    edits: NonNullable<Fixture['edits']>;
    saveCreatedTimestamp?: number;
  }
>();

const build = (fixture: Fixture = {}) => {
  const { platform, fetchTimeline } = buildFakeFeedPlatform({
    posts: fixture.posts ?? [NEWEST_POST],
    ...(fixture.failWith === undefined ? {} : { failWith: fixture.failWith }),
    ...(fixture.invalidAccounts === undefined ? {} : { invalidAccounts: fixture.invalidAccounts }),
  });

  const permissionsBySubject = {
    [BOT_ID]: fixture.botPermissions ?? ALL_BOT_PERMISSIONS,
    [USER_ID]: fixture.invokerPermissions ?? [PermissionFlagsBits.ViewChannel],
  };
  const parent = buildTextChannel({ id: 'chan-parent', permissionsBySubject });
  const channels = [
    buildTextChannel({
      id: HOME_CHANNEL,
      type: fixture.homeChannelType ?? ChannelType.GuildText,
      permissionsBySubject,
    }),
    buildTextChannel({ id: OTHER_CHANNEL, permissionsBySubject }),
    parent,
    // A thread carries no overwrites of its own; the parent answers.
    buildTextChannel({ id: THREAD_CHANNEL, type: ChannelType.PublicThread, parent }),
  ];
  const guild = buildGuild({
    id: GUILD_ID,
    channels,
    members: fixture.invokerMemberMissing === true ? [] : [{ id: USER_ID }],
    me: fixture.botMemberMissing === true ? null : { id: BOT_ID },
  });

  const find = vi.fn(async () => ok(fixture.existing));
  const upsert = vi.fn(async (_input: unknown) =>
    fixture.upsertFails === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok({ doc: subscription(), created: fixture.created ?? fixture.existing === undefined }),
  );
  const getRepos = vi.fn(() => ({ feedSubscription: { find, upsert } }));
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    feedPlatformRegistry: new FeedPlatformRegistry(
      fixture.platformUnregistered === true ? [] : [{ ...platform, ...fixture.platformOverrides }],
    ),
    connectionManager: { isDisabled: () => undefined },
    getRepos,
    // Every fixture runs as a plain member.
    isAdmin: () => false,
  });

  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'feed_subscribe',
    guild,
    userId: USER_ID,
    channel: { id: HOME_CHANNEL },
    options: { platform: 'fake', target: '@SomeOne', ...fixture.options },
    ...(fixture.channelOption === undefined
      ? {}
      : { channels: { channel: { id: fixture.channelOption } } }),
    sink,
  });

  editorFixtures.set(interaction, {
    sink,
    edits: fixture.edits ?? {},
    saveCreatedTimestamp: fixture.saveCreatedTimestamp,
  });
  return { bot, interaction, sink, find, upsert, fetchTimeline, getRepos, logger };
};

/** Drive the public editor instead of relying on retired slash filter options. */
const executeAndSave = async (
  interaction: ReturnType<typeof buildChatInputInteraction>,
  bot: ReturnType<typeof buildFakeBot>['bot'],
): Promise<void> => {
  const context = editorFixtures.get(interaction);
  if (!context) throw new Error('Missing editor test context');
  const { sink, edits } = context;
  await new FeedSubscribe().execute(interaction, bot);
  const save = panelComponents(sink.editReplies.at(-1)).find((component) =>
    component.custom_id?.includes('|save|'),
  );
  if (!save?.custom_id) return;
  const message = { id: 'reply-1', applicationId: interaction.applicationId } as Message;
  const common = { guild: interaction.guild!, message, userId: interaction.user.id, sink };
  const prefix = save.custom_id.replace('|save|', '|');
  if (edits.media !== undefined) {
    await new FeedPanelSelect().execute(
      buildStringSelectInteraction({
        ...common,
        customId: `${prefix}media|`,
        values: [edits.media],
      }),
      bot,
    );
  }
  if (edits.keyword !== undefined) {
    const modalSink = newInteractionSink();
    await new FeedPanelButton().execute(
      buildButtonInteraction({
        ...common,
        customId: `${prefix}keyword|`,
        sink: modalSink,
      }),
      bot,
    );
    const modal = modalSink.modals[0] as { toJSON(): { custom_id: string } };
    const previousErrors = sink.followUps.length + sink.replies.length;
    await new FeedPanelModal().execute(
      buildModalSubmitInteraction({
        ...common,
        customId: modal.toJSON().custom_id,
        textInputs: { keyword: edits.keyword },
      }),
      bot,
    );
    if (sink.followUps.length + sink.replies.length > previousErrors) return;
  }
  await new FeedPanelButton().execute(
    buildButtonInteraction({
      ...common,
      customId: save.custom_id,
      createdTimestamp: context.saveCreatedTimestamp ?? Date.now(),
    }),
    bot,
  );
};

/**
 * Everything the command put on screen: the edited deferred reply plus
 * any follow-up page. The report is paginated, so an assertion that
 * looked only at `editReplies` would silently stop covering the tail.
 */
const reply = (sink: ReturnType<typeof newInteractionSink>): string =>
  [...sink.replies, ...sink.editReplies, ...sink.followUps]
    .map((message) => message.content ?? '')
    .join('\n');

describe('/feed subscribe', () => {
  it('opens an ephemeral draft without fetching a timeline or writing before Save', async () => {
    const { bot, interaction, sink, fetchTimeline, upsert } = build();
    await new FeedSubscribe().execute(interaction, bot);
    expect(sink.defers[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(reply(sink)).toContain('replies:feed.panel.save_notice');
    expect(
      panelComponents(sink.editReplies.at(-1)).map(
        (component) => component.custom_id?.split('|')[2],
      ),
    ).toEqual(['media', 'keyword', 'save', 'cancel']);
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('preloads an existing single target without resetting its filters', async () => {
    const { bot, interaction, sink, find, fetchTimeline, upsert } = build({
      existing: subscription({ filter: { media: 'photo_only', keyword: 'stored' } }),
    });
    await new FeedSubscribe().execute(interaction, bot);
    expect(find).toHaveBeenCalledWith('fake', 'someone', HOME_CHANNEL);
    expect(reply(sink)).toContain('stored');
    expect(panelComponents(sink.editReplies.at(-1))[0]?.options).toContainEqual(
      expect.objectContaining({ value: 'photo_only', default: true }),
    );
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'replaced'] as const)(
    'rejects an existing single target %s while its draft was open',
    async (state) => {
      const { bot, interaction, sink, find, fetchTimeline, upsert } = build({
        existing: subscription(),
      });
      await new FeedSubscribe().execute(interaction, bot);
      find.mockResolvedValue(ok(state === 'deleted' ? undefined : subscription()));
      const save = panelComponents(sink.editReplies.at(-1)).find((component) =>
        component.custom_id?.includes('|save|'),
      );
      expect(save?.custom_id).toBeTruthy();
      await new FeedPanelButton().execute(
        buildButtonInteraction({
          guild: interaction.guild!,
          message: { id: 'reply-1', applicationId: interaction.applicationId } as Message,
          customId: save!.custom_id!,
          sink,
        }),
        bot,
      );
      expect(reply(sink)).toContain('replies:feed.panel.expired');
      expect(upsert).not.toHaveBeenCalled();
      expect(fetchTimeline).not.toHaveBeenCalled();
    },
  );

  it('shows a shared batch filter before Save and applies it to each valid target', async () => {
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      options: { target: 'alpha, beta' },
      edits: { media: 'photo_only', keyword: 'live OR album' },
    });
    await new FeedSubscribe().execute(interaction, bot);
    expect(reply(sink)).toContain('replies:feed.panel.batch_notice');
    expect(upsert).not.toHaveBeenCalled();
    expect(fetchTimeline).not.toHaveBeenCalled();
    // A fresh command follows the same editor path with explicit edits and Save.
    const saved = build({
      options: { target: 'alpha, beta' },
      edits: { media: 'photo_only', keyword: 'live OR album' },
    });
    await executeAndSave(saved.interaction, saved.bot);
    expect(saved.upsert).toHaveBeenCalledTimes(2);
    for (const [input] of saved.upsert.mock.calls)
      expect(input).toMatchObject({ filter: { media: 'photo_only', keyword: 'live OR album' } });
  });

  it('stops a batch on rate limits and reports the remaining targets as skipped', async () => {
    const rateLimited = new FeedError({
      code: 'FEED_RATE_LIMITED',
      messageKey: 'errors:feed.rate_limited',
      messageParams: { platform: 'Fake', account: 'beta' },
      context: { operation: 'test' },
    });
    const { bot, interaction, sink, fetchTimeline, upsert } = build({
      options: { target: 'alpha, beta, gamma' },
    });
    fetchTimeline.mockResolvedValueOnce(ok([NEWEST_POST])).mockResolvedValueOnce(err(rateLimited));
    await executeAndSave(interaction, bot);
    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(reply(sink)).toContain('replies:feed.account_failed');
    expect(reply(sink)).toContain('replies:feed.account_skipped:{"account":"@gamma"}');
  });

  it('stops a batch on database failures without fetching later targets', async () => {
    const { bot, interaction, sink, fetchTimeline, upsert } = build({
      upsertFails: true,
      options: { target: 'alpha, beta, gamma' },
    });
    await executeAndSave(interaction, bot);
    expect(fetchTimeline).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(reply(sink)).toContain('replies:feed.account_failed');
    expect(reply(sink)).toContain('replies:feed.account_skipped:{"account":"@beta"}');
    expect(reply(sink)).toContain('replies:feed.account_skipped:{"account":"@gamma"}');
  });

  it('exposes only platform, target, and optional channel in the Discord payload', () => {
    const body = buildCommandJsonBody(
      localizeCommandConfig(new FeedSubscribe().config, echoTranslatorWithParams()),
    ) as { readonly options?: readonly { readonly name: string; readonly required?: boolean }[] };

    expect(body.options).toContainEqual(
      expect.objectContaining({ name: 'target', required: true }),
    );
    expect(body.options?.map(({ name }) => name)).toEqual(['platform', 'target', 'channel']);
    expect(body.options).toContainEqual(
      expect.objectContaining({ name: 'channel', required: false }),
    );
  });

  it('defaults missing media to media_only for platforms without a declared default', async () => {
    const { bot, interaction, upsert } = build();

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'media_only' } }),
    );
  });

  it.each([false, true])(
    'defaults new X targets and preloads existing media (existing: %s)',
    async (existing) => {
      const x = new XPlatform({ timeoutMs: 8000, embedProxyHost: 'fxtwitter.com' });
      const { bot, interaction, upsert } = build({
        options: { platform: 'x' },
        existing: existing ? subscription() : undefined,
        platformOverrides: {
          id: x.id,
          displayName: x.displayName,
          defaultMediaFilter: x.defaultMediaFilter,
        },
      });
      await executeAndSave(interaction, bot);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { media: existing ? 'media_only' : 'any' } }),
      );
      if (existing) {
        expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_seen_id');
        expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_seen_timestamp');
      }
    },
  );

  it("preloads Bahamut's existing filter and preserves its cursor", async () => {
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      options: { platform: 'bahamut', target: 'board:36476' },
      existing: subscription({ account: 'board:36476', filter: { media: 'photo_only' } }),
      platformOverrides: {
        id: 'bahamut',
        displayName: 'Bahamut',
        defaultMediaFilter: 'any',
        normalizeAccount: async () => ok('board:36476'),
      },
    });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'photo_only' } }),
    );
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_seen_id');
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty('last_seen_timestamp');
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(reply(sink)).toContain('replies:feed.target_board');
    expect(reply(sink)).not.toContain('@board:36476');
  });

  it('honors an explicit media filter over the platform default', async () => {
    const { bot, interaction, upsert } = build({
      edits: { media: 'video_only' },
      platformOverrides: { defaultMediaFilter: 'any' },
    });
    await executeAndSave(interaction, bot);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'video_only' } }),
    );
  });

  it('subscribes using target', async () => {
    const { bot, interaction, upsert } = build({
      options: { target: '@NewTarget' },
    });
    await executeAndSave(interaction, bot);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ account: 'newtarget' }));
  });

  it('rejects a missing target without fetching or writing', async () => {
    const { bot, interaction, sink, fetchTimeline, upsert } = build({ options: { target: null } });
    await executeAndSave(interaction, bot);
    expect(reply(sink)).toContain('replies:feed.no_accounts');
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('answers ephemerally, so a subscription never leaks into the channel', () => {
    const { bot, interaction, sink } = build();

    return executeAndSave(interaction, bot).then(() => {
      expect(sink.defers[0]?.flags).toBe(MessageFlags.Ephemeral);
    });
  });

  it('creates the subscription with a normalised account and a seeded cursor', async () => {
    const { bot, interaction, sink, upsert } = build();

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith({
      platform: 'fake',
      account: 'someone',
      channel_id: HOME_CHANNEL,
      created_by: USER_ID,
      filter: { media: 'media_only' },
      last_seen_id: '42',
      last_seen_timestamp: 1_700_000_500,
    });
    const content = reply(sink);
    expect(content).toContain('replies:feed.account_subscribed');
    // The confirmation must describe what was actually written.
    expect(content).toContain('"account":"@someone"');
    expect(content).toContain('"platform":"Fake"');
    expect(content).toContain(`"channel":"<#${HOME_CHANNEL}>"`);
  });

  it('anchors a brand-new subscription on the clock when the timeline is empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const { bot, interaction, upsert } = build({ posts: [] });

      await executeAndSave(interaction, bot);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          last_seen_id: String(1_700_000_000_000),
          last_seen_timestamp: 1_700_000_000,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the chosen filter options into the stored subscription, and back to the member', async () => {
    const { bot, interaction, sink, upsert } = build({
      edits: { media: 'video_only', keyword: 'live' },
    });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'video_only', keyword: 'live' } }),
    );
    const content = reply(sink);
    expect(content).toContain('replies:feed.filter_media.video_only');
    expect(content).toContain('replies:feed.filter_keyword');
  });

  it('explicit media and blank keyword edits replace the stored filter, and say so', async () => {
    // Clearing is explicit: opening an existing target preserves its old filter.
    const { bot, interaction, sink, upsert } = build({
      existing: subscription({ filter: { media: 'video_only', keyword: 'live' } }),
      edits: { media: 'media_only', keyword: '' },
    });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { media: 'media_only' } }),
    );
    const content = sink.editReplies.at(-1)?.content ?? '';
    expect(content).toContain('replies:feed.account_updated');
    expect(content).toContain('replies:feed.filter_media.media_only');
    expect(content).not.toContain('replies:feed.filter_keyword');
  });

  it('never reads the upstream when the subscription already exists', async () => {
    // Changing a filter must not depend on the platform being up.
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      existing: subscription(),
    });

    await executeAndSave(interaction, bot);

    expect(fetchTimeline).not.toHaveBeenCalled();
    // No cursor fields, so the stored cursor survives the update.
    const written = (upsert.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect('last_seen_id' in written).toBe(false);
    expect('last_seen_timestamp' in written).toBe(false);
    expect(reply(sink)).toContain('replies:feed.account_updated');
  });

  it('subscribes the invoking channel when no channel option is given', async () => {
    const { bot, interaction, upsert } = build();

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ channel_id: HOME_CHANNEL }));
  });

  it('subscribes the chosen channel when the option is given', async () => {
    const { bot, interaction, sink, upsert } = build({ channelOption: OTHER_CHANNEL });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ channel_id: OTHER_CHANNEL }));
    expect(reply(sink)).toContain(`"channel":"<#${OTHER_CHANNEL}>"`);
  });

  it('accepts a thread when the bot may post in threads', async () => {
    const { bot, interaction, upsert } = build({ channelOption: THREAD_CHANNEL });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ channel_id: THREAD_CHANNEL }));
  });

  it('refuses a thread the bot may only post in the parent of', async () => {
    // `SendMessages` on the parent does not grant posting in a thread.
    const { bot, interaction, sink, upsert } = build({
      channelOption: THREAD_CHANNEL,
      botPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.SendMessages,
      ],
    });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.permission.send_messages_in_threads');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured platform without touching the database', async () => {
    const { bot, interaction, sink, upsert, find } = build({ platformUnregistered: true });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('errors:feed.platform_not_configured');
    expect(find).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a channel that cannot carry messages', async () => {
    const { bot, interaction, sink, upsert } = build({
      homeChannelType: ChannelType.GuildCategory,
    });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.channel_not_supported');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a channel the bot cannot see at all', async () => {
    // A cache miss means a channel this bot has no view of, which is as
    // unusable a destination as a category.
    const { bot, interaction, sink, upsert } = build({ channelOption: 'chan-not-in-cache' });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.channel_not_supported');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('names the permission the bot is missing, translated, and writes nothing', async () => {
    const { bot, interaction, sink, upsert } = build({
      botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
    });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.missing_bot_permissions');
    expect(content).toContain('replies:feed.permission.send_messages');
    // The two it holds are not named — that would send an operator to
    // fix a permission that is already correct.
    expect(content).not.toContain('replies:feed.permission.embed_links');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('says permissions are unknown rather than denied when the bot member is unresolved', async () => {
    const { bot, interaction, sink, upsert } = build({ botMemberMissing: true });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.permissions_unknown');
    expect(reply(sink)).not.toContain('replies:feed.missing_bot_permissions');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('says permissions are unknown when the invoker is not in the member cache', async () => {
    const { bot, interaction, sink } = build({ invokerMemberMissing: true });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.invoker_permissions_unknown');
    expect(reply(sink)).not.toContain('replies:feed.invoker_cannot_view');
  });

  it('refuses a channel the invoker cannot see', async () => {
    const { bot, interaction, sink, upsert } = build({ invokerPermissions: [] });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.invoker_cannot_view');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('checks the invoker before the bot, so an invisible channel leaks no bot permissions', async () => {
    // Both checks would refuse. The invoker's must win: telling someone
    // which permissions the bot lacks in a channel confirms the channel
    // exists and describes the bot's access to a room closed to them.
    const { bot, interaction, sink, upsert } = build({
      invokerPermissions: [],
      botPermissions: [PermissionFlagsBits.ViewChannel],
    });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.invoker_cannot_view');
    expect(content).not.toContain('replies:feed.missing_bot_permissions');
    expect(content).not.toContain('replies:feed.permission.send_messages');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid handle before reading the upstream', async () => {
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      invalidAccounts: new Set(['someone']),
    });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('errors:feed.invalid_account');
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('surfaces an upstream failure and writes nothing', async () => {
    const { bot, interaction, sink, upsert } = build({
      failWith: new FeedError({
        code: 'FEED_NOT_FOUND',
        messageKey: 'errors:feed.not_found',
        messageParams: { platform: 'Fake', account: 'someone', status: '404' },
        context: { operation: 'test' },
      }),
    });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('errors:feed.not_found');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reports a refused write against the account, not as a failed command', async () => {
    // A database error now costs the account it happened on. Routing it
    // to the traced `replies:feed.failed` copy would throw away the
    // accounts that were written before and after it.
    const { bot, interaction, sink } = build({ upsertFails: true });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.account_failed');
    expect(content).not.toContain('replies:feed.failed');
  });

  it('lets a non-admin member subscribe', async () => {
    // Subscriptions are ungated on purpose. This asserts the
    // absence of a gate so adding `bot.isAdmin` here fails loudly.
    const { bot, interaction, sink, upsert } = build();

    await executeAndSave(interaction, bot);

    expect(bot.isAdmin(USER_ID)).toBe(false);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(reply(sink)).toContain('replies:feed.account_subscribed');
  });

  it('subscribes every account a single invocation names', async () => {
    const { bot, interaction, sink, upsert } = build({
      options: { target: 'alpha, @Beta gamma' },
    });

    await executeAndSave(interaction, bot);

    expect(upsert.mock.calls.map(([input]) => (input as { account: string }).account)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    const content = reply(sink);
    for (const account of ['alpha', 'beta', 'gamma']) {
      expect(content).toContain(`"account":"@${account}"`);
    }
  });

  it('gates the channel once for the whole batch, not once per account', async () => {
    // The permission check is the expensive, member-visible part; a
    // per-account gate would also let a report contradict itself.
    const { bot, interaction, sink, upsert } = build({
      invokerPermissions: [],
      options: { target: 'alpha, beta, gamma' },
    });

    await executeAndSave(interaction, bot);

    expect(sink.editReplies).toHaveLength(1);
    expect(reply(sink)).toContain('replies:feed.invoker_cannot_view');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('subscribes the good accounts around one the platform rejects', async () => {
    const { bot, interaction, sink, upsert } = build({
      invalidAccounts: new Set(['banned']),
      options: { target: 'alpha, banned, gamma' },
    });

    await executeAndSave(interaction, bot);

    expect(upsert.mock.calls.map(([input]) => (input as { account: string }).account)).toEqual([
      'alpha',
      'gamma',
    ]);
    const content = reply(sink);
    expect(content).toContain('replies:feed.account_failed');
    expect(content).toContain('errors:feed.invalid_account');
    expect(content).toContain('"account":"@alpha"');
  });

  it('records the whole batch in the operator log, failures included', async () => {
    // Per-account failures never reach the error boundary, so this line
    // is the only place an operator sees one.
    const { bot, interaction, logger } = build({
      invalidAccounts: new Set(['banned']),
      options: { target: 'alpha, banned' },
    });

    await executeAndSave(interaction, bot);

    const logged = logger.info.mock.calls.flat().join(' ');
    expect(logged).toContain('feed.subscriptions_processed');
    expect(logged).toContain('@alpha created');
    expect(logged).toContain('@banned failed(FEED_INVALID_ACCOUNT)');
  });

  it('sends every absorbed failure to the operator error channel', async () => {
    // The batch summary carries the shape of the run; this is what keeps
    // the stack and the cause of an individual failure diagnosable.
    const { bot, interaction, logger } = build({
      invalidAccounts: new Set(['banned']),
      options: { target: 'alpha, banned' },
    });

    await executeAndSave(interaction, bot);

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('attempts nothing once the Save interaction is too old to answer', async () => {
    // The budget runs from when Discord created the interaction, not
    // from when the batch starts, or a slow command would spend a full
    // budget it no longer has.
    const { bot, interaction, sink, upsert } = build({
      saveCreatedTimestamp: Date.now() - FEED_BATCH_BUDGET_MS - 1,
      options: { target: 'alpha, beta' },
    });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.account_skipped');
    expect(content).not.toContain('replies:feed.account_subscribed');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a list past the cap without writing or reading anything', async () => {
    const tooMany = Array.from({ length: MAX_FEED_ACCOUNTS + 1 }, (_, i) => `a${String(i)}`);
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      options: { target: tooMany.join(',') },
    });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.too_many_accounts');
    expect(content).toContain(`"max":${String(MAX_FEED_ACCOUNTS)}`);
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('stores a keyword expression as typed', async () => {
    const { bot, interaction, upsert } = build({
      edits: { keyword: ' live OR (album AND tour) ' },
    });

    await executeAndSave(interaction, bot);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ keyword: 'live OR (album AND tour)' }),
      }),
    );
  });

  it('refuses a malformed keyword expression before reading or writing anything', async () => {
    const { bot, interaction, sink, upsert, fetchTimeline } = build({
      edits: { keyword: 'live OR (album' },
    });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.keyword_invalid');
    expect(fetchTimeline).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses an over-long keyword instead of storing a truncated expression', async () => {
    const { bot, interaction, sink, upsert } = build({
      edits: { keyword: 'a'.repeat(MAX_FEED_KEYWORD_LENGTH + 1) },
    });

    await executeAndSave(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.keyword_too_long');
    expect(content).toContain(`"max":${String(MAX_FEED_KEYWORD_LENGTH)}`);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses an option that names no account at all', async () => {
    const { bot, interaction, sink, upsert } = build({ options: { target: ' , @ ' } });

    await executeAndSave(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.no_accounts');
    expect(upsert).not.toHaveBeenCalled();
  });
});
