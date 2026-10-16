/**
 * The visibility gate `/feed unsubscribe` shares with its confirmation
 * button.
 *
 * This helper is the only thing standing between ungated authority and
 * a member emptying the feeds of a channel that is closed to them, and
 * it is consulted from two places — the command and the button that
 * confirms a whole-channel clear. Testing it directly is what keeps the
 * two honest: a regression here would otherwise only surface as a
 * missing assertion in one of the two handler suites.
 *
 * The refusal keys are asserted, not just the fact of a refusal:
 * "unknown" and "you cannot see it" are different answers, and a gate
 * that collapsed them would tell a member their permissions were
 * revoked when the cache was merely cold.
 */
import { describe, expect, it } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { gateFeedChannel } from '../../../src/handlers/feed-channel-gate';
import { buildTextChannel } from '../../fixtures/discord/channel-builder';
import { buildGuild } from '../../fixtures/discord/guild-builder';

const USER_ID = 'u-1';
const CHANNEL_ID = 'chan-1';
const THREAD_ID = 'chan-thread';
const PARENT_ID = 'chan-parent';

/**
 * A guild holding a plain channel and a thread whose parent carries the
 * overwrites, which is how Discord actually resolves thread visibility.
 */
const build = (
  options: {
    readonly permissions?: readonly bigint[];
    readonly memberMissing?: boolean;
    readonly parentMissing?: boolean;
  } = {},
) => {
  const permissionsBySubject = {
    [USER_ID]: options.permissions ?? [PermissionFlagsBits.ViewChannel],
  };
  const parent = buildTextChannel({ id: PARENT_ID, permissionsBySubject });
  return buildGuild({
    channels: [
      buildTextChannel({ id: CHANNEL_ID, permissionsBySubject }),
      parent,
      buildTextChannel({
        id: THREAD_ID,
        type: ChannelType.PublicThread,
        parent: options.parentMissing === true ? null : parent,
      }),
    ],
    members: options.memberMissing === true ? [] : [{ id: USER_ID }],
  });
};

describe('gateFeedChannel', () => {
  it('admits a channel the invoker can view, with its mention', () => {
    const gate = gateFeedChannel(build(), CHANNEL_ID, USER_ID);

    expect(gate).toEqual({
      kind: 'visible',
      channel: expect.objectContaining({ id: CHANNEL_ID }),
      mention: `<#${CHANNEL_ID}>`,
    });
  });

  it('refuses a channel the guild does not hold, without naming it', () => {
    // Nothing was resolved, so there is no mention to interpolate — the
    // copy for this branch takes no params.
    const gate = gateFeedChannel(build(), 'chan-unknown', USER_ID);

    expect(gate).toEqual({
      kind: 'refused',
      reason: 'unresolved',
      key: 'replies:feed.channel_not_supported',
    });
  });

  it('refuses a channel the invoker cannot view', () => {
    const gate = gateFeedChannel(build({ permissions: [] }), CHANNEL_ID, USER_ID);

    expect(gate).toEqual({
      kind: 'refused',
      reason: 'not_visible',
      key: 'replies:feed.invoker_cannot_view',
      params: { channel: `<#${CHANNEL_ID}>` },
    });
  });

  it('answers "unknown" rather than "denied" for an uncached member', () => {
    // The id overload of `permissionsFor` returns null for a member the
    // cache has not seen, which would read as a refusal. Resolving the
    // member first is what keeps the two apart.
    const gate = gateFeedChannel(build({ memberMissing: true }), CHANNEL_ID, USER_ID);

    // Its own key: the bot-side `permissions_unknown` copy says "I
    // could not work out *my* permissions", which is a different claim.
    expect(gate).toEqual({
      kind: 'refused',
      reason: 'permissions_unknown',
      key: 'replies:feed.invoker_permissions_unknown',
      params: { channel: `<#${CHANNEL_ID}>` },
    });
  });

  it('admits a thread through the permissions of its parent', () => {
    const gate = gateFeedChannel(build(), THREAD_ID, USER_ID);

    expect(gate).toMatchObject({ kind: 'visible', mention: `<#${THREAD_ID}>` });
  });

  it('refuses a thread whose parent the invoker cannot view', () => {
    const gate = gateFeedChannel(build({ permissions: [] }), THREAD_ID, USER_ID);

    expect(gate).toMatchObject({ kind: 'refused', key: 'replies:feed.invoker_cannot_view' });
  });

  it('answers "unknown" for a thread whose parent is not cached', () => {
    // A thread carries no overwrites of its own, so an unresolvable
    // parent leaves the answer genuinely unknown — and unknown must
    // fail closed rather than read as permission.
    const gate = gateFeedChannel(build({ parentMissing: true }), THREAD_ID, USER_ID);

    expect(gate).toMatchObject({
      kind: 'refused',
      key: 'replies:feed.invoker_permissions_unknown',
    });
  });
});
