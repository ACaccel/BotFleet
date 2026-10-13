/**
 * `/traffic emoji`: use of the guild's current custom emoji, matched by ID so a
 * renamed emoji keeps its count. Counts cover every channel by design and the
 * reply shows no channel information. Text uses count each `<:name:id>`
 * occurrence; reaction uses are the last observed counts, super reactions
 * included.
 */

import { tCount } from './activity-common';
import {
  EMOJI_RANK_LIMIT,
  formatCount,
  renderEmojiDashboard,
  type EmojiRankRow,
} from './dashboard';
import { customEmojiLabel, customEmojiUrl } from './emoji-art';
import { rangeLabel } from './labels';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';
import { countTile, rankUsage, UNUSED_ART_LIMIT, type UsageOrder } from './usage-ranking';

const K = 'replies:traffic';

export type EmojiKind = 'all' | 'static' | 'animated';
export type EmojiSource = 'all' | 'message' | 'reaction';
export const EMOJI_KINDS: readonly EmojiKind[] = ['all', 'static', 'animated'];
export const EMOJI_SOURCES: readonly EmojiSource[] = ['all', 'message', 'reaction'];

export interface EmojiFilters {
  readonly order: UsageOrder;
  readonly kind: EmojiKind;
  readonly source: EmojiSource;
}

interface EmojiCount {
  readonly id: string;
  readonly label: string;
  readonly animated: boolean;
  readonly inContent: number;
  readonly inReactions: number;
}

const sum = (rows: readonly EmojiCount[], pick: (row: EmojiCount) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);

export const buildEmojiReport = async (
  context: TrafficContext,
  filters: EmojiFilters,
): Promise<TrafficOutcome> => {
  const { t, period, options } = context;
  const emojis = [...context.guild.emojis.cache.values()].filter(
    (emoji) => filters.kind === 'all' || emoji.animated === (filters.kind === 'animated'),
  );
  if (emojis.length === 0) return { kind: 'notice', key: `${K}.emoji_none` };
  const result = await context.repos.archiveStats.emojiUsage(
    period.window,
    emojis.map((emoji) => emoji.id),
  );
  if (!result.ok) return failed(result.error);
  const usage = result.value;
  const counts = new Map(usage.map((row) => [row.emojiId, row]));
  const rows: EmojiCount[] = emojis.map((emoji) => ({
    id: emoji.id,
    label: customEmojiLabel(emoji.name ?? undefined),
    animated: emoji.animated === true,
    inContent: filters.source === 'reaction' ? 0 : (counts.get(emoji.id)?.messageUses ?? 0),
    inReactions: filters.source === 'message' ? 0 : (counts.get(emoji.id)?.reactionUses ?? 0),
  }));
  const total = (row: EmojiCount): number => row.inContent + row.inReactions;
  const ranked = rankUsage(rows, total, (row) => row.label, filters.order);
  const shown = ranked.used.slice(0, Math.min(options.topN, EMOJI_RANK_LIMIT));
  const rest = ranked.used.slice(shown.length);
  const [rankRows, unusedItems] = await Promise.all([
    Promise.all(
      shown.map(
        async (row): Promise<EmojiRankRow> => ({
          label: row.label,
          image: await context.images.load(customEmojiUrl(row.id)),
          animated: row.animated,
          inContent: row.inContent,
          inReactions: row.inReactions,
        }),
      ),
    ),
    Promise.all(
      ranked.unused.slice(0, UNUSED_ART_LIMIT).map(async (row) => ({
        label: row.label,
        image: await context.images.load(customEmojiUrl(row.id)),
      })),
    ),
  ]);
  const uses = sum(rows, total);
  const image = renderEmojiDashboard({
    tiles: [
      countTile(t, t(`${K}.emoji.server`), `${K}.unit_items`, rows.length),
      countTile(t, t(`${K}.emoji.total`), `${K}.unit_uses`, uses),
      { label: t(`${K}.emoji.content`), value: formatCount(sum(rows, (row) => row.inContent)) },
      { label: t(`${K}.emoji.reactions`), value: formatCount(sum(rows, (row) => row.inReactions)) },
      countTile(t, t(`${K}.zero_uses`), `${K}.unit_items`, ranked.unused.length),
    ],
    ranking: {
      title: t(`${K}.emoji.ranking_title`, { n: shown.length }),
      contentLabel: t(`${K}.emoji.content`),
      reactionLabel: t(`${K}.emoji.reactions`),
      animatedTag: t(`${K}.emoji.animated_tag`),
      rows: rankRows,
      ...(rest.length === 0
        ? {}
        : {
            note: tCount(t, `${K}.emoji.rest`, rest.length, {
              uses: formatCount(sum(rest, total)),
              content: formatCount(sum(rest, (row) => row.inContent)),
              reactions: formatCount(sum(rest, (row) => row.inReactions)),
            }),
          }),
    },
    unused: {
      title: t(`${K}.emoji.unused_title`),
      note: tCount(t, `${K}.unused_total`, ranked.unused.length),
      total: ranked.unused.length,
      items: unusedItems,
    },
  });
  return dashboardReply({
    title: t(`${K}.emoji.title`, {
      range: rangeLabel(t, period.range),
      order: t(`${K}.order.${filters.order}`),
    }),
    image,
  });
};
