/**
 * Public surface of the /traffic dashboard renderers. Each function takes
 * an already-aggregated, already-translated view model and returns the
 * PNG bytes of one landscape dashboard image: two or three columns of
 * equal height, at least as tall as a 16:9 canvas and taller only when a
 * column's content needs it. The renderers hold no database, Discord
 * client, or translator access. They throw when the canvas font is missing, and the
 * heatmap-bearing ones throw `RangeError` on a malformed heatmap grid.
 */
export { renderChannelDashboard, renderOverviewDashboard, renderPersonDashboard } from './activity';
export { renderAppSingleDashboard, renderAppsDashboard } from './apps';
export { EMOJI_RANK_LIMIT, renderEmojiDashboard } from './emoji';
export { EMOJI_SLOT, richFromTemplate } from './rich';
export { STICKER_RANK_LIMIT, renderStickerDashboard } from './sticker';
export { RANK_ROW_LIMIT, formatCount, formatPercent } from './theme';
export type {
  AppRow,
  AppSingleDashboard,
  AppsDashboard,
  ChannelDashboard,
  EmojiDashboard,
  EmojiRankRow,
  OverviewDashboard,
  PartnerRankRow,
  PersonDashboard,
  StickerDashboard,
} from './types';
export type {
  BarRow,
  Delta,
  EmojiToken,
  HeatmapSection,
  HeroMetric,
  HeroTile,
  InlinePart,
  KeyValueRow,
  RankingColumn,
  RankRow,
  StatTile,
  TitledRows,
  TrendSection,
} from './types-common';
