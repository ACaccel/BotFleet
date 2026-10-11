/**
 * Aggregation pipelines of {@link MongoArchiveStatsRepo}. Every pipeline starts with
 * a `$match` on `createdTimestamp` (and `channelId` when scoped) so the
 * `{ channelId, createdTimestamp }` or `{ createdTimestamp }` index bounds the scan;
 * several statistics then share that single scan through `$facet`. Builders are
 * exported so the integration tests can `explain()` exactly what the repo runs.
 */
import {
  FORWARD_REFERENCE_TYPE,
  INTERACTION_TYPES,
  MEMBER_MESSAGE_TYPES,
  REPLY_MESSAGE_TYPE,
  VOICE_MESSAGE_FLAG,
  type StatsWindow,
} from '../../core/archive/stats';

export type Stage = Record<string, unknown>;
type Facets = Record<string, Stage[]>;

const DISCORD_EPOCH = 1_420_070_400_000n;

const timeRange = (window: StatsWindow): Stage => ({ $gte: window.startMs, $lt: window.endMs });
const spanOf = (windows: readonly StatsWindow[]): StatsWindow => ({
  startMs: Math.min(...windows.map((window) => window.startMs)),
  endMs: Math.max(...windows.map((window) => window.endMs)),
});

/**
 * Member activity: types 0 and 19 from human authors. Documents without `author`
 * (tombstones and unresolved identities) never count; deleted messages do.
 */
const memberMessage: Stage = {
  type: { $in: [...MEMBER_MESSAGE_TYPES] },
  'author.id': { $exists: true },
  'author.bot': { $ne: true },
  webhookId: { $exists: false },
};

/**
 * Member messages in the visible channels across every window. The window span is
 * one index range; facets narrow to their own window.
 */
const memberActivityMatch = (
  windows: readonly StatsWindow[],
  channelIds: readonly string[] | undefined,
): Stage => ({
  $match: {
    ...(channelIds === undefined ? {} : { channelId: { $in: [...channelIds] } }),
    createdTimestamp: timeRange(spanOf(windows)),
    ...memberMessage,
  },
});

/** Scopes covering more than this share of the recorded channels scan by time. */
const WIDE_SCOPE_SHARE = 0.25;

/**
 * The index a channel-scoped scan must use. A wide scope (most of the guild) reads
 * the window in `createdTimestamp` order, which follows the storage order; the
 * `{ channelId, createdTimestamp }` index would fetch the same documents channel by
 * channel across the whole window and thrash the cache once the window outgrows it
 * (about 10x slower on 3 million messages with a 1 GiB cache). A narrow scope, such
 * as one channel and its threads, examines only its own keys through the compound
 * index. The query planner cannot tell these apart in its short trial, so the
 * choice is explicit.
 */
export const scanIndexHint = (
  scopedChannels: number,
  recordedChannels: number,
): Readonly<Record<string, 1>> =>
  scopedChannels > recordedChannels * WIDE_SCOPE_SHARE
    ? { createdTimestamp: 1 }
    : { channelId: 1, createdTimestamp: 1 };

const windowMatch = (window: StatsWindow, authorId?: string): Stage => ({
  $match: {
    createdTimestamp: timeRange(window),
    ...(authorId === undefined ? {} : { 'author.id': authorId }),
  },
});

const attachmentList: Stage = { $ifNull: ['$attachments', []] };
const isMedia = (contentType: string): Stage => ({
  $regexMatch: { input: { $ifNull: [contentType, ''] }, regex: '^(image|video)/' },
});
/** `flags` has the bit set; the comparison spares most messages the arithmetic. */
const hasFlag = (flag: number): Stage => ({
  $and: [
    { $gte: ['$flags', flag] },
    { $eq: [{ $mod: [{ $floor: { $divide: ['$flags', flag] } }, 2] }, 1] },
  ],
});
const countIf = (condition: Stage | string): Stage => ({ $sum: { $cond: [condition, 1, 0] } });
// Presence tests by BSON comparison: a non-empty array sorts above `[]` and any
// object at or above `{}`, while a missing field or `null` sorts below both. They
// avoid materializing the value, which `$size` and `$type` do for every message.
const nonEmptyArray = (field: string): Stage => ({ $gt: [field, []] });
const hasAttachments = nonEmptyArray('$attachments');
// `$and` short-circuits, so this cheap test spares most messages the regex.
const mayHaveUrl: Stage = { $gte: [{ $indexOfBytes: [{ $ifNull: ['$content', ''] }, '://'] }, 0] };

/**
 * Content categories, counted per message; one message can fall into several.
 * `gate` limits every counter to the messages it accepts.
 */
const contentCounters = (gate?: Stage): Stage => {
  const counter = (...conditions: Stage[]): Stage =>
    countIf({ $and: [...(gate === undefined ? [] : [gate]), ...conditions] });
  return {
    edited: counter({ $isNumber: '$editedTimestamp' }),
    media: counter(hasAttachments, {
      $anyElementTrue: [{ $map: { input: attachmentList, in: isMedia('$$this.contentType') } }],
    }),
    // A voice message's audio attachment counts as a voice message, not as a file.
    files: counter(
      hasAttachments,
      { $not: [hasFlag(VOICE_MESSAGE_FLAG)] },
      {
        $anyElementTrue: [
          { $map: { input: attachmentList, in: { $not: [isMedia('$$this.contentType')] } } },
        ],
      },
    ),
    voice: counter(hasFlag(VOICE_MESSAGE_FLAG)),
    links: counter(mayHaveUrl, {
      $regexMatch: { input: '$content', regex: 'https?://', options: 'i' },
    }),
    stickers: counter(nonEmptyArray('$stickers')),
    polls: counter({ $gte: ['$poll', {}] }),
    forwards: counter({ $eq: ['$reference.type', FORWARD_REFERENCE_TYPE] }),
    replies: counter({ $eq: ['$type', REPLY_MESSAGE_TYPE] }),
  };
};

/** The newest name observed for an author: `$max` compares the timestamp first. */
const latestAuthorName: Stage = {
  $max: {
    at: '$createdTimestamp',
    username: '$author.username',
    globalName: '$author.globalName',
  },
};

/**
 * The UTC quarter hour of a message. Every time zone offset is a multiple of 15
 * minutes, so local hours, days and weeks are unions of quarter hours; mapping the
 * few distinct quarters to local time in the repository avoids a time zone
 * conversion per document, the costliest per-document expression.
 */
export const QUARTER_HOUR_MS = 900_000;
const quarterHour: Stage = { $floor: { $divide: ['$createdTimestamp', QUARTER_HOUR_MS] } };

const inWindow = (window: StatsWindow): Stage => ({
  $and: [
    { $gte: ['$createdTimestamp', window.startMs] },
    { $lt: ['$createdTimestamp', window.endMs] },
  ],
});

/**
 * Per-document tests for the current and previous window when the scan spans both.
 * The usual previous window ends where the current one starts, so one comparison
 * decides; any other layout tests both bounds.
 */
const windowGates = (
  plan: Pick<ActivityPlan, 'window' | 'previousWindow'>,
): { readonly current: Stage; readonly previous: Stage } | undefined => {
  const { window, previousWindow } = plan;
  if (previousWindow === undefined) return undefined;
  if (previousWindow.endMs === window.startMs)
    return {
      current: { $gte: ['$createdTimestamp', window.startMs] },
      previous: { $lt: ['$createdTimestamp', window.startMs] },
    };
  return { current: inWindow(window), previous: inWindow(previousWindow) };
};

/**
 * The facets one activity query needs. Each `$facet` sub-pipeline costs about as
 * much per document as its own expressions, so statistics sharing a grouping share
 * a facet: one channel group per author filter also yields the summary totals; one
 * author group serves the ranking, retention and active members; one quarter-hour
 * group per author filter serves trend, heat map and active days. `filters` lists
 * the author filters in use, `''` meaning every member.
 */
export interface ActivityPlan {
  readonly window: StatsWindow;
  readonly previousWindow?: StatsWindow;
  /** Every author filter in use; a facet's name carries its filter's index. */
  readonly filters: readonly string[];
  /**
   * Per-channel counts per author filter; with `totals`, also the previous-window
   * count and the content counters, which the repository sums over channels.
   */
  readonly channels: readonly { readonly filter: string; readonly totals: boolean }[];
  /** Quarter-hour counts per window, per author filter. */
  readonly time: readonly string[];
  /** Counts per reaction, per author filter. */
  readonly reactions: readonly string[];
  readonly authors?: { readonly limit: number; readonly rankOf?: string };
  readonly partners?: { readonly userId: string; readonly excludeUserIds: readonly string[] };
  readonly topMessages?: { readonly limit: number };
}

/** Facet name of a statistic for one author filter. */
export const facetName = (kind: string, filter: string, filters: readonly string[]): string =>
  `${kind}${filters.indexOf(filter)}`;

const authorMatch = (filter: string): Stage[] =>
  filter === '' ? [] : [{ $match: { 'author.id': filter } }];

const channelsFacet = (plan: ActivityPlan, filter: string, totals: boolean): Stage[] => {
  // With a previous window the scan spans both windows, so counters are gated.
  const gates = windowGates(plan);
  return [
    ...authorMatch(filter),
    {
      $group: {
        _id: '$channelId',
        messages: gates === undefined ? { $sum: 1 } : countIf(gates.current),
        ...(totals && gates !== undefined ? { previous: countIf(gates.previous) } : {}),
        ...(totals ? contentCounters(gates?.current) : {}),
      },
    },
  ];
};

/**
 * Every author with message counts in both windows, reduced in the database to the
 * top rows, the membership counts retention needs, and the subject's rank.
 */
const authorsFacet = (
  plan: ActivityPlan,
  options: NonNullable<ActivityPlan['authors']>,
): Stage[] => {
  const gates = windowGates(plan);
  const name: Stage = {
    at: '$createdTimestamp',
    username: '$author.username',
    globalName: '$author.globalName',
  };
  // Without a previous window every scanned message is in the window.
  const perAuthor: Stage =
    gates === undefined
      ? { _id: '$author.id', current: { $sum: 1 }, previous: { $sum: 0 }, name: { $max: name } }
      : {
          _id: '$author.id',
          current: countIf(gates.current),
          previous: countIf(gates.previous),
          name: { $max: { $cond: [gates.current, name, null] } },
        };
  return [
    { $group: perAuthor },
    ...(options.rankOf === undefined
      ? []
      : [{ $setWindowFields: { sortBy: { current: -1 }, output: { rank: { $rank: {} } } } }]),
    {
      $group: {
        _id: null,
        top: {
          $topN: {
            n: options.limit,
            sortBy: { current: -1, _id: 1 },
            output: { userId: '$_id', messages: '$current', name: '$name' },
          },
        },
        currentMembers: countIf({ $gt: ['$current', 0] }),
        previousMembers: countIf({ $gt: ['$previous', 0] }),
        retained: countIf({ $and: [{ $gt: ['$current', 0] }, { $gt: ['$previous', 0] }] }),
        currentTotal: { $sum: '$current' },
        previousTotal: { $sum: '$previous' },
        ...(options.rankOf === undefined
          ? {}
          : {
              subject: {
                $max: {
                  $cond: [
                    { $and: [{ $eq: ['$_id', options.rankOf] }, { $gt: ['$current', 0] }] },
                    { rank: '$rank', messages: '$current' },
                    null,
                  ],
                },
              },
            }),
      },
    },
  ];
};

const reactionKeyExpression: Stage = {
  $ifNull: ['$reactions.emoji.id', '$reactions.emoji.name', null],
};
/** Last observed count per reaction on the window's messages. */
const reactionsFacet = (window: StatsWindow, filter: string): Stage[] => [
  ...authorMatch(filter),
  { $match: { createdTimestamp: timeRange(window), 'reactions.0': { $exists: true } } },
  { $unwind: '$reactions' },
  { $match: { $expr: { $ne: [reactionKeyExpression, null] } } },
  {
    $group: {
      _id: reactionKeyExpression,
      count: { $sum: { $ifNull: ['$reactions.count', 0] } },
      emoji: {
        $max: {
          at: '$createdTimestamp',
          id: '$reactions.emoji.id',
          name: '$reactions.emoji.name',
          animated: '$reactions.emoji.animated',
        },
      },
    },
  },
];

/**
 * Reply and mention exchanges with one member. A reply's automatic mention of the
 * replied-to author is not counted again as a mention; self-interactions, the
 * excluded IDs (bots the caller knows of) and anyone whose message the member replied
 * to was a bot's never count. A bot only ever mentioned cannot be told apart here.
 */
const partnerFacets = (
  options: NonNullable<ActivityPlan['partners']>,
  window: StatsWindow,
): Facets => {
  const { userId } = options;
  const excluded = [userId, ...options.excludeUserIds];
  const repliedAuthor: Stage = {
    $cond: [
      { $eq: ['$type', REPLY_MESSAGE_TYPE] },
      { $ifNull: ['$reference.authorId', null] },
      null,
    ],
  };
  return {
    partnersOut: [
      windowMatch(window, userId),
      // The replied-to message tells whether its author is a bot; a mention does not.
      {
        $lookup: {
          from: 'messages',
          localField: 'reference.messageId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 0, bot: '$author.bot' } }],
          as: 'repliedMessage',
        },
      },
      {
        $project: {
          replied: repliedAuthor,
          repliedBot: { $eq: [{ $first: '$repliedMessage.bot' }, true] },
          mentioned: { $setUnion: [{ $ifNull: ['$mentions.users', []] }, []] },
        },
      },
      {
        $project: {
          pairs: {
            $concatArrays: [
              {
                $cond: [
                  { $eq: ['$replied', null] },
                  [],
                  [{ userId: '$replied', reply: 1, bot: '$repliedBot' }],
                ],
              },
              {
                $map: {
                  input: {
                    $filter: { input: '$mentioned', cond: { $ne: ['$$this', '$replied'] } },
                  },
                  in: { userId: '$$this', reply: 0, bot: false },
                },
              },
            ],
          },
        },
      },
      { $unwind: '$pairs' },
      { $match: { 'pairs.userId': { $nin: excluded } } },
      {
        $group: {
          _id: '$pairs.userId',
          repliesTo: { $sum: '$pairs.reply' },
          mentionsTo: { $sum: { $subtract: [1, '$pairs.reply'] } },
          bot: { $max: '$pairs.bot' },
        },
      },
      { $match: { bot: { $ne: true } } },
    ],
    partnersIn: [
      windowMatch(window),
      {
        $match: {
          'author.id': { $nin: excluded },
          $or: [
            { type: REPLY_MESSAGE_TYPE, 'reference.authorId': userId },
            { 'mentions.users': userId },
          ],
        },
      },
      {
        $project: {
          author: '$author.id',
          replied: { $eq: [repliedAuthor, userId] },
          mentioned: { $in: [userId, { $ifNull: ['$mentions.users', []] }] },
        },
      },
      {
        $group: {
          _id: '$author',
          repliesFrom: countIf('$replied'),
          mentionsFrom: countIf({ $and: ['$mentioned', { $not: ['$replied'] }] }),
        },
      },
    ],
  };
};

/** Live messages ordered by their last observed reaction total. */
const topMessagesFacet = (limit: number, window: StatsWindow): Facets => ({
  topMessages: [
    windowMatch(window),
    { $match: { deletedAt: { $exists: false }, 'reactions.0': { $exists: true } } },
    { $addFields: { totalReactions: { $sum: '$reactions.count' } } },
    { $match: { totalReactions: { $gt: 0 } } },
    { $sort: { totalReactions: -1, createdTimestamp: 1, _id: 1 } },
    { $limit: limit },
    {
      $project: {
        channelId: 1,
        createdTimestamp: 1,
        author: 1,
        type: 1,
        flags: 1,
        content: 1,
        editedTimestamp: 1,
        'attachments.contentType': 1,
        'attachments.name': 1,
        'stickers.id': 1,
        'stickers.name': 1,
        'poll.question.text': 1,
        'messageSnapshots.content': 1,
        reactions: 1,
        totalReactions: 1,
      },
    },
  ],
});

/** Every planned activity statistic as one `$facet` over a single indexed scan. */
export const activityPipeline = (channelIds: readonly string[], plan: ActivityPlan): Stage[] => {
  const { window, previousWindow } = plan;
  const named = (kind: string, filter: string): string => facetName(kind, filter, plan.filters);
  const facets: Facets = {};
  for (const { filter, totals } of plan.channels)
    facets[named('channels', filter)] = channelsFacet(plan, filter, totals);
  // A quarter hour can straddle a window bound, so rows also say which window.
  const gates = windowGates(plan);
  for (const filter of plan.time)
    facets[named('time', filter)] = [
      ...authorMatch(filter),
      {
        $group: {
          _id: {
            quarter: quarterHour,
            current: gates === undefined ? { $literal: true } : gates.current,
          },
          messages: { $sum: 1 },
        },
      },
    ];
  for (const filter of plan.reactions)
    facets[named('reactions', filter)] = reactionsFacet(window, filter);
  if (plan.authors) facets.authors = authorsFacet(plan, plan.authors);
  if (plan.partners) Object.assign(facets, partnerFacets(plan.partners, window));
  if (plan.topMessages) Object.assign(facets, topMessagesFacet(plan.topMessages.limit, window));
  const windows = [window, ...(previousWindow === undefined ? [] : [previousWindow])];
  return [memberActivityMatch(windows, channelIds), { $facet: facets }];
};

/** Lowest snowflake created at or after `timestampMs`. */
export const snowflakeAt = (timestampMs: number): bigint => {
  const sinceEpoch = BigInt(Math.floor(timestampMs)) - DISCORD_EPOCH;
  return sinceEpoch > 0n ? sinceEpoch << 22n : 0n;
};

/**
 * `messageId` conditions for snowflakes created in the window. IDs are decimal
 * strings without leading zeros, so string order equals numeric order only between
 * equal lengths; the range is split per length and each branch checks its length.
 */
const snowflakeRangeMatch = (window: StatsWindow): Stage[] => {
  const lower = snowflakeAt(window.startMs);
  const upper = snowflakeAt(window.endMs) - 1n;
  if (upper < lower) return [{ messageId: { $in: [] } }];
  const lowerText = lower.toString();
  const upperText = upper.toString();
  const branches: Stage[] = [];
  for (let length = lowerText.length; length <= upperText.length; length += 1) {
    const from = length === lowerText.length ? lowerText : `1${'0'.repeat(length - 1)}`;
    const to = length === upperText.length ? upperText : '9'.repeat(length);
    branches.push({
      messageId: { $gte: from, $lte: to, $regex: `^[0-9]{${length}}$` },
    });
  }
  return branches;
};

/**
 * Reactions a member gave on other members' messages, by reaction key. Reactions on
 * bot, webhook and system messages do not count, like every member statistic. Counts only
 * chunks of the published membership generation of each stream; older generations
 * awaiting garbage collection would otherwise count twice.
 */
export const reactionsGivenPipeline = (
  window: StatsWindow,
  userId: string,
  channelIds: readonly string[],
): Stage[] => [
  {
    $match: {
      $or: snowflakeRangeMatch(window),
      channelId: { $in: [...channelIds] },
      userIds: userId,
    },
  },
  {
    $lookup: {
      from: 'messages',
      localField: 'messageId',
      foreignField: '_id',
      // Only member messages: the same author, bot, webhook and type rules as every count.
      pipeline: [
        { $match: memberMessage },
        { $project: { 'author.id': 1, reactionGenerations: 1, 'reactions.emoji': 1 } },
      ],
      as: 'message',
    },
  },
  { $unwind: '$message' },
  {
    $match: {
      'message.author.id': { $exists: true, $ne: userId },
      $expr: {
        $in: [
          { k: { $concat: ['$emojiKey', ':', { $toString: '$type' }] }, generation: '$generation' },
          {
            $map: {
              input: { $objectToArray: { $ifNull: ['$message.reactionGenerations', {}] } },
              in: { k: '$$this.k', generation: '$$this.v.generation' },
            },
          },
        ],
      },
    },
  },
  {
    $group: {
      _id: '$emojiKey',
      count: { $sum: 1 },
      emoji: {
        $first: {
          $first: {
            $filter: {
              input: { $ifNull: ['$message.reactions.emoji', []] },
              cond: {
                $eq: [{ $ifNull: ['$$this.id', '$$this.name'] }, '$emojiKey'],
              },
            },
          },
        },
      },
    },
  },
  { $sort: { count: -1, _id: 1 } },
];

/**
 * Interaction records: bot replies that carry `interactionMetadata`, which the
 * archive keeps even for bots outside the allowlist. A follow-up message shares its
 * interaction ID, so uses are counted per interaction.
 */
export const appUsagePipeline = (
  window: StatsWindow,
  channelIds: readonly string[],
  options: {
    readonly applicationId?: string;
    readonly userId?: string;
    readonly limit: number;
    /** Adds quarter-hour use counts for a trend or heat map. */
    readonly time?: boolean;
  },
): Stage[] => {
  const applicationExpression: Stage = { $ifNull: ['$applicationId', '$author.id'] };
  const perInteraction: Stage[] = [
    {
      $group: {
        _id: { $ifNull: ['$interactionMetadata.id', '$_id'] },
        applicationId: { $first: applicationExpression },
        type: { $first: '$interactionMetadata.type' },
        userId: { $first: '$interactionMetadata.user.id' },
        userBot: { $first: '$interactionMetadata.user.bot' },
        createdTimestamp: { $min: '$createdTimestamp' },
        name: latestAuthorName,
      },
    },
  ];
  const typeCount = (type: number): Stage => countIf({ $eq: ['$type', type] });
  // A bot that triggers an interaction is not a member; `null` is dropped from the sets.
  const memberUser: Stage = { $cond: [{ $eq: ['$userBot', true] }, null, '$userId'] };
  return [
    {
      $match: {
        channelId: { $in: [...channelIds] },
        createdTimestamp: timeRange(window),
        interactionMetadata: { $exists: true },
        'author.bot': true,
        ...(options.applicationId === undefined
          ? {}
          : {
              $or: [
                { applicationId: options.applicationId },
                { applicationId: { $exists: false }, 'author.id': options.applicationId },
              ],
            }),
        ...(options.userId === undefined ? {} : { 'interactionMetadata.user.id': options.userId }),
      },
    },
    ...perInteraction,
    {
      $facet: {
        apps: [
          {
            $group: {
              _id: '$applicationId',
              uses: { $sum: 1 },
              commands: typeCount(INTERACTION_TYPES.command),
              components: typeCount(INTERACTION_TYPES.component),
              modals: typeCount(INTERACTION_TYPES.modal),
              users: { $addToSet: memberUser },
              name: { $max: '$name' },
            },
          },
          {
            $project: {
              uses: 1,
              commands: 1,
              components: 1,
              modals: 1,
              name: 1,
              users: { $size: { $setDifference: ['$users', [null]] } },
            },
          },
          { $sort: { uses: -1, _id: 1 } },
        ],
        users: [
          { $match: { userId: { $ne: null }, userBot: { $ne: true } } },
          { $group: { _id: '$userId', uses: { $sum: 1 } } },
          { $sort: { uses: -1, _id: 1 } },
          { $limit: options.limit },
        ],
        totals: [
          {
            $group: {
              _id: null,
              uses: { $sum: 1 },
              users: { $addToSet: memberUser },
              firstAt: { $min: '$createdTimestamp' },
            },
          },
          {
            $project: {
              uses: 1,
              firstAt: 1,
              users: { $size: { $setDifference: ['$users', [null]] } },
            },
          },
        ],
        ...(options.time === true
          ? {
              time: [
                {
                  $group: {
                    _id: { $floor: { $divide: ['$createdTimestamp', QUARTER_HOUR_MS] } },
                    uses: { $sum: 1 },
                  },
                },
              ],
            }
          : {}),
      },
    },
  ];
};

/** Custom emoji in message text: `<:name:id>` or `<a:name:id>`. */
const CUSTOM_EMOJI_PATTERN = '<a?:[A-Za-z0-9_~]+:([0-9]+)>';

/**
 * Uses of the given custom emoji in message text (every occurrence) and in reactions
 * (`reactions[].count`, super reactions included), across all channels.
 */
export const emojiUsagePipeline = (window: StatsWindow, emojiIds: readonly string[]): Stage[] => [
  memberActivityMatch([window], undefined),
  {
    $facet: {
      content: [
        { $match: { content: { $regex: CUSTOM_EMOJI_PATTERN } } },
        {
          $project: {
            found: { $regexFindAll: { input: '$content', regex: CUSTOM_EMOJI_PATTERN } },
          },
        },
        { $unwind: '$found' },
        { $project: { emojiId: { $arrayElemAt: ['$found.captures', 0] } } },
        { $match: { emojiId: { $in: [...emojiIds] } } },
        { $group: { _id: '$emojiId', count: { $sum: 1 } } },
      ],
      reactions: [
        { $match: { 'reactions.emoji.id': { $in: [...emojiIds] } } },
        { $unwind: '$reactions' },
        { $match: { 'reactions.emoji.id': { $in: [...emojiIds] } } },
        {
          $group: {
            _id: '$reactions.emoji.id',
            count: { $sum: { $ifNull: ['$reactions.count', 0] } },
          },
        },
      ],
    },
  },
];

/** Messages carrying each of the given stickers, across all channels. */
export const stickerUsagePipeline = (
  window: StatsWindow,
  stickerIds: readonly string[],
): Stage[] => [
  memberActivityMatch([window], undefined),
  { $match: { 'stickers.id': { $in: [...stickerIds] } } },
  { $unwind: '$stickers' },
  { $match: { 'stickers.id': { $in: [...stickerIds] } } },
  { $group: { _id: '$stickers.id', count: { $sum: 1 } } },
];
