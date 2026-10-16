import type { Channel } from 'discord.js';

/**
 * The parent channel id of a thread (its forum / text-channel parent), or
 * `null` for a top-level channel or any channel type without a parent.
 *
 * A single safe extraction so every caller derives the parent the same way:
 * the `'parentId' in channel` guard replaces the unchecked
 * `(channel as TextChannel).parentId` cast that several call sites used, and
 * normalises discord.js's `string | null` to a plain `string | null`.
 */
export const parentChannelIdOf = (channel: Channel | null | undefined): string | null => {
  if (channel === null || channel === undefined) return null;
  return 'parentId' in channel ? (channel.parentId ?? null) : null;
};

/**
 * Discord nests at most `category > channel > thread`, so two ancestors is
 * the real maximum; the cap is a defensive guard against an unexpected cycle.
 */
const MAX_ANCESTOR_DEPTH = 8;

/**
 * The ordered ancestor channel ids of `channel`, climbing parent → grandparent
 * (e.g. a thread yields `[parentChannelId, categoryId]`). Each hop reuses
 * {@link parentChannelIdOf}; `lookup` resolves an intermediate ancestor so the
 * walk can continue past the immediate parent (a thread's `parentId` only names
 * its forum / text channel, whose own `parentId` is the category).
 *
 * Without `lookup` — or when an ancestor is absent from it — the walk stops,
 * degrading to the immediate parent only (the prior one-level behaviour), so
 * extending a caller is strictly additive and never under-resolves below today.
 */
export const ancestorChannelIdsOf = (
  channel: Channel | null | undefined,
  lookup?: { get(id: string): Channel | null | undefined },
): string[] => {
  const ancestors: string[] = [];
  let parentId = parentChannelIdOf(channel);
  for (let depth = 0; parentId !== null && depth < MAX_ANCESTOR_DEPTH; depth++) {
    ancestors.push(parentId);
    if (lookup === undefined) break;
    parentId = parentChannelIdOf(lookup.get(parentId));
  }
  return ancestors;
};

/**
 * Whether `channel` is marked age-restricted. A thread inherits the flag
 * from its parent, which must be cached; an unknown parent, a DM or a
 * channel type without the flag counts as unrestricted, so a gate built on
 * this fails closed.
 */
export const isAgeRestrictedChannel = (channel: Channel | null | undefined): boolean => {
  if (channel === null || channel === undefined) return false;
  if (channel.isThread()) return channel.parent?.nsfw === true;
  return 'nsfw' in channel && channel.nsfw === true;
};
