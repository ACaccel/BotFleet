import { createHash } from 'node:crypto';
import type { ArchiveSnapshot, NormalizeContext } from './types';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const input = record(value);
  return Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  );
};
const date = (value: unknown): number | undefined => {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const embed = (value: unknown): Record<string, unknown> => {
  const input = record(value);
  const output = pick(input, ['type', 'title', 'description', 'url', 'color', 'timestamp']);
  for (const key of ['image', 'thumbnail', 'video']) {
    if (input[key] !== undefined)
      output[key] = pick(input[key], ['url', 'proxy_url', 'width', 'height']);
  }
  if (input.author !== undefined) output.author = pick(input.author, ['name', 'url']);
  if (input.footer !== undefined) output.footer = pick(input.footer, ['text']);
  if (input.fields !== undefined)
    output.fields = array(input.fields).map((field) => pick(field, ['name', 'value', 'inline']));
  return output;
};
const attachment = (value: unknown, context: NormalizeContext): Record<string, unknown> => {
  const input = record(value);
  const output = pick(input, ['id', 'url', 'description', 'size', 'width', 'height', 'flags']);
  const aliases: Record<string, string> = {
    filename: 'name',
    content_type: 'contentType',
    proxy_url: 'proxyUrl',
    duration_secs: 'durationSeconds',
  };
  for (const [source, destination] of Object.entries(aliases))
    if (input[source] !== undefined) output[destination] = input[source];
  output.urlObservedAt = context.observedAt;
  if (typeof input.filename === 'string') output.spoiler = input.filename.startsWith('SPOILER_');
  return output;
};
const component = (value: unknown, depth = 0): Record<string, unknown> => {
  const input = record(value);
  const output = pick(input, ['type', 'label', 'description', 'content', 'url', 'placeholder']);
  if (input.emoji !== undefined) output.emoji = pick(input.emoji, ['id', 'name', 'animated']);
  if (input.media !== undefined) output.media = pick(input.media, ['url']);
  if (input.options !== undefined)
    output.options = array(input.options).map((option) => pick(option, ['label', 'description']));
  if (input.items !== undefined)
    output.items = array(input.items).map((item) => {
      const itemData = record(item);
      const result = pick(itemData, ['description', 'spoiler']);
      if (itemData.media !== undefined) result.media = pick(itemData.media, ['url']);
      return result;
    });
  if (depth < 8) {
    if (input.components !== undefined)
      output.components = array(input.components).map((child) => component(child, depth + 1));
    if (input.accessory !== undefined) output.accessory = component(input.accessory, depth + 1);
  }
  return output;
};
const canonical = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !['urlObservedAt', 'proxyUrl', 'proxy_url'].includes(name))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, canonical(entry, name)]),
    );
  if (typeof value === 'string' && key === 'url') {
    try {
      const url = new URL(value);
      if (['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
        for (const parameter of ['ex', 'is', 'hm']) url.searchParams.delete(parameter);
        return url.toString();
      }
    } catch {
      /* Non-URL display values stay unchanged. */
    }
  }
  return value;
};
export const contentHash = (snapshot: Partial<ArchiveSnapshot>): string => {
  const content = Object.fromEntries(
    [
      'content',
      'attachments',
      'stickers',
      'embeds',
      'mentions',
      'reference',
      'poll',
      'components',
      'snapshots',
      'type',
    ]
      .filter((key) => key in snapshot)
      .map((key) => [key, (snapshot as unknown as Record<string, unknown>)[key]]),
  );
  return createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex');
};
export const emojiKey = (emoji: { id?: string | null; name?: string | null }): string =>
  emoji.id ? `custom:${emoji.id}` : `unicode:${emoji.name ?? ''}`;

/** Missing Gateway keys remain unknown; explicit empty arrays remain present. */
export const normalizeMessage = (
  raw: Record<string, unknown>,
  context: NormalizeContext,
): ArchiveSnapshot => {
  if (typeof raw.id !== 'string' || !/^\d+$/.test(raw.id))
    throw new TypeError('Message id must be a snowflake string');
  const channelId = typeof raw.channel_id === 'string' ? raw.channel_id : context.channelId;
  if (!channelId) throw new TypeError('Message channel id is required');
  const author = record(raw.author);
  const timestamp = date(raw.timestamp);
  const editedTimestamp = raw.edited_timestamp === null ? null : date(raw.edited_timestamp);
  const snapshot: ArchiveSnapshot = {
    schemaVersion: 2,
    messageId: raw.id,
    guildId: context.guildId,
    channelId,
    channelName: context.channelName ?? '',
    observedAt: context.observedAt,
    source: context.source,
    authorKind:
      typeof raw.webhook_id === 'string'
        ? 'webhook'
        : typeof author.bot === 'boolean'
          ? author.bot
            ? 'bot'
            : 'human'
          : typeof author.id === 'string'
            ? 'human'
            : 'unknown',
    contentVersionAt: editedTimestamp ?? timestamp ?? context.observedAt,
    contentHash: '',
    presence: {},
  };
  if (context.observationId !== undefined) snapshot.observationId = context.observationId;
  if (timestamp !== undefined) snapshot.timestamp = timestamp;
  if (editedTimestamp !== undefined) snapshot.editedTimestamp = editedTimestamp;
  if (context.parentId !== undefined) snapshot.parentId = context.parentId;
  if (typeof author.id === 'string') snapshot.userId = author.id;
  if (typeof author.global_name === 'string' || typeof author.username === 'string')
    snapshot.userName = String(author.global_name ?? author.username);
  if (typeof raw.webhook_id === 'string') snapshot.webhookId = raw.webhook_id;
  if (typeof raw.application_id === 'string') snapshot.applicationId = raw.application_id;
  for (const key of ['content', 'type', 'flags'] as const) {
    snapshot.presence[key] = key in raw ? 'present' : 'unknown';
    if (key === 'content' && typeof raw[key] === 'string') snapshot.content = raw[key];
    if (key === 'type' && typeof raw[key] === 'number') snapshot.type = raw[key];
    if (key === 'flags' && typeof raw[key] === 'number') snapshot.flags = raw[key];
  }
  const lists: Record<string, [string, (value: unknown) => Record<string, unknown>]> = {
    attachments: ['attachments', (value) => attachment(value, context)],
    stickers: ['sticker_items', (value) => pick(value, ['id', 'name', 'format_type'])],
    embeds: ['embeds', embed],
    components: ['components', component],
    reactions: [
      'reactions',
      (value) => {
        const input = record(value);
        const emoji = pick(input.emoji, ['id', 'name', 'animated']);
        return {
          ...emoji,
          emojiKey: emojiKey(emoji),
          ...pick(input, ['count', 'count_details']),
          membershipState: 'unknown',
          freshness: 'stale',
        };
      },
    ],
  };
  for (const [key, [inputKey, serializer]] of Object.entries(lists)) {
    snapshot.presence[key] = inputKey in raw ? 'present' : 'unknown';
    if (inputKey in raw)
      (snapshot as unknown as Record<string, unknown>)[key] = array(raw[inputKey]).map(serializer);
  }
  snapshot.presence.mentions = 'mentions' in raw ? 'present' : 'unknown';
  if ('mentions' in raw) {
    snapshot.mentions = {
      users: array(raw.mentions)
        .map((value) => record(value).id)
        .filter((id) => typeof id === 'string'),
    };
    if ('mention_roles' in raw)
      snapshot.mentions.roles = array(raw.mention_roles).filter((id) => typeof id === 'string');
    if ('mention_channels' in raw)
      snapshot.mentions.channels = array(raw.mention_channels)
        .map((value) => record(value).id)
        .filter((id) => typeof id === 'string');
    if ('mention_everyone' in raw) snapshot.mentions.everyone = raw.mention_everyone === true;
  }
  snapshot.presence.reference = 'message_reference' in raw ? 'present' : 'unknown';
  if ('message_reference' in raw)
    snapshot.reference = pick(raw.message_reference, [
      'guild_id',
      'channel_id',
      'message_id',
      'type',
    ]);
  snapshot.presence.thread = 'thread' in raw ? 'present' : 'unknown';
  if ('thread' in raw) snapshot.thread = pick(raw.thread, ['id', 'name', 'parent_id', 'type']);
  snapshot.presence.poll = 'poll' in raw ? 'present' : 'unknown';
  if ('poll' in raw) {
    const poll = record(raw.poll);
    snapshot.poll =
      raw.poll === null
        ? null
        : {
            question: pick(poll.question, ['text']),
            answers: array(poll.answers).map((value) => {
              const answer = record(value);
              return {
                answer_id: answer.answer_id,
                poll_media: {
                  ...pick(answer.poll_media, ['text']),
                  ...(record(answer.poll_media).emoji
                    ? { emoji: pick(record(answer.poll_media).emoji, ['id', 'name', 'animated']) }
                    : {}),
                },
              };
            }),
            expiry: poll.expiry,
            results: {
              ...pick(poll.results, ['is_finalized']),
              ...(record(poll.results).answer_counts !== undefined
                ? {
                    answer_counts: array(record(poll.results).answer_counts).map((entry) =>
                      pick(entry, ['id', 'count']),
                    ),
                  }
                : {}),
            },
          };
  }
  snapshot.presence.snapshots = 'message_snapshots' in raw ? 'present' : 'unknown';
  if ('message_snapshots' in raw)
    snapshot.snapshots = array(raw.message_snapshots).map((value) => {
      const input = record(record(value).message);
      return {
        ...pick(input, ['content', 'type', 'timestamp', 'edited_timestamp']),
        embeds: array(input.embeds).map(embed),
        attachments: array(input.attachments).map((entry) => attachment(entry, context)),
      };
    });
  snapshot.contentHash = contentHash(snapshot);
  return snapshot;
};

export const mergeSnapshot = (
  existing: Partial<ArchiveSnapshot>,
  incoming: ArchiveSnapshot,
): ArchiveSnapshot => {
  const result = {
    ...existing,
    ...incoming,
    presence: { ...existing.presence },
  } as ArchiveSnapshot;
  for (const [key, state] of Object.entries(incoming.presence)) {
    if (state === 'present') result.presence[key] = state;
    else if (existing.presence?.[key] === 'present') {
      (result as unknown as Record<string, unknown>)[key] = (existing as Record<string, unknown>)[
        key
      ];
    } else result.presence[key] = state;
  }
  if (incoming.authorKind === 'unknown' && existing.authorKind)
    result.authorKind = existing.authorKind;
  if (!incoming.channelName && existing.channelName) result.channelName = existing.channelName;
  if (incoming.mentions && existing.mentions)
    result.mentions = { ...existing.mentions, ...incoming.mentions };
  if (existing.deletion) result.deletion = existing.deletion;
  result.contentHash = contentHash(result);
  return result;
};
