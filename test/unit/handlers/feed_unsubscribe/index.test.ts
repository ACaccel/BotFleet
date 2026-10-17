/**
 * `/feed unsubscribe` — the deletion scope it builds, who may build it,
 * and what it reports back.
 *
 * The scope is the whole risk: too wide and a member clears
 * subscriptions nobody asked to remove, too narrow and the command
 * silently does nothing. Every option combination therefore asserts on
 * the exact `deleteWhere` query, not just on the reply. The `target`
 * option accepts a list, which widens that scope one more way.
 *
 * The widest scope of all — the whole channel — deletes nothing here:
 * it counts and asks. Those tests assert that no deletion is even
 * attempted, because an after-the-fact confirmation is not an undo.
 */
import { describe, expect, it, vi } from 'vitest';
import { ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { Types } from 'mongoose';

import FeedUnsubscribe from '../../../../src/handlers/commands/feed_unsubscribe/action';
import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import { MAX_LISTED_REMOVALS } from '../../../../src/handlers/feed-removed-list';
import { err, ok } from '../../../../src/core/result';
import { FeedError } from '../../../../src/core/errors';
import type * as SocialFeed from '../../../../src/infra/social-feed';
import {
  FeedPlatformRegistry,
  MAX_FEED_ACCOUNTS,
  normalizeBahamutTargetOffline,
  type FeedPlatform,
} from '../../../../src/infra/social-feed';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { echoTranslator } from '../../../fixtures/runtime';
import { buildFakeFeedPlatform } from '../../../fixtures/social-feed/fake-platform';

const GUILD_ID = 'g-1';
const HOME_CHANNEL = 'chan-home';
const OTHER_CHANNEL = 'chan-other';
const THREAD_CHANNEL = 'chan-thread';
const USER_ID = 'u-1';

vi.mock('../../../../src/infra/social-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof SocialFeed>()),
  normalizeBahamutTargetOffline: vi.fn(),
}));

/** Any option that narrows the scope, so the command deletes at once. */
const NARROWED = { platform: 'fake' } as const;

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
  readonly deleted?: readonly FeedSubscriptionDoc[];
  /** What the channel currently holds, as `listByChannel` answers it. */
  readonly existing?: readonly FeedSubscriptionDoc[];
  readonly repoFails?: boolean;
  readonly options?: Readonly<Record<string, string>>;
  readonly channelOption?: string;
  /** Permissions the invoker holds in every channel; defaults to ViewChannel. */
  readonly invokerPermissions?: readonly bigint[];
  /** Leaves the invoker out of the member cache — permissions unknowable. */
  readonly invokerMemberMissing?: boolean;
  readonly platformOverrides?: Partial<FeedPlatform>;
}

const build = (fixture: Fixture = {}) => {
  const { platform } = buildFakeFeedPlatform({ invalidAccounts: new Set(['banned']) });
  const permissionsBySubject = {
    [USER_ID]: fixture.invokerPermissions ?? [PermissionFlagsBits.ViewChannel],
  };
  const parent = buildTextChannel({ id: 'chan-parent', permissionsBySubject });
  const guild = buildGuild({
    id: GUILD_ID,
    channels: [
      buildTextChannel({ id: HOME_CHANNEL, permissionsBySubject }),
      buildTextChannel({ id: OTHER_CHANNEL, permissionsBySubject }),
      parent,
      // A thread carries no overwrites of its own; the parent answers.
      buildTextChannel({ id: THREAD_CHANNEL, type: ChannelType.PublicThread, parent }),
    ],
    members: fixture.invokerMemberMissing === true ? [] : [{ id: USER_ID }],
  });

  const failure = () => err(databaseErrorFrom(new Error('boom'), { operation: 'test' }));
  const deleteWhere = vi.fn(async () =>
    fixture.repoFails === true ? failure() : ok(fixture.deleted ?? [subscription()]),
  );
  const listByChannel = vi.fn(async () =>
    fixture.repoFails === true ? failure() : ok(fixture.existing ?? [subscription()]),
  );
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    feedPlatformRegistry: new FeedPlatformRegistry([{ ...platform, ...fixture.platformOverrides }]),
    connectionManager: { isDisabled: () => undefined },
    getRepos: () => ({ feedSubscription: { deleteWhere, listByChannel } }),
  });

  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'feed_unsubscribe',
    guild,
    userId: USER_ID,
    channel: { id: HOME_CHANNEL },
    options: { ...fixture.options },
    ...(fixture.channelOption === undefined
      ? {}
      : { channels: { channel: { id: fixture.channelOption } } }),
    sink,
  });

  return { bot, interaction, sink, deleteWhere, listByChannel, logger };
};

const reply = (sink: ReturnType<typeof newInteractionSink>): string => {
  expect(sink.editReplies).toHaveLength(1);
  return sink.editReplies[0]?.content ?? '';
};

/** The button rows the prompt carried, flattened to their JSON form. */
interface RenderedButton {
  readonly custom_id?: string;
  readonly label?: string;
  readonly style: ButtonStyle;
}

const buttonsOf = (sink: ReturnType<typeof newInteractionSink>): RenderedButton[] => {
  const rows = sink.editReplies[0]?.components ?? [];
  return rows.flatMap((row) => {
    const json = (row as { toJSON: () => { components: RenderedButton[] } }).toJSON();
    return json.components;
  });
};

describe('/feed unsubscribe', () => {
  it('offers the narrowing options before the channel, as /feed subscribe does', () => {
    // Asserted on the payload Discord is actually sent, not on the
    // config literal: the ordering rests on `Object.entries` insertion
    // order and a stable required-first sort, neither of which the
    // compiler checks, so swapping two keys in `setConfig` reads as a
    // no-op while silently reordering the slash-command UI.
    // `buildCommandJsonBody` rejects an empty description, so the order can
    // only be read off a localised config.
    const body = buildCommandJsonBody(
      localizeCommandConfig(new FeedUnsubscribe().config, echoTranslator()),
    ) as { readonly options?: readonly { readonly name: string }[] };

    expect((body.options ?? []).map((option) => option.name)).toEqual([
      'platform',
      'target',
      'channel',
    ]);
  });

  it('asks Discord to autocomplete only target', () => {
    // Asserted on the REST payload for the same reason as the ordering
    // above: the flag has to survive `setConfig` -> localisation ->
    // builder, and dropping it anywhere leaves the hook implemented but
    // never called.
    const body = buildCommandJsonBody(
      localizeCommandConfig(new FeedUnsubscribe().config, echoTranslator()),
    ) as {
      readonly options?: readonly { readonly name: string; readonly autocomplete?: boolean }[];
    };

    const autocompleting = (body.options ?? [])
      .filter((option) => option.autocomplete === true)
      .map((option) => option.name);
    expect(autocompleting).toEqual(['target']);
  });

  it('accepts the public target option and awaits its configured resolver', async () => {
    const normalizeAccount = vi.fn(async () => ok('stored-target'));
    const { bot, interaction, deleteWhere } = build({
      options: { platform: 'fake', target: 'public-link' },
      platformOverrides: { normalizeAccount },
    });
    await new FeedUnsubscribe().execute(interaction, bot);
    expect(normalizeAccount).toHaveBeenCalledWith('public-link');
    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'fake',
      accounts: ['stored-target'],
    });
  });

  it('removes canonical Bahamut targets with the platform disabled', async () => {
    vi.mocked(normalizeBahamutTargetOffline).mockReturnValueOnce(ok('36476/3047'));
    const { bot, interaction, deleteWhere } = build({
      options: { platform: 'bahamut', target: '36476/3047' },
    });
    await new FeedUnsubscribe().execute(interaction, bot);
    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'bahamut',
      accounts: ['36476/3047'],
    });
  });

  it.each([
    ['https://forum.gamer.com.tw/B.php?bsn=36476', 'board:36476'],
    ['https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047', '36476/3047'],
    ['board:36476:3', 'board:36476:3'],
  ])('passes offline target %s intact to the shared normalizer', async (target, canonical) => {
    vi.mocked(normalizeBahamutTargetOffline).mockReturnValueOnce(ok(canonical));
    const { bot, interaction, deleteWhere } = build({
      options: { platform: 'bahamut', target },
    });
    await new FeedUnsubscribe().execute(interaction, bot);
    expect(normalizeBahamutTargetOffline).toHaveBeenLastCalledWith(target);
    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'bahamut',
      accounts: [canonical],
    });
  });

  it('does not delete any targets when offline resolution fails', async () => {
    const failure = new FeedError({
      code: 'FEED_INVALID_ACCOUNT',
      messageKey: 'errors:feed.bahamut_resolution_required',
      messageParams: { platform: 'Bahamut' },
      context: { operation: 'test' },
    });
    vi.mocked(normalizeBahamutTargetOffline)
      .mockReturnValueOnce(ok('board:36476'))
      .mockReturnValueOnce(err(failure));
    const { bot, interaction, sink, deleteWhere, listByChannel } = build({
      options: { platform: 'bahamut', target: 'board:36476, floor-link' },
    });
    await new FeedUnsubscribe().execute(interaction, bot);
    expect(reply(sink)).toContain('errors:feed.bahamut_resolution_required');
    expect(deleteWhere).not.toHaveBeenCalled();
    expect(listByChannel).not.toHaveBeenCalled();
  });

  it('does not delete on a configured asynchronous resolution failure', async () => {
    const failure = new FeedError({
      code: 'FEED_INVALID_ACCOUNT',
      messageKey: 'errors:feed.invalid_target',
      messageParams: { platform: 'Fake', account: 'bad-link' },
      context: { operation: 'test' },
    });
    const { bot, interaction, sink, deleteWhere } = build({
      options: { platform: 'fake', target: 'bad-link' },
      platformOverrides: { normalizeAccount: async () => err(failure) },
    });
    await new FeedUnsubscribe().execute(interaction, bot);
    expect(reply(sink)).toContain('errors:feed.invalid_target');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('answers ephemerally', async () => {
    const { bot, interaction, sink } = build();

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(sink.defers[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('asks before clearing the invoking channel rather than deleting', async () => {
    // The scope a member reaches by naming nothing is also the one an
    // ephemeral receipt cannot undo, so it must not delete on sight.
    const { bot, interaction, sink, deleteWhere, listByChannel } = build({
      existing: [subscription(), subscription({ account: 'another' })],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(listByChannel).toHaveBeenCalledWith(HOME_CHANNEL);
    expect(deleteWhere).not.toHaveBeenCalled();
    const content = reply(sink);
    expect(content).toContain('replies:feed.clear_confirm');
    expect(content).toContain(`<#${HOME_CHANNEL}>`);
    expect(content).toContain('"count":2');
  });

  it('offers a danger confirm and a secondary cancel, both scoped to the invoker', async () => {
    const { bot, interaction, sink } = build();

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(buttonsOf(sink)).toEqual([
      expect.objectContaining({
        custom_id: `feed_clear_confirm|${HOME_CHANNEL}|${USER_ID}`,
        style: ButtonStyle.Danger,
      }),
      expect.objectContaining({
        custom_id: `feed_clear_cancel|${HOME_CHANNEL}|${USER_ID}`,
        style: ButtonStyle.Secondary,
      }),
    ]);
  });

  it('labels both buttons from the catalog', async () => {
    const { bot, interaction, sink } = build();

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(buttonsOf(sink).map((button) => button.label)).toEqual([
      'replies:feed.clear_confirm_label',
      'replies:feed.clear_cancel_label',
    ]);
  });

  it('counts the chosen channel when the option is given', async () => {
    const { bot, interaction, sink, listByChannel } = build({ channelOption: OTHER_CHANNEL });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(listByChannel).toHaveBeenCalledWith(OTHER_CHANNEL);
    expect(buttonsOf(sink)[0]?.custom_id).toBe(`feed_clear_confirm|${OTHER_CHANNEL}|${USER_ID}`);
  });

  it('refuses a channel the invoker cannot see, before reading anything', async () => {
    // Reach is bounded by visibility even though authority is not: a
    // member must not be able to empty the feeds of a channel they have
    // no access to.
    const { bot, interaction, sink, deleteWhere, listByChannel } = build({
      invokerPermissions: [],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.invoker_cannot_view');
    expect(listByChannel).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('says permissions are unknown when the invoker is not in the member cache', async () => {
    // "Unknown" must not read as "allowed" on the command that deletes.
    const { bot, interaction, sink, deleteWhere } = build({ invokerMemberMissing: true });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.invoker_permissions_unknown');
    expect(content).not.toContain('replies:feed.invoker_cannot_view');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('clears a thread through the permissions of its parent', async () => {
    const { bot, interaction, deleteWhere } = build({
      channelOption: THREAD_CHANNEL,
      options: NARROWED,
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({ channelId: THREAD_CHANNEL, platform: 'fake' });
  });

  it('refuses a thread the invoker cannot see the parent of', async () => {
    const { bot, interaction, sink, deleteWhere } = build({
      channelOption: THREAD_CHANNEL,
      invokerPermissions: [],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.invoker_cannot_view');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('refuses a channel it cannot resolve at all', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ channelOption: 'chan-unknown' });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.channel_not_supported');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('narrows by platform when one is named, and deletes at once', async () => {
    // A narrowed scope names what it removes, so it needs no second
    // look: only the whole-channel case is confirmed.
    const { bot, interaction, deleteWhere, listByChannel } = build({ options: NARROWED });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({ channelId: HOME_CHANNEL, platform: 'fake' });
    expect(listByChannel).not.toHaveBeenCalled();
  });

  it('normalises the account through the named platform', async () => {
    const { bot, interaction, deleteWhere } = build({
      options: { platform: 'fake', target: '@SomeOne' },
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'fake',
      accounts: ['someone'],
    });
  });

  it('removes every account a single invocation names', async () => {
    const { bot, interaction, deleteWhere } = build({
      options: { platform: 'fake', target: '@Alpha, beta gamma' },
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'fake',
      accounts: ['alpha', 'beta', 'gamma'],
    });
  });

  it('refuses a list past the cap without deleting anything', async () => {
    const tooMany = Array.from({ length: MAX_FEED_ACCOUNTS + 1 }, (_, i) => `a${String(i)}`);
    const { bot, interaction, sink, deleteWhere } = build({
      options: { target: tooMany.join(',') },
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.too_many_accounts');
    expect(content).toContain(`"max":${String(MAX_FEED_ACCOUNTS)}`);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('refuses a target option that names nothing, rather than clearing the channel', async () => {
    // The dangerous direction: an unusable list must not degrade into
    // "no narrowing", which would empty the whole channel.
    const { bot, interaction, sink, deleteWhere } = build({ options: { target: ' , @ ' } });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.no_accounts');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('still removes subscriptions to a platform that is no longer configured', async () => {
    // The whole reason this command never consults the registry for
    // authorisation: a retired platform's entries must stay clearable.
    const { bot, interaction, sink, deleteWhere } = build({
      options: { platform: 'retired', target: '@SomeOne' },
      deleted: [subscription({ platform: 'retired' })],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({
      channelId: HOME_CHANNEL,
      platform: 'retired',
      accounts: ['someone'],
    });
    expect(reply(sink)).toContain('replies:feed.unsubscribed');
  });

  it('still resolves an account when no platform narrows the scope', async () => {
    const { bot, interaction, deleteWhere } = build({ options: { target: '@SomeOne' } });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(deleteWhere).toHaveBeenCalledWith({ channelId: HOME_CHANNEL, accounts: ['someone'] });
  });

  it('lists every subscription it removed', async () => {
    const { bot, interaction, sink } = build({
      options: { target: 'someone, anotherone' },
      deleted: [
        subscription({ account: 'someone' }),
        subscription({ platform: 'other', account: 'anotherone' }),
      ],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.unsubscribed');
    expect(content).toContain('fake @someone');
    expect(content).toContain('other @anotherone');
    expect(content).toContain('"count":2');
  });

  it('records the removal in the operator log before replying', async () => {
    // The deletion has already committed and the confirmation is both
    // bounded and losable, so the log is the durable record.
    const { bot, interaction, logger } = build({
      options: NARROWED,
      deleted: [subscription({ account: 'alpha' })],
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    const logged = logger.info.mock.calls.flat().join(' ');
    expect(logged).toContain('feed.subscriptions_removed');
    expect(logged).toContain('fake @alpha');
  });

  it('bounds a very large confirmation so Discord will accept it', async () => {
    const deleted = Array.from({ length: MAX_LISTED_REMOVALS + 30 }, (_, index) =>
      subscription({ account: `account-${String(index)}` }),
    );
    const { bot, interaction, sink } = build({ options: NARROWED, deleted });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.unsubscribed_more');
    expect(content).toContain(`"count":${String(deleted.length)}`);
  });

  it('says so plainly when the whole channel is already empty, and asks nothing', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ existing: [] });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.unsubscribed_none');
    expect(content).not.toContain('unsubscribed_none_hint');
    expect(content).toContain(`<#${HOME_CHANNEL}>`);
    expect(sink.editReplies[0]?.components).toBeUndefined();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('suggests widening the search when a narrowed scope matched nothing', async () => {
    const { bot, interaction, sink } = build({ deleted: [], options: { target: 'ghost' } });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.unsubscribed_none_hint');
  });

  it('reports an invalid handle instead of deleting nothing', async () => {
    // One bad entry fails the whole call: a partial deletion would make
    // a typo look like an account that was never subscribed.
    const { bot, interaction, sink, deleteWhere } = build({
      options: { platform: 'fake', target: 'alpha, banned' },
    });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('errors:feed.invalid_account');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('falls back to the traced failure copy when the database refuses', async () => {
    const { bot, interaction, sink } = build({ options: NARROWED, repoFails: true });

    await new FeedUnsubscribe().execute(interaction, bot);

    const content = reply(sink);
    expect(content).toContain('replies:feed.failed');
    expect(content).toContain('traceId');
  });

  it('never shows a prompt it could not count, when the count itself fails', async () => {
    const { bot, interaction, sink, deleteWhere } = build({ repoFails: true });

    await new FeedUnsubscribe().execute(interaction, bot);

    expect(reply(sink)).toContain('replies:feed.failed');
    expect(deleteWhere).not.toHaveBeenCalled();
  });
});
