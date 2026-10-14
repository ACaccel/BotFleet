import type { GayStatsQuery } from './gay-stats.types';

type Stage = Record<string, unknown>;

// PCRE2 supports Unicode category properties but not JavaScript's emoji properties.
const EMOJI_PATTERN = String.raw`<a?:[A-Za-z0-9_]+:[0-9]+>|[\x{231a}-\x{231b}\x{23e9}-\x{23ec}\x{23f0}\x{23f3}\x{25fd}-\x{25fe}\x{2614}-\x{2615}\x{2648}-\x{2653}\x{267f}\x{2693}\x{26a1}\x{26aa}-\x{26ab}\x{26bd}-\x{26be}\x{26c4}-\x{26c5}\x{26ce}\x{26d4}\x{26ea}\x{26f2}-\x{26f3}\x{26f5}\x{26fa}\x{26fd}\x{2705}\x{270a}-\x{270b}\x{2728}\x{274c}\x{274e}\x{2753}-\x{2755}\x{2757}\x{2795}-\x{2797}\x{27b0}\x{27bf}\x{2b1b}-\x{2b1c}\x{2b50}\x{2b55}\x{1f004}\x{1f0cf}\x{1f18e}\x{1f191}-\x{1f19a}\x{1f1e6}-\x{1f1ff}\x{1f201}\x{1f21a}\x{1f22f}\x{1f232}-\x{1f236}\x{1f238}-\x{1f23a}\x{1f250}-\x{1f251}\x{1f300}-\x{1f320}\x{1f32d}-\x{1f335}\x{1f337}-\x{1f37c}\x{1f37e}-\x{1f393}\x{1f3a0}-\x{1f3ca}\x{1f3cf}-\x{1f3d3}\x{1f3e0}-\x{1f3f0}\x{1f3f4}\x{1f3f8}-\x{1f43e}\x{1f440}\x{1f442}-\x{1f4fc}\x{1f4ff}-\x{1f53d}\x{1f54b}-\x{1f54e}\x{1f550}-\x{1f567}\x{1f57a}\x{1f595}-\x{1f596}\x{1f5a4}\x{1f5fb}-\x{1f64f}\x{1f680}-\x{1f6c5}\x{1f6cc}\x{1f6d0}-\x{1f6d2}\x{1f6d5}-\x{1f6d7}\x{1f6dc}-\x{1f6df}\x{1f6eb}-\x{1f6ec}\x{1f6f4}-\x{1f6fc}\x{1f7e0}-\x{1f7eb}\x{1f7f0}\x{1f90c}-\x{1f93a}\x{1f93c}-\x{1f945}\x{1f947}-\x{1f9ff}\x{1fa70}-\x{1fa7c}\x{1fa80}-\x{1fa88}\x{1fa90}-\x{1fabd}\x{1fabf}-\x{1fac5}\x{1face}-\x{1fadb}\x{1fae0}-\x{1fae8}\x{1faf0}-\x{1faf8}]|[\x{a9}\x{ae}\x{203c}\x{2049}\x{2122}\x{2139}\x{2194}-\x{2199}\x{21a9}-\x{21aa}\x{231a}-\x{231b}\x{2328}\x{2388}\x{23cf}\x{23e9}-\x{23f3}\x{23f8}-\x{23fa}\x{24c2}\x{25aa}-\x{25ab}\x{25b6}\x{25c0}\x{25fb}-\x{25fe}\x{2600}-\x{2605}\x{2607}-\x{2612}\x{2614}-\x{2685}\x{2690}-\x{2705}\x{2708}-\x{2712}\x{2714}\x{2716}\x{271d}\x{2721}\x{2728}\x{2733}-\x{2734}\x{2744}\x{2747}\x{274c}\x{274e}\x{2753}-\x{2755}\x{2757}\x{2763}-\x{2767}\x{2795}-\x{2797}\x{27a1}\x{27b0}\x{27bf}\x{2934}-\x{2935}\x{2b05}-\x{2b07}\x{2b1b}-\x{2b1c}\x{2b50}\x{2b55}\x{3030}\x{303d}\x{3297}\x{3299}\x{1f000}-\x{1f0ff}\x{1f10d}-\x{1f10f}\x{1f12f}\x{1f16c}-\x{1f171}\x{1f17e}-\x{1f17f}\x{1f18e}\x{1f191}-\x{1f19a}\x{1f1ad}-\x{1f1e5}\x{1f201}-\x{1f20f}\x{1f21a}\x{1f22f}\x{1f232}-\x{1f23a}\x{1f23c}-\x{1f23f}\x{1f249}-\x{1f3fa}\x{1f400}-\x{1f53d}\x{1f546}-\x{1f64f}\x{1f680}-\x{1f6ff}\x{1f774}-\x{1f77f}\x{1f7d5}-\x{1f7ff}\x{1f80c}-\x{1f80f}\x{1f848}-\x{1f84f}\x{1f85a}-\x{1f85f}\x{1f888}-\x{1f88f}\x{1f8ae}-\x{1f8ff}\x{1f90c}-\x{1f93a}\x{1f93c}-\x{1f945}\x{1f947}-\x{1faff}\x{1fc00}-\x{1fffd}]\x{fe0f}|[#*0-9]\x{fe0f}?\x{20e3}`;

const isString = (field: string): Stage => ({ $eq: [{ $type: field }, 'string'] });
const countIf = (condition: unknown): Stage => ({ $sum: { $cond: [condition, 1, 0] } });
const daysIf = (condition: unknown): Stage => ({
  $addToSet: { $cond: [condition, '$day', null] },
});
const daysCount = (field: string): Stage => ({ $size: { $setDifference: [field, [null]] } });

/** One indexed scan, with only bounded member and pair summaries crossing the connection. */
export const gayStatsPipeline = (query: GayStatsQuery, userIds: readonly string[]): Stage[] => {
  const [a, b] = userIds;
  const replyKnown = { $or: [{ $ne: ['$type', 19] }, isString('$reference.authorId')] };
  const mentioned = (recipient: string | undefined): Stage => ({
    $and: [
      {
        $in: [recipient ?? '', { $cond: [{ $isArray: '$mentions.users' }, '$mentions.users', []] }],
      },
      {
        $or: [
          { $ne: ['$type', 19] },
          { $ne: [{ $ifNull: ['$reference.authorId', ''] }, recipient ?? ''] },
        ],
      },
    ],
  });
  return [
    {
      $match: {
        channelId: { $in: [...query.channelIds] },
        createdTimestamp: { $gte: query.window.startMs, $lt: query.window.endMs },
        'author.id': { $in: [...userIds] },
        'author.bot': { $ne: true },
        webhookId: { $in: [null, ''] },
        deletedAt: { $exists: false },
        type: { $in: [0, 19] },
      },
    },
    {
      $project: {
        _id: 0,
        userId: '$author.id',
        channelId: 1,
        day: {
          $dateToString: {
            date: { $toDate: '$createdTimestamp' },
            format: '%Y-%m-%d',
            timezone: query.timeZone,
          },
        },
        contentKnown: isString('$content'),
        emoji: {
          $regexMatch: {
            input: { $cond: [isString('$content'), '$content', ''] },
            regex: EMOJI_PATTERN,
          },
        },
        replyKnown,
        mentionKnown: { $and: [{ $isArray: '$mentions.users' }, replyKnown] },
        reply: {
          $and: [
            { $eq: ['$type', 19] },
            {
              $eq: ['$reference.authorId', { $cond: [{ $eq: ['$author.id', a] }, b ?? '', a] }],
            },
          ],
        },
        mention: { $cond: [{ $eq: ['$author.id', a] }, mentioned(b), mentioned(a)] },
      },
    },
    {
      $facet: {
        members: [
          {
            $group: {
              _id: '$userId',
              messages: { $sum: 1 },
              activeDays: { $addToSet: '$day' },
              contentKnown: countIf('$contentKnown'),
              emojiMessages: countIf('$emoji'),
              replyKnown: countIf('$replyKnown'),
              mentionKnown: countIf('$mentionKnown'),
              replyDays: daysIf('$reply'),
              mentionDays: daysIf('$mention'),
            },
          },
          {
            $project: {
              _id: 0,
              userId: '$_id',
              messages: 1,
              activeDays: { $size: '$activeDays' },
              emojiRatio: {
                $cond: [
                  { $eq: ['$contentKnown', '$messages'] },
                  { $divide: ['$emojiMessages', '$messages'] },
                  '$$REMOVE',
                ],
              },
              replyDays: {
                $cond: [{ $eq: ['$replyKnown', '$messages'] }, daysCount('$replyDays'), '$$REMOVE'],
              },
              mentionDays: {
                $cond: [
                  { $eq: ['$mentionKnown', '$messages'] },
                  daysCount('$mentionDays'),
                  '$$REMOVE',
                ],
              },
            },
          },
          { $sort: { userId: 1 } },
        ],
        shared: [
          {
            $group: {
              _id: { day: '$day', channelId: '$channelId' },
              users: { $addToSet: '$userId' },
            },
          },
          { $match: { $expr: { $eq: [{ $size: '$users' }, 2] } } },
          { $group: { _id: '$_id.day' } },
          { $count: 'days' },
        ],
      },
    },
  ];
};
