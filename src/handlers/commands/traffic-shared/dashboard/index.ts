/**
 * Public surface of the /traffic dashboard renderers. Each function takes
 * an already-aggregated, already-translated view model and returns PNG
 * bytes: side-by-side columns of equal height, one image (the activity
 * dashboards return a summary and a details image). The renderers hold no database, Discord
 * client, or translator access. They throw when the canvas font is missing, and the
 * heatmap-bearing ones throw `RangeError` on a malformed heatmap grid.
 */
export { renderChannelDashboard, renderOverviewDashboard, renderPersonDashboard } from './activity';
export { renderAppSingleDashboard, renderAppsDashboard } from './apps';
export { EMOJI_RANK_LIMIT, renderEmojiDashboard } from './emoji';
export { EMOJI_SLOT, richFromTemplate } from './rich';
export { STICKER_RANK_LIMIT, renderStickerDashboard } from './sticker';
export { APP_RANK_LIMIT, RANK_ROW_LIMIT, formatCount, formatPercent } from './theme';
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
