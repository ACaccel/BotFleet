/**
 * The visibility gate `/feed unsubscribe` and its confirmation button
 * share.
 *
 * Authority over a feed subscription is ungated — any member may
 * subscribe or unsubscribe — so reach is what bounds the damage: a
 * member only operates on a channel they can already `ViewChannel`.
 * That rule is enforced from two places (the command, and the button
 * that confirms clearing a whole channel), and a gate that drifted
 * between them would be a hole rather than a cosmetic inconsistency.
 * Hence one helper, returning the refusal copy with it so both surfaces
 * also say the same thing. `/feed subscribe` and `/feed list` still
 * carry their own copies of the check.
 *
 * Nothing here touches the database or the platform registry: the gate
 * answers from the guild cache alone, which is what lets the confirm
 * button re-check it cheaply before it deletes.
 */
import type { Guild, GuildBasedChannel } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';

import type { TranslationKey, TranslationParams } from '../core/i18n';

/** Why the gate refused, for the operator log. */
type FeedGateDenial = 'unresolved' | 'permissions_unknown' | 'not_visible';

/**
 * Outcome of resolving a channel and checking the invoker can see it.
 *
 * A refusal carries its own catalog key and params rather than a code
 * the caller maps, so the command and the button cannot answer the same
 * situation with different words. It carries a `reason` alongside them
 * because copy is for the member: a caller that wants to log or count a
 * denial should not have to parse a catalog key to do it.
 */
type FeedChannelGate =
  | {
      readonly kind: 'visible';
      readonly channel: GuildBasedChannel;
      /** `<#id>`, the mention every refusal and confirmation renders. */
      readonly mention: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: FeedGateDenial;
      readonly key: TranslationKey;
      readonly params?: TranslationParams;
    };

/**
 * Resolve `channelId` in `guild` and decide whether `invokerId` may act
 * on it.
 *
 * A `GuildMember` is resolved rather than the id passed straight to
 * `permissionsFor`: the id overload answers `null` for an uncached
 * member, which would read as a refusal instead of as "unknown". The
 * two are kept apart because only one of them is the member's fault.
 *
 * A thread carries no overwrites of its own, so the parent answers for
 * it — and a thread whose parent is not cached is "unknown" too.
 */
export const gateFeedChannel = (
  guild: Guild,
  channelId: string,
  invokerId: string,
): FeedChannelGate => {
  const channel = guild.channels.cache.get(channelId);
  if (channel === undefined) {
    return {
      kind: 'refused',
      reason: 'unresolved',
      key: 'replies:feed.channel_not_supported',
    };
  }

  const mention = `<#${channel.id}>`;
  const gate = channel.isThread() ? channel.parent : channel;
  const invoker = guild.members.cache.get(invokerId);
  const perms = gate === null || invoker === undefined ? null : gate.permissionsFor(invoker);
  if (perms === null) {
    // Its own key, not the bot-side `permissions_unknown`: that copy
    // says "I could not work out *my* permissions", which is a
    // different — and here untrue — statement.
    return {
      kind: 'refused',
      reason: 'permissions_unknown',
      key: 'replies:feed.invoker_permissions_unknown',
      params: { channel: mention },
    };
  }
  if (!perms.has(PermissionFlagsBits.ViewChannel)) {
    return {
      kind: 'refused',
      reason: 'not_visible',
      key: 'replies:feed.invoker_cannot_view',
      params: { channel: mention },
    };
  }
  return { kind: 'visible', channel, mention };
};
