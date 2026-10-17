import { FeedError } from '../../../core/errors';
import { err, ok, type Result } from '../../../core/result';
import { FEED_PLATFORM_DISPLAY_NAMES, type FeedFailure } from '../types';

export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export type YouTubeTarget =
  | { readonly kind: 'channel'; readonly id: string }
  | { readonly kind: 'handle'; readonly handle: string };

const invalidTarget = (_raw: string): FeedFailure =>
  new FeedError({
    code: 'FEED_INVALID_ACCOUNT',
    messageKey: 'errors:feed.invalid_youtube_target',
    messageParams: { platform: FEED_PLATFORM_DISPLAY_NAMES.youtube },
    context: { operation: 'YouTubePlatform.normalizeAccount' },
  });

/** Stored keys are case-sensitive channel IDs; handles are resolved before persistence. */
export const parseYouTubeTarget = (raw: string): Result<YouTubeTarget, FeedFailure> => {
  const input = raw.trim();
  if (
    input.length > 512 ||
    [...input].some(
      (character) =>
        character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return err(invalidTarget(raw));
  if (YOUTUBE_CHANNEL_ID.test(input)) return ok({ kind: 'channel', id: input });
  let path = input;
  if (!input.startsWith('@')) {
    // Validate the spelling before URL normalization can hide dot segments or default ports.
    const match = /^https:\/\/(?:www\.)?youtube\.com(\/[^?#]*)$/i.exec(input);
    if (match === null) return err(invalidTarget(raw));
    path = match[1]!;
    const channel = /^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/.exec(path);
    if (channel !== null) return ok({ kind: 'channel', id: channel[1]! });
    try {
      path = decodeURIComponent(path.replace(/^\//, '').replace(/\/$/, ''));
    } catch {
      return err(invalidTarget(raw));
    }
  }
  const handle = path.slice(1);
  // YouTube applies script-specific length rules; this safe superset leaves existence to metadata.
  if (
    !path.startsWith('@') ||
    [...handle].length > 30 ||
    !/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_.\-\u00b7]*[\p{L}\p{M}\p{N}])?$/u.test(handle)
  )
    return err(invalidTarget(raw));
  return ok({ kind: 'handle', handle: handle.toLowerCase() });
};

/** Read channel-specific HTML metadata, skipping scripts and comments rather than matching JSON IDs. */
export const resolveYouTubeChannelMetadata = (html: string): string => {
  if (!/<html\b/i.test(html) || !/<head\b/i.test(html))
    throw new Error('Missing YouTube channel metadata');
  const ids = new Set<string>();
  const tags =
    /<!--|<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>|<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(html)) !== null) {
    if (tag[0] === '<!--') {
      const end = html.indexOf('-->', tags.lastIndex);
      if (end < 0) throw new Error('Unterminated metadata comment');
      tags.lastIndex = end + 3;
      continue;
    }
    if (tag[1] !== undefined) {
      const end = new RegExp(`</${tag[1]}\\s*>`, 'gi');
      end.lastIndex = tags.lastIndex;
      if (end.exec(html) === null) throw new Error('Unterminated metadata script');
      tags.lastIndex = end.lastIndex;
      continue;
    }
    const attributes = new Map<string, string>();
    let remaining = tag[3]!;
    while (remaining.trim() !== '' && remaining.trim() !== '/') {
      const attribute = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining);
      if (attribute === null) throw new Error('Malformed YouTube channel metadata');
      const name = attribute[1]!.toLowerCase();
      if (attributes.has(name)) throw new Error('Duplicate metadata attribute');
      attributes.set(name, attribute[2] ?? attribute[3]!);
      remaining = remaining.slice(attribute[0].length);
    }
    const name = tag[2]!.toLowerCase();
    if (name === 'meta' && attributes.get('itemprop') === 'channelId') {
      const id = attributes.get('content') ?? '';
      if (!YOUTUBE_CHANNEL_ID.test(id)) throw new Error('Invalid channel ID metadata');
      ids.add(id);
    }
    if (name === 'link' && attributes.get('rel') === 'canonical') {
      const href = attributes.get('href') ?? '';
      const target = parseYouTubeTarget(href);
      if (!target.ok) throw new Error('Invalid canonical channel metadata');
      if (target.value.kind === 'channel') ids.add(target.value.id);
    }
  }
  if (ids.size !== 1) throw new Error('Missing or conflicting YouTube channel identity');
  return [...ids][0]!;
};
