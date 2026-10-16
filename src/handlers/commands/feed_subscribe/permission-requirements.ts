/**
 * Which channel permissions a feed destination needs, and which of them
 * a given permission set is missing.
 *
 * Pure, and deliberately ignorant of discord.js channels: it takes a
 * `has(bit)` predicate and one boolean about the channel kind. Resolving
 * the bot member, walking a thread up to its parent and asking
 * `permissionsFor` stay in `index.ts` where the Discord work belongs —
 * what moves here is only the rule about *which* bits matter, which is
 * the part worth stating once and testing directly.
 */
import { PermissionFlagsBits } from 'discord.js';

/** Permissions this command can require of a destination channel. */
type FeedPermissionName = 'ViewChannel' | 'EmbedLinks' | 'SendMessages' | 'SendMessagesInThreads';

/**
 * Catalog suffix under `replies:feed.permission.` for each flag.
 *
 * The reply names permissions in the reader's language; the raw
 * discord.js identifiers stay in the operator log, because those are
 * what a search of Discord's own docs and UI will match.
 */
export const PERMISSION_LABEL_KEYS: Readonly<Record<FeedPermissionName, string>> = {
  ViewChannel: 'view_channel',
  EmbedLinks: 'embed_links',
  SendMessages: 'send_messages',
  SendMessagesInThreads: 'send_messages_in_threads',
};

/** Needed in any destination; only the send bit depends on the kind. */
const ALWAYS_REQUIRED = ['ViewChannel', 'EmbedLinks'] as const;

/**
 * The permissions a destination of this kind requires.
 *
 * Posting inside a thread is gated by `SendMessagesInThreads`, which
 * the parent's `SendMessages` does not imply. Checking only the latter
 * would admit exactly the subscription this command exists to refuse:
 * one that passes at subscribe time and then 403s on every pass.
 */
export const requiredFeedPermissions = (isThread: boolean): readonly FeedPermissionName[] => [
  ...ALWAYS_REQUIRED,
  isThread ? 'SendMessagesInThreads' : 'SendMessages',
];

/**
 * Those of {@link requiredFeedPermissions} that `has` denies, in a
 * stable order so the message reads the same way every time.
 */
export const missingFeedPermissions = (
  has: (bit: bigint) => boolean,
  isThread: boolean,
): readonly FeedPermissionName[] =>
  requiredFeedPermissions(isThread).filter((name) => !has(PermissionFlagsBits[name]));
