/**
 * `/traffic sticker`: use of the guild's current stickers, matched by ID, over
 * every channel by design; the reply shows no channel information. Lottie
 * stickers cannot be drawn and show their placeholder art.
 */
import { StickerFormatType } from 'discord.js';

import { tCount } from './activity-common';
import { STICKER_RANK_LIMIT, formatCount, renderStickerDashboard } from './dashboard';
import { rangeLabel } from './labels';
import { dashboardReply } from './reply';
import { failed, type TrafficContext, type TrafficOutcome } from './run';
import { countTile, rankUsage, UNUSED_CHIP_LIMIT, type UsageOrder } from './usage-ranking';

const K = 'replies:traffic';

interface StickerCount {
  readonly name: string;
  readonly url: string | null;
  readonly uses: number;
}

export const buildStickerReport = async (
  context: TrafficContext,
  order: UsageOrder,
): Promise<TrafficOutcome> => {
  const { t, period, options } = context;
  const stickers = [...context.guild.stickers.cache.values()];
  if (stickers.length === 0) return { kind: 'notice', key: `${K}.sticker_none` };
  const result = await context.repos.archiveStats.stickerUsage(
    period.window,
    stickers.map((sticker) => sticker.id),
  );
  if (!result.ok) return failed(result.error);
  const usage = result.value;
  const counts = new Map(usage.map((row) => [row.stickerId, row.uses]));
  const rows: StickerCount[] = stickers.map((sticker) => ({
    name: sticker.name,
    url: sticker.format === StickerFormatType.Lottie ? null : sticker.url,
    uses: counts.get(sticker.id) ?? 0,
  }));
  const ranked = rankUsage(
    rows,
    (row) => row.uses,
    (row) => row.name,
    order,
  );
  const shown = ranked.used.slice(0, Math.min(options.topN, STICKER_RANK_LIMIT));
  const rest = ranked.used.slice(shown.length);
  const totalUses = rows.reduce((sum, row) => sum + row.uses, 0);
  const restUses = rest.reduce((sum, row) => sum + row.uses, 0);
  const cards = await Promise.all(
    shown.map(async (row) => ({
      name: row.name,
      image: row.url === null ? null : await context.images.load(row.url),
      count: row.uses,
    })),
  );
  const image = renderStickerDashboard({
    tiles: [
      countTile(t, t(`${K}.sticker.server`), `${K}.unit_items`, rows.length),
      countTile(t, t(`${K}.sticker.total`), `${K}.unit_uses`, totalUses),
      countTile(t, t(`${K}.zero_uses`), `${K}.unit_items`, ranked.unused.length),
    ],
    ranking: {
      title: t(`${K}.sticker.ranking_title`),
      totalUses,
      countCaption: (count, percent) => tCount(t, `${K}.sticker.count_caption`, count, { percent }),
      rows: cards,
      ...(rest.length === 0
        ? {}
        : { note: tCount(t, `${K}.sticker.rest`, rest.length, { uses: formatCount(restUses) }) }),
    },
    unused: {
      title: t(`${K}.sticker.unused_title`),
      note: tCount(t, `${K}.unused_total`, ranked.unused.length),
      names: ranked.unused.slice(0, UNUSED_CHIP_LIMIT).map((row) => row.name),
      zeroLabel: '0',
    },
  });
  return dashboardReply({
    title: t(`${K}.sticker.title`, {
      range: rangeLabel(t, period.range),
      order: t(`${K}.order.${order}`),
    }),
    image,
  });
};
