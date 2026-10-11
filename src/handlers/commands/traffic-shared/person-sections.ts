/**
 * The member-specific sections of the person dashboard: reactions received and
 * given (each with its most used emoji), command use, the reply and mention
 * counts, content, and the most frequent conversation partners split into reply
 * and mention exchanges.
 */
import type { RemoteImageLoader } from '../../../infra/graphics/image-loader';
import type {
  ActivitySummary,
  ReactionSummary,
  ReactionsGivenStats,
  ReplyPartnersStats,
} from '../../../persistence/repositories/archive-stats.types';

import { tCount } from './activity-common';
import {
  EMOJI_SLOT,
  formatCount,
  richFromTemplate,
  type BarRow,
  type KeyValueRow,
  type PartnerRankRow,
  type RankingColumn,
  type StatTile,
  type TitledRows,
} from './dashboard';
import { emojiToken, type EmojiRef } from './emoji-art';
import { resolveUserNames } from './names';
import type { TrafficContext } from './run';
import { contentSection } from './server-sections';
import type { TFn } from './types';

const K = 'replies:traffic';

export interface PersonData {
  readonly summary: ActivitySummary;
  readonly reactions: ReactionSummary;
  readonly partners: ReplyPartnersStats;
  readonly given: ReactionsGivenStats;
  /** Interactions the member triggered that left a public reply. */
  readonly commandUses: number;
}

interface PersonSections {
  readonly reactionTiles: StatTile[];
  readonly interactions: TitledRows<KeyValueRow>;
  readonly content: TitledRows<BarRow>;
  readonly partners: RankingColumn<PartnerRankRow>;
}

const mostUsed = <T extends EmojiRef & { readonly count: number }>(
  rows: readonly T[],
): T | undefined =>
  rows.reduce<T | undefined>(
    (best, row) => (best === undefined || row.count > best.count ? row : best),
    undefined,
  );

const reactionTile = async (
  t: TFn,
  labelKey: string,
  subKey: string,
  total: number,
  rows: readonly (EmojiRef & { readonly count: number })[],
  loader: RemoteImageLoader,
): Promise<StatTile> => {
  const top = mostUsed(rows);
  const tile = { label: t(`${K}.${labelKey}`), value: formatCount(total) };
  if (top === undefined) return tile;
  const token = await emojiToken(top, loader);
  return {
    ...tile,
    sub: richFromTemplate(tCount(t, `${K}.${subKey}`, top.count, { emoji: EMOJI_SLOT }), [token]),
  };
};

export const personSections = async (
  context: TrafficContext,
  data: PersonData,
): Promise<PersonSections> => {
  const { t, images: loader } = context;
  const { totals } = data.partners;
  const partnerIds = data.partners.partners.map((partner) => partner.userId);
  const [received, given, names] = await Promise.all([
    reactionTile(
      t,
      'reactions_received',
      'reactions_received_top',
      data.reactions.total,
      data.reactions.top,
      loader,
    ),
    reactionTile(
      t,
      'reactions_given',
      'reactions_given_top',
      data.given.total,
      data.given.byEmoji,
      loader,
    ),
    resolveUserNames(context.guild, partnerIds, t(`${K}.unknown_member`)),
  ]);
  return {
    reactionTiles: [
      received,
      given,
      { label: t(`${K}.command_uses`), value: formatCount(data.commandUses) },
    ],
    interactions: {
      title: t(`${K}.interactions.title`),
      rows: [
        { label: t(`${K}.interactions.mentioned`), value: formatCount(totals.mentionsReceived) },
        { label: t(`${K}.interactions.replies_sent`), value: formatCount(totals.repliesSent) },
        {
          label: t(`${K}.interactions.replies_received`),
          value: formatCount(totals.repliesReceived),
        },
        { label: t(`${K}.interactions.edited`), value: formatCount(data.summary.edited) },
      ],
    },
    content: contentSection(t, data.summary, `${K}.content.title_person`),
    partners: {
      title: t(`${K}.partners_title`, { n: data.partners.partners.length }),
      rows: data.partners.partners.map((partner) => ({
        name: names.get(partner.userId) ?? t(`${K}.unknown_member`),
        segments: [
          partner.repliesTo + partner.repliesFrom,
          partner.mentionsTo + partner.mentionsFrom,
        ],
      })),
    },
  };
};
