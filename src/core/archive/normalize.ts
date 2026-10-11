import {
  ARCHIVE_EDIT_HISTORY_LIMIT,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveAttachment,
  type ArchiveComponent,
  type ArchiveEdit,
  type ArchiveEmbed,
  type ArchiveEmbedMedia,
  type ArchiveEmoji,
  type ArchiveInteractionMetadata,
  type ArchiveMentions,
  type ArchiveMessage,
  type ArchiveMessageSnapshot,
  type ArchivePoll,
  type ArchiveReaction,
  type ArchiveReference,
  type ReactionStreamKey,
  type ArchiveSnapshot,
  type ArchiveSticker,
  type ArchiveUser,
  type NormalizeContext,
} from './types';

const DISCORD_EPOCH = 1420070400000;
const DISCORD_CDN_HOSTS: ReadonlySet<string> = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);
/** Query parameters of an expiring Discord CDN signature. */
const CDN_SIGNATURE_PARAMETERS = ['ex', 'is', 'hm'] as const;
/** Component trees deeper than this are cut; Discord nests far less in practice. */
const COMPONENT_DEPTH_LIMIT = 8;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const date = (value: unknown): number | undefined => {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
const ids = (value: unknown): string[] =>
  array(value).filter((id): id is string => typeof id === 'string');
/** Drops absent values so an unobserved field stays absent rather than stored as `undefined`. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
const optional = <T extends object>(value: T): T | undefined => {
  const result = defined(value);
  return Object.keys(result).length === 0 ? undefined : result;
};

/** Creation time encoded in a Discord snowflake. */
export const snowflakeTimestamp = (id: string): number => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;

/**
 * A Discord CDN URL without its expiring signature. The signed form stops working
 * after about a day, while the unsigned path still identifies the file.
 */
export const unsignedDiscordUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!DISCORD_CDN_HOSTS.has(url.hostname)) return value;
    for (const parameter of CDN_SIGNATURE_PARAMETERS) url.searchParams.delete(parameter);
    return url.toString();
  } catch {
    // Non-URL display values stay unchanged.
    return value;
  }
};
const url = (value: unknown): string | undefined => {
  const text = string(value);
  return text === undefined ? undefined : unsignedDiscordUrl(text);
};

/**
 * Identity of a reaction: the custom emoji ID, or the Unicode emoji itself.
 * `undefined` when Discord sent neither; such a reaction cannot be refreshed.
 */
export const reactionKey = (emoji: {
  readonly id?: string | null;
  readonly name?: string | null;
}): string | undefined => emoji.id || emoji.name || undefined;
/** The membership stream of a reaction for normal (`0`) or burst (`1`) users. */
export const reactionStreamKey = (key: string, type: 0 | 1): ReactionStreamKey => `${key}:${type}`;
/** The reaction a stream belongs to (the inverse of {@link reactionStreamKey}). */
export const reactionKeyOf = (stream: ReactionStreamKey): string =>
  stream.slice(0, stream.lastIndexOf(':'));

export type ArchiveAuthorKind = 'human' | 'bot' | 'webhook' | 'unknown';
/** How policy and statistics classify a message's source. */
export const archiveAuthorKind = (
  message: Pick<ArchiveSnapshot, 'author' | 'webhookId'>,
): ArchiveAuthorKind =>
  message.webhookId !== undefined
    ? 'webhook'
    : message.author === undefined
      ? 'unknown'
      : message.author.bot === true
        ? 'bot'
        : 'human';

const user = (value: unknown): ArchiveUser | undefined => {
  const input = record(value);
  const id = string(input.id);
  if (id === undefined) return undefined;
  return defined({
    id,
    username: string(input.username),
    globalName: input.global_name === null ? null : string(input.global_name),
    bot: boolean(input.bot),
  });
};
const emoji = (value: unknown): ArchiveEmoji =>
  defined({
    id: string(record(value).id),
    name: string(record(value).name),
    animated: boolean(record(value).animated),
  });
const attachment = (value: unknown): ArchiveAttachment => {
  const input = record(value);
  return defined({
    id: string(input.id),
    name: string(input.filename),
    title: string(input.title),
    description: string(input.description),
    contentType: string(input.content_type),
    size: number(input.size),
    width: number(input.width),
    height: number(input.height),
    duration: number(input.duration_secs),
    flags: number(input.flags),
    url: url(input.url),
  });
};
const sticker = (value: unknown): ArchiveSticker => {
  const input = record(value);
  return defined({
    id: string(input.id),
    name: string(input.name),
    format: number(input.format_type),
  });
};
const embedMedia = (value: unknown): ArchiveEmbedMedia | undefined =>
  value === undefined
    ? undefined
    : defined({
        url: url(record(value).url),
        width: number(record(value).width),
        height: number(record(value).height),
      });
const embed = (value: unknown): ArchiveEmbed => {
  const input = record(value);
  return defined({
    type: string(input.type),
    title: string(input.title),
    description: string(input.description),
    url: url(input.url),
    color: number(input.color),
    timestamp: date(input.timestamp),
    author:
      input.author === undefined
        ? undefined
        : defined({
            name: string(record(input.author).name),
            url: url(record(input.author).url),
          }),
    footer:
      input.footer === undefined ? undefined : defined({ text: string(record(input.footer).text) }),
    provider:
      input.provider === undefined
        ? undefined
        : defined({
            name: string(record(input.provider).name),
            url: url(record(input.provider).url),
          }),
    image: embedMedia(input.image),
    thumbnail: embedMedia(input.thumbnail),
    video: embedMedia(input.video),
    fields:
      input.fields === undefined
        ? undefined
        : array(input.fields).map((field) =>
            defined({
              name: string(record(field).name),
              value: string(record(field).value),
              inline: boolean(record(field).inline),
            }),
          ),
  });
};
/** Keeps display text only; custom IDs and other execution payloads are dropped. */
const component = (value: unknown, depth = 0): ArchiveComponent => {
  const input = record(value);
  const output: Raw = {};
  for (const key of ['type', 'label', 'description', 'content', 'placeholder'])
    if (input[key] !== undefined) output[key] = input[key];
  if (typeof input.url === 'string') output.url = unsignedDiscordUrl(input.url);
  if (input.emoji !== undefined) output.emoji = emoji(input.emoji);
  if (input.media !== undefined) output.media = defined({ url: url(record(input.media).url) });
  if (input.options !== undefined)
    output.options = array(input.options).map((option) =>
      defined({
        label: string(record(option).label),
        description: string(record(option).description),
      }),
    );
  if (input.items !== undefined)
    output.items = array(input.items).map((item) => {
      const itemData = record(item);
      return defined({
        description: string(itemData.description),
        spoiler: boolean(itemData.spoiler),
        media:
          itemData.media === undefined
            ? undefined
            : defined({ url: url(record(itemData.media).url) }),
      });
    });
  if (depth < COMPONENT_DEPTH_LIMIT) {
    if (input.components !== undefined)
      output.components = array(input.components).map((child) => component(child, depth + 1));
    if (input.accessory !== undefined) output.accessory = component(input.accessory, depth + 1);
  }
  return output;
};
const reaction = (value: unknown): ArchiveReaction => {
  const input = record(value);
  return defined({
    emoji: emoji(input.emoji),
    count: number(input.count),
    countDetails:
      input.count_details === undefined
        ? undefined
        : defined({
            normal: number(record(input.count_details).normal),
            burst: number(record(input.count_details).burst),
          }),
  });
};
const poll = (value: unknown): ArchivePoll => {
  const input = record(value);
  const results = record(input.results);
  const votes = new Map(
    array(results.answer_counts).map((entry) => [
      number(record(entry).id),
      number(record(entry).count),
    ]),
  );
  return defined({
    question:
      input.question === undefined
        ? undefined
        : defined({ text: string(record(input.question).text) }),
    answers:
      input.answers === undefined
        ? undefined
        : array(input.answers).map((entry) => {
            const answer = record(entry);
            const media = record(answer.poll_media);
            const id = number(answer.answer_id);
            return defined({
              id,
              text: string(media.text),
              emoji:
                media.emoji === undefined || media.emoji === null ? undefined : emoji(media.emoji),
              voteCount: id === undefined ? undefined : votes.get(id),
            });
          }),
    expiresTimestamp: date(input.expiry),
    allowMultiselect: boolean(input.allow_multiselect),
    resultsFinalized: boolean(results.is_finalized),
  });
};
const interactionMetadata = (value: unknown): ArchiveInteractionMetadata => {
  const input = record(value);
  return defined({
    id: string(input.id),
    type: number(input.type),
    user: user(input.user),
    targetUserId: string(record(input.target_user).id),
    targetMessageId: string(input.target_message_id),
    interactedMessageId: string(input.interacted_message_id),
  });
};
const reference = (raw: Raw): ArchiveReference => {
  const input = record(raw.message_reference);
  return defined({
    guildId: string(input.guild_id),
    channelId: string(input.channel_id),
    messageId: string(input.message_id),
    type: number(input.type),
    // Discord sends `referenced_message: null` once the original is deleted.
    authorId: string(record(record(raw.referenced_message).author).id),
  });
};
const editedTimestamp = (value: unknown): number | null | undefined =>
  value === null ? null : date(value);
const messageSnapshot = (value: unknown): ArchiveMessageSnapshot => {
  const input = record(record(value).message);
  return defined({
    type: number(input.type),
    flags: number(input.flags),
    content: string(input.content),
    createdTimestamp: date(input.timestamp),
    editedTimestamp: editedTimestamp(input.edited_timestamp),
    attachments: 'attachments' in input ? array(input.attachments).map(attachment) : undefined,
    stickers: 'sticker_items' in input ? array(input.sticker_items).map(sticker) : undefined,
    embeds: 'embeds' in input ? array(input.embeds).map(embed) : undefined,
    components:
      'components' in input ? array(input.components).map((child) => component(child)) : undefined,
  });
};
const mentions = (raw: Raw): ArchiveMentions | undefined => {
  if (
    !('mentions' in raw) &&
    !('mention_roles' in raw) &&
    !('mention_channels' in raw) &&
    !('mention_everyone' in raw)
  )
    return undefined;
  return defined({
    users:
      'mentions' in raw ? ids(array(raw.mentions).map((entry) => record(entry).id)) : undefined,
    roles: 'mention_roles' in raw ? ids(raw.mention_roles) : undefined,
    channels:
      'mention_channels' in raw
        ? ids(array(raw.mention_channels).map((entry) => record(entry).id))
        : undefined,
    everyone: 'mention_everyone' in raw ? raw.mention_everyone === true : undefined,
  });
};

/**
 * Maps a Discord API message (REST or Gateway) to the stored shape. A key the
 * payload omits stays absent, so a partial Gateway update never erases a field.
 * The deprecated `interaction` field is never read.
 */
export const normalizeMessage = (raw: Raw, context: NormalizeContext): ArchiveSnapshot => {
  if (typeof raw.id !== 'string' || !/^\d+$/.test(raw.id))
    throw new TypeError('Message id must be a snowflake string');
  const channelId = string(raw.channel_id) ?? context.channelId;
  if (!channelId) throw new TypeError('Message channel id is required');
  const list = <T>(key: string, map: (value: unknown) => T): T[] | undefined =>
    key in raw ? array(raw[key]).map(map) : undefined;
  return defined<ArchiveSnapshot>({
    _id: raw.id,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    channelId,
    createdTimestamp: date(raw.timestamp) ?? snowflakeTimestamp(raw.id),
    observedAt: context.observedAt,
    author: user(raw.author),
    webhookId: string(raw.webhook_id),
    applicationId: string(raw.application_id),
    interactionMetadata:
      raw.interaction_metadata === undefined || raw.interaction_metadata === null
        ? undefined
        : interactionMetadata(raw.interaction_metadata),
    type: number(raw.type),
    flags: number(raw.flags),
    content: string(raw.content),
    editedTimestamp: editedTimestamp(raw.edited_timestamp),
    attachments: list('attachments', attachment),
    stickers: list('sticker_items', sticker),
    embeds: list('embeds', embed),
    components: list('components', (value) => component(value)),
    reactions: list('reactions', reaction),
    mentions: mentions(raw),
    reference: 'message_reference' in raw ? reference(raw) : undefined,
    thread:
      'thread' in raw
        ? optional({
            id: string(record(raw.thread).id),
            name: string(record(raw.thread).name),
            type: number(record(raw.thread).type),
          })
        : undefined,
    poll: !('poll' in raw) ? undefined : raw.poll === null ? null : poll(raw.poll),
    messageSnapshots: list('message_snapshots', messageSnapshot),
  });
};

/** Observed fields copied as a whole; `mentions`, `reference` and `poll` merge per field. */
const OBSERVED_FIELDS = [
  'author',
  'webhookId',
  'applicationId',
  'interactionMetadata',
  'type',
  'flags',
  'content',
  'editedTimestamp',
  'attachments',
  'stickers',
  'embeds',
  'components',
  'reactions',
  'thread',
  'messageSnapshots',
] as const satisfies readonly (keyof ArchiveSnapshot)[];
/** Backup metadata that describes reaction membership; meaningless without reactions. */
const REACTION_METADATA = ['reactionGenerations', 'reactionsFreshAt', 'reactionsStaleAt'] as const;

/** The content version a document or observation holds, when its edit time is known. */
const contentVersion = (message: Partial<ArchiveSnapshot>): number | undefined =>
  message.editedTimestamp === undefined
    ? undefined
    : (message.editedTimestamp ?? message.createdTimestamp);

/**
 * Whether `incoming` is older than the stored document. A known content version
 * decides first; otherwise the later observation wins.
 */
export const isStaleObservation = (
  existing: Partial<ArchiveMessage>,
  incoming: ArchiveSnapshot,
): boolean => {
  const stored = contentVersion(existing);
  const observed = contentVersion(incoming);
  if (stored !== undefined && observed !== undefined && stored !== observed)
    return observed < stored;
  return (existing.observedAt ?? 0) > incoming.observedAt;
};

/** A real edit: both edit times are known and differ. Link previews, votes and reactions are not. */
const isEdit = (existing: Partial<ArchiveMessage>, incoming: ArchiveSnapshot): boolean =>
  existing.editedTimestamp !== undefined &&
  incoming.editedTimestamp !== undefined &&
  existing.editedTimestamp !== incoming.editedTimestamp;

const previousVersion = (existing: Partial<ArchiveMessage>, observedAt: number): ArchiveEdit =>
  defined<ArchiveEdit>({
    editedTimestamp: existing.editedTimestamp,
    observedAt: existing.observedAt ?? observedAt,
    content: existing.content,
    attachments: existing.attachments,
    embeds: existing.embeds,
    components: existing.components,
  });

/** Copies `key` from `incoming` when it carries the field (and, for `onlyAbsent`, the target lacks it). */
const copyField = <K extends (typeof OBSERVED_FIELDS)[number]>(
  target: ArchiveMessage,
  incoming: ArchiveSnapshot,
  key: K,
  onlyAbsent: boolean,
): void => {
  if (incoming[key] !== undefined && (!onlyAbsent || target[key] === undefined))
    target[key] = incoming[key];
};

/**
 * A poll observed without results (vote counts, finalization) keeps the stored
 * ones; a newer result replaces them.
 */
const mergePoll = (
  existing: ArchivePoll | null | undefined,
  incoming: ArchivePoll | null,
): ArchivePoll | null => {
  if (incoming === null || existing === null || existing === undefined) return incoming;
  const votes = new Map(existing.answers?.map((answer) => [answer.id, answer.voteCount]));
  return defined<ArchivePoll>({
    ...incoming,
    answers: incoming.answers?.map((answer) =>
      defined({ ...answer, voteCount: answer.voteCount ?? votes.get(answer.id) }),
    ),
    resultsFinalized: incoming.resultsFinalized ?? existing.resultsFinalized,
  });
};

/** Applies a policy-limited observation: excluded fields and their history go. */
const applyExclusions = (result: ArchiveMessage, incoming: ArchiveSnapshot): void => {
  if (incoming.excludedFields === undefined) {
    delete result.excludedFields;
    return;
  }
  result.excludedFields = incoming.excludedFields;
  for (const key of incoming.excludedFields) delete result[key];
  delete result.editHistory;
  delete result.editHistoryDropped;
  if (incoming.excludedFields.includes('reactions'))
    for (const key of REACTION_METADATA) delete result[key];
};

/**
 * Applies a newer observation to a stored document: fields the observation
 * carries replace the stored ones, the rest stay; `mentions` and `reference`
 * merge per field and a poll without results keeps the stored counts. An edit
 * moves the previous content into `editHistory` (at most
 * {@link ARCHIVE_EDIT_HISTORY_LIMIT}, oldest dropped and counted). Deletion and
 * reaction metadata are kept. A policy-limited observation (`excludedFields`)
 * removes the excluded fields and their history. Callers reject or fill stale
 * observations first (`isStaleObservation`, `fillSnapshot`).
 */
export const mergeSnapshot = (
  existing: Partial<ArchiveMessage>,
  incoming: ArchiveSnapshot,
): ArchiveMessage => {
  const result: ArchiveMessage = {
    ...existing,
    _id: incoming._id,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    channelId: incoming.channelId,
    createdTimestamp: incoming.createdTimestamp,
    observedAt: Math.max(existing.observedAt ?? 0, incoming.observedAt),
  };
  if (isEdit(existing, incoming)) {
    const history = [
      ...(existing.editHistory ?? []),
      previousVersion(existing, incoming.observedAt),
    ];
    const dropped = Math.max(0, history.length - ARCHIVE_EDIT_HISTORY_LIMIT);
    result.editHistory = history.slice(dropped);
    if (dropped > 0) result.editHistoryDropped = (existing.editHistoryDropped ?? 0) + dropped;
  }
  for (const key of OBSERVED_FIELDS) copyField(result, incoming, key, false);
  if (incoming.mentions !== undefined)
    result.mentions = { ...existing.mentions, ...incoming.mentions };
  if (incoming.reference !== undefined)
    result.reference = { ...existing.reference, ...incoming.reference };
  if (incoming.poll !== undefined) result.poll = mergePoll(existing.poll, incoming.poll);
  if (incoming.policy === undefined) delete result.policy;
  else result.policy = incoming.policy;
  applyExclusions(result, incoming);
  return result;
};

/**
 * Applies an observation older than the stored document (see
 * `isStaleObservation`) without letting it replace anything: it only fills
 * fields the document lacks, for example after a tombstone or a partial update.
 * No edit history is recorded and deletion and freshness stay as stored.
 * Returns `undefined` when there is nothing to fill.
 */
export const fillSnapshot = (
  existing: ArchiveMessage,
  incoming: ArchiveSnapshot,
): ArchiveMessage | undefined => {
  const result: ArchiveMessage = { ...existing };
  const excluded = new Set<string>(existing.excludedFields ?? []);
  for (const key of OBSERVED_FIELDS) if (!excluded.has(key)) copyField(result, incoming, key, true);
  if (!excluded.has('mentions')) result.mentions ??= incoming.mentions;
  if (!excluded.has('reference')) result.reference ??= incoming.reference;
  if (!excluded.has('poll') && result.poll === undefined) result.poll = incoming.poll;
  result.policy ??= incoming.policy;
  if (result.excludedFields === undefined && incoming.excludedFields !== undefined)
    applyExclusions(result, incoming);
  const filled = Object.keys(result).filter(
    (key) => !(key in existing) && result[key as keyof ArchiveMessage] !== undefined,
  );
  if (filled.length === 0) return undefined;
  return defined(result);
};
