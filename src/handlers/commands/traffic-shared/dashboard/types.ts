/**
 * Per-dashboard view models for the /traffic images. Callers aggregate the
 * data and translate every label; the renderers only lay it out.
 */
import type { Image } from 'canvas';

import type {
  BarRow,
  HeatmapSection,
  HeroTile,
  KeyValueRow,
  RankingColumn,
  SegmentedRankRow,
  StatTile,
  TitledRows,
  TrendSection,
  UnusedSection,
} from './types-common';

/** Sections shared by the overview, channel, and person dashboards. */
export interface ActivityDashboardBase {
  readonly hero: HeroTile;
  /** Rows of small tiles under the hero; each inner array is one row. */
  readonly tileRows: readonly (readonly StatTile[])[];
  readonly trend: TrendSection;
  readonly interactions: TitledRows<KeyValueRow>;
  readonly content: TitledRows<BarRow>;
  /** Omitted for the 24h range. */
  readonly heatmap?: HeatmapSection;
}

export interface OverviewDashboard extends ActivityDashboardBase {
  readonly members: RankingColumn;
  readonly channels: RankingColumn;
}

export interface ChannelDashboard extends ActivityDashboardBase {
  readonly members: RankingColumn;
  /**
   * The channel itself plus its threads, or, when there are no threads to
   * rank, another list (e.g. weekday averages with `ranked: false`) so the
   * two columns stay symmetric.
   */
  readonly breakdown: RankingColumn;
}

/** A conversation partner: reply and mention exchanges, as two segments in that order. */
export interface PartnerRankRow extends SegmentedRankRow {
  readonly segments: readonly [reply: number, mention: number];
}

export interface PersonDashboard extends ActivityDashboardBase {
  readonly partners: RankingColumn<PartnerRankRow>;
  readonly partnerLegend: readonly [reply: string, mention: string];
  readonly channels: RankingColumn;
}

export interface AppRow {
  readonly name: string;
  /** Preloaded application icon, or `null` for a coloured initial. */
  readonly icon: Image | null;
  /** Interaction counts per type, in `AppRanking.legend` order (at most three). */
  readonly segments: readonly number[];
  /** Right-aligned distinct-user caption, e.g. "88 users". */
  readonly users: string;
  /** Muted per-type breakdown line, e.g. "Commands 1,050 · Components 154". */
  readonly breakdown: string;
}

export interface AppRanking {
  readonly title: string;
  /** Interaction type names, one per segment colour (at most three). */
  readonly legend: readonly string[];
  /** Only the first `RANK_ROW_LIMIT` rows are drawn. */
  readonly rows: readonly AppRow[];
}

export interface AppsDashboard {
  readonly hero: HeroTile;
  readonly ranking: AppRanking;
  readonly trend: TrendSection;
  /** Laid out as two five-row columns. */
  readonly members: RankingColumn;
}

export interface AppSingleDashboard {
  readonly hero: HeroTile;
  /** Interaction types; row `i` takes segment colour `i` (at most three rows). */
  readonly types: TitledRows<BarRow>;
  readonly trend: TrendSection;
  readonly members: RankingColumn;
  readonly heatmap?: HeatmapSection;
}

export interface EmojiRankRow {
  /** The custom emoji's `:name:`, untranslated; its initials seed the placeholder art. */
  readonly label: string;
  readonly image: Image | null;
  readonly animated: boolean;
  readonly inContent: number;
  readonly inReactions: number;
}

export interface EmojiRanking {
  readonly title: string;
  readonly contentLabel: string;
  readonly reactionLabel: string;
  /** Chip text for animated emoji, e.g. `GIF`. */
  readonly animatedTag: string;
  /** Up to `EMOJI_RANK_LIMIT` rows, drawn as two columns. */
  readonly rows: readonly EmojiRankRow[];
  readonly note?: string;
}

export interface EmojiDashboard {
  readonly tiles: readonly StatTile[];
  readonly ranking: EmojiRanking;
  readonly unused?: UnusedSection;
}

export interface StickerRankRow {
  readonly name: string;
  readonly image: Image | null;
  readonly count: number;
}

export interface StickerRanking {
  readonly title: string;
  /** Denominator for each card's share percentage. */
  readonly totalUses: number;
  /**
   * Muted caption after a card's bold count, given the raw count (for
   * plural selection) and its formatted share, e.g. "uses · 22%".
   */
  readonly countCaption: (count: number, percent: string) => string;
  /** Up to `STICKER_RANK_LIMIT` cards. */
  readonly rows: readonly StickerRankRow[];
  readonly note?: string;
}

export interface StickerDashboard {
  readonly tiles: readonly StatTile[];
  readonly ranking: StickerRanking;
  readonly unused?: UnusedSection;
}
