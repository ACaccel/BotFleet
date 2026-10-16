/**
 * `/feed unsubscribe`'s autocomplete hook — which channel it reads and
 * when it declines to answer.
 *
 * Two things carry risk here. The scope must track the `channel` option
 * as the member fills it in, or the list describes a channel other than
 * the one they are about to clear. And the visibility gate must hold:
 * suggestions are a read of guild state, so a channel the invoker
 * cannot see must not leak its subscriptions through a dropdown any
 * more than through a reply.
 *
 * Every refusal is asserted as an empty list, because that is the only
 * answer an autocomplete interaction can give — the tests exist to stop
 * a future edit from reaching for a reply that would reject.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Types } from 'mongoose';

import { suggestUnsubscribeAccounts } from '../../../../src/handlers/commands/feed_unsubscribe/suggest-accounts';
import { err, ok } from '../../../../src/core/result';
import { databaseErrorFrom } from '../../../../src/persistence/error-translator';
import type { FeedSubscriptionDoc } from '../../../../src/persistence/schemas/feed-subscription.schema';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildAutocompleteInteraction } from '../../../fixtures/discord/interaction-builder';

const HOME_CHANNEL = 'chan-home';
const OTHER_CHANNEL = 'chan-other';
const HIDDEN_CHANNEL = 'chan-hidden';
const THREAD_CHANNEL = 'chan-thread';
const USER_ID = 'u-1';

const subscription = (account: string, channelId: string, platform = 'x'): FeedSubscriptionDoc => ({
  _id: new Types.ObjectId(),
  platform,
  account,
  channel_id: channelId,
  created_by: USER_ID,
  created_at: 1_700_000_000_000,
  filter: { media: 'media_only' },
});

interface Fixture {
  /** Stored subscriptions keyed by channel, as `listByChannel` answers. */
  readonly byChannel?: Readonly<Record<string, readonly FeedSubscriptionDoc[]>>;
  readonly repoFails?: boolean;
  readonly noRepos?: boolean;
  readonly guildless?: boolean;
  readonly options?: Readonly<Record<string, string>>;
  readonly focused?: string;
  /** Which option Discord is asking about; the `account` one by default. */
  readonly focusedOption?: string;
}

const build = (fixture: Fixture = {}) => {
  const visible = { [USER_ID]: [PermissionFlagsBits.ViewChannel] };
  const parent = buildTextChannel({ id: 'chan-parent', permissionsBySubject: visible });
  const guild = buildGuild({
    channels: [
      buildTextChannel({ id: HOME_CHANNEL, permissionsBySubject: visible }),
      buildTextChannel({ id: OTHER_CHANNEL, permissionsBySubject: visible }),
      // No ViewChannel for the invoker at all.
      buildTextChannel({ id: HIDDEN_CHANNEL, permissionsBySubject: {} }),
      parent,
      buildTextChannel({ id: THREAD_CHANNEL, type: ChannelType.PublicThread, parent }),
    ],
    members: [{ id: USER_ID }],
  });

  const listByChannel = vi.fn(async (channelId: string) =>
    fixture.repoFails === true
      ? err(databaseErrorFrom(new Error('boom'), { operation: 'test' }))
      : ok(fixture.byChannel?.[channelId] ?? []),
  );
  const { bot, logger } = buildFakeBot({
    connectionManager: { isDisabled: () => undefined },
    getRepos: () =>
      fixture.noRepos === true ? undefined : { feedSubscription: { listByChannel } },
  });

  const interaction = buildAutocompleteInteraction({
    commandName: 'feed_unsubscribe',
    userId: USER_ID,
    ...(fixture.guildless === true ? { guildId: null } : { guild }),
    channel: { id: HOME_CHANNEL },
    options: { ...fixture.options },
    focused: fixture.focused ?? '',
    focusedOption: fixture.focusedOption ?? 'account',
  });

  return { bot, interaction, listByChannel, logger };
};

const accountsOf = (choices: readonly { value: string }[]) => choices.map((c) => c.value);

describe('suggestUnsubscribeAccounts', () => {
  it('reads the invoking channel when the channel option is empty', async () => {
    const { bot, interaction, listByChannel } = build({
      byChannel: { [HOME_CHANNEL]: [subscription('alice', HOME_CHANNEL)] },
    });

    const choices = await suggestUnsubscribeAccounts(interaction, bot);

    expect(listByChannel).toHaveBeenCalledWith(HOME_CHANNEL);
    expect(accountsOf(choices)).toEqual(['alice']);
  });

  it('reads the chosen channel once the channel option is filled in', async () => {
    // On an autocomplete interaction the option carries a raw id;
    // Discord resolves entities only when the command is submitted.
    const { bot, interaction, listByChannel } = build({
      options: { channel: OTHER_CHANNEL },
      byChannel: {
        [HOME_CHANNEL]: [subscription('alice', HOME_CHANNEL)],
        [OTHER_CHANNEL]: [subscription('bob', OTHER_CHANNEL)],
      },
    });

    const choices = await suggestUnsubscribeAccounts(interaction, bot);

    expect(listByChannel).toHaveBeenCalledWith(OTHER_CHANNEL);
    expect(accountsOf(choices)).toEqual(['bob']);
  });

  it('narrows by the platform option when it is filled in', async () => {
    const { bot, interaction } = build({
      options: { platform: 'x' },
      byChannel: {
        [HOME_CHANNEL]: [
          subscription('alice', HOME_CHANNEL, 'x'),
          subscription('bob', HOME_CHANNEL, 'bluesky'),
        ],
      },
    });

    expect(accountsOf(await suggestUnsubscribeAccounts(interaction, bot))).toEqual(['alice']);
  });

  it('completes the last segment of a partly typed list', async () => {
    const { bot, interaction } = build({
      focused: 'alice, bo',
      byChannel: {
        [HOME_CHANNEL]: [subscription('alice', HOME_CHANNEL), subscription('bob', HOME_CHANNEL)],
      },
    });

    expect(accountsOf(await suggestUnsubscribeAccounts(interaction, bot))).toEqual(['alice, bob']);
  });

  it('resolves a thread through its parent, as the command does', async () => {
    const { bot, interaction, listByChannel } = build({
      options: { channel: THREAD_CHANNEL },
      byChannel: { [THREAD_CHANNEL]: [subscription('alice', THREAD_CHANNEL)] },
    });

    const choices = await suggestUnsubscribeAccounts(interaction, bot);

    expect(listByChannel).toHaveBeenCalledWith(THREAD_CHANNEL);
    expect(accountsOf(choices)).toEqual(['alice']);
  });

  it('offers nothing for a channel the invoker cannot view', async () => {
    const { bot, interaction, listByChannel } = build({
      options: { channel: HIDDEN_CHANNEL },
      byChannel: { [HIDDEN_CHANNEL]: [subscription('secret', HIDDEN_CHANNEL)] },
    });

    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
    // Refused before the read, so the handles never leave the database.
    expect(listByChannel).not.toHaveBeenCalled();
  });

  it('offers nothing for a channel that is not in the guild', async () => {
    const { bot, interaction } = build({ options: { channel: 'chan-gone' } });

    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
  });

  it('offers nothing when the read fails, but says so in the operator log', async () => {
    const { bot, interaction, logger } = build({ repoFails: true });

    // Not a throw: this runs once per keystroke, so an error-level line
    // per character would be worse than useless. Silence would be worse
    // still — the member just sees an empty list, so without this line
    // a degraded database leaves no trace on this surface at all.
    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('offers nothing when Discord asks about an option other than account', async () => {
    // Unreachable today — `account` is the only flagged option — but a
    // second flagged option added later would otherwise be answered
    // with account handles matched against the wrong fragment.
    const { bot, interaction, listByChannel } = build({
      focusedOption: 'platform',
      byChannel: { [HOME_CHANNEL]: [subscription('alice', HOME_CHANNEL)] },
    });

    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
    expect(listByChannel).not.toHaveBeenCalled();
  });

  it('offers nothing when the guild has no repository bundle', async () => {
    const { bot, interaction } = build({ noRepos: true });

    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
  });

  it('offers nothing outside a guild', async () => {
    const { bot, interaction, listByChannel } = build({ guildless: true });

    expect(await suggestUnsubscribeAccounts(interaction, bot)).toEqual([]);
    expect(listByChannel).not.toHaveBeenCalled();
  });
});
