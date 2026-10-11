/**
 * The interaction and content sections of the overview and channel dashboards:
 * reply ratio, reactions with the most used one drawn as its emoji, forwards,
 * edits, and the content types.
 */
import type {
  ActivitySummary,
  ReactionSummary,
} from '../../../persistence/repositories/archive-stats.types';

import { contentRows } from './activity-sections';
import {
  EMOJI_SLOT,
  formatCount,
  formatPercent,
  richFromTemplate,
  type BarRow,
  type KeyValueRow,
  type TitledRows,
} from './dashboard';
import { emojiToken } from './emoji-art';
import type { TrafficContext } from './run';
import type { TFn } from './types';

const K = 'replies:traffic';

export const serverInteractions = async (
  context: Pick<TrafficContext, 't' | 'images'>,
  summary: ActivitySummary,
  reactions: ReactionSummary,
): Promise<TitledRows<KeyValueRow>> => {
  const { t } = context;
  const rows: KeyValueRow[] = [
    {
      label: t(`${K}.interactions.reply_ratio`),
      value: formatPercent(summary.content.replies, summary.messages),
    },
    { label: t(`${K}.interactions.reactions`), value: formatCount(reactions.total) },
  ];
  const top = reactions.top[0];
  if (top !== undefined) {
    const token = await emojiToken(top, context.images);
    rows.push({
      label: richFromTemplate(t(`${K}.interactions.top_reaction`, { emoji: EMOJI_SLOT }), [token]),
      value: formatCount(top.count),
      secondary: true,
    });
  }
  rows.push(
    { label: t(`${K}.interactions.forwards`), value: formatCount(summary.content.forwards) },
    {
      label: t(`${K}.interactions.edited`),
      value: formatPercent(summary.edited, summary.messages, 1),
    },
  );
  return { title: t(`${K}.interactions.title`), rows };
};

export const contentSection = (
  t: TFn,
  summary: ActivitySummary,
  titleKey = `${K}.content.title`,
): TitledRows<BarRow> => ({ title: t(titleKey), rows: contentRows(t, summary.content) });
