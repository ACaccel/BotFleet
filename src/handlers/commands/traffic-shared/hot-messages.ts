/**
 * The top-messages text of the overview and channel replies: a bold heading
 * and two lines per message, placed in the embed text so the jump links stay
 * clickable and the previews selectable.
 *
 * A preview is the start of the current text, made inert: spoilers are hidden,
 * user, role and channel mentions become plain `@name` / `#name`, custom emoji
 * become `:name:`, raw URLs stop being links, line breaks become spaces, the text is cut to
 * {@link PREVIEW_LENGTH} characters, and Discord markdown (masked links
 * included) is escaped so nothing in it formats, links or pings. A message
 * without text names what it carries instead (pictures, files, a sticker).
 */
import { escapeMarkdown } from 'discord.js';

import { VOICE_MESSAGE_FLAG } from '../../../core/archive/stats';
import type { TopReactedMessage } from '../../../persistence/repositories/archive-stats.types';

import { formatCount } from './dashboard';
import { emojiMarkdown } from './emoji-art';
import { localDateTime } from './labels';
import type { TFn } from './types';

export const PREVIEW_LENGTH = 30;
const TOP_REACTIONS = 3;
/**
 * Stands in for a hidden spoiler until the text is cut and escaped, so the
 * placeholder counts as one character and is never cut in half (U+E000, private use).
 */
const SPOILER_MARK = '\uE000';

/** Names for the mentions inside a message. */
export interface MentionNames {
  readonly user: (userId: string) => string;
  readonly role: (roleId: string) => string;
  readonly channel: (channelId: string) => string;
}

const ESCAPE_ALL = {
  maskedLink: true,
  heading: true,
  bulletedList: true,
  numberedList: true,
} as const;

const graphemes = (text: string): string[] =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (s) => s.segment,
  );

const plainText = (text: string, names: MentionNames): string =>
  text
    .replace(/\|\|[\s\S]*?\|\|/g, SPOILER_MARK)
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.user(id)}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${names.role(id)}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${names.channel(id)}`)
    .replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name}:`)
    .replace(/<\/([\w -]+):\d+>/g, (_, name: string) => `/${name}`)
    // A zero-width space after the scheme keeps a raw URL from becoming a link.
    .replace(/:\/\//g, '://\u200B')
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (text: string): string => {
  const chars = graphemes(text);
  return chars.length <= PREVIEW_LENGTH
    ? text
    : `${chars
        .slice(0, PREVIEW_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
};

/** What a message without text carries, e.g. "(2 pictures)". */
const placeholder = (message: TopReactedMessage, t: TFn): string => {
  const types = message.attachments.map((a) => a.contentType ?? '');
  const parts: string[] = [];
  const count = (key: string, n: number): void => {
    if (n > 0) parts.push(t(`replies:traffic.hot.${key}`, { count: n }));
  };
  if (((message.flags ?? 0) & VOICE_MESSAGE_FLAG) !== 0) count('voice', 1);
  else {
    count('images', types.filter((type) => type.startsWith('image/')).length);
    count('videos', types.filter((type) => type.startsWith('video/')).length);
    count('files', types.filter((type) => !/^(image|video)\//.test(type)).length);
  }
  count('stickers', message.stickers.length);
  if (parts.length === 0) return t('replies:traffic.hot.empty');
  return t('replies:traffic.hot.carries', {
    items: parts.join(t('replies:traffic.list_separator')),
  });
};

export const messagePreview = (message: TopReactedMessage, names: MentionNames, t: TFn): string => {
  const text = [message.content, message.forwardedContent, message.pollQuestion]
    .map((value) => plainText(value ?? '', names))
    .find((value) => value.length > 0);
  if (text === undefined) return placeholder(message, t);
  return escapeMarkdown(truncate(text), ESCAPE_ALL).replaceAll(
    SPOILER_MARK,
    t('replies:traffic.hot.spoiler'),
  );
};

export interface HotMessagesInput {
  readonly messages: readonly TopReactedMessage[];
  readonly guildId: string;
  readonly names: MentionNames;
  readonly author: (message: TopReactedMessage) => string;
  readonly timeZone: string;
  readonly t: TFn;
}

/** The heading and message lines, or `undefined` when no message in range has a reaction. */
export const hotMessagesText = (input: HotMessagesInput): string | undefined => {
  const { t } = input;
  if (input.messages.length === 0) return undefined;
  const lines = input.messages.flatMap((message, i) => {
    const url = `https://discord.com/channels/${input.guildId}/${message.channelId}/${message.messageId}`;
    const top = message.reactions
      .slice(0, TOP_REACTIONS)
      .map((reaction) => `${emojiMarkdown(reaction)} ${formatCount(reaction.count)}`)
      .join(' · ');
    return [
      t('replies:traffic.hot.line', {
        rank: i + 1,
        preview: messagePreview(message, input.names, t),
        url,
      }),
      t('replies:traffic.hot.meta', {
        author: escapeMarkdown(input.author(message), ESCAPE_ALL),
        channel: escapeMarkdown(`#${input.names.channel(message.channelId)}`, ESCAPE_ALL),
        time: localDateTime(message.createdTimestamp, input.timeZone),
        number: formatCount(message.totalReactions),
        top,
      }),
    ];
  });
  return [t('replies:traffic.hot.heading', { count: input.messages.length }), ...lines].join('\n');
};
