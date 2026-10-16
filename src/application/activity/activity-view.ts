/**
 * The announcement message of an activity: an embed showing its state
 * and participant list, and the buttons for its current status.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  time,
  TimestampStyles,
  type MessageEditOptions,
} from 'discord.js';

import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import type { BoundTranslate } from '../../core/i18n';

/** Button custom IDs; `buttons/activity` routes on the second segment. */
const ACTIVITY_BUTTON = {
  join: 'activity|join',
  leave: 'activity|leave',
  rollCall: 'activity|rollcall',
  close: 'activity|close',
} as const;

const FIELD_MAX = 1024;

/** The stored fields the announcement shows; a lean `ActivityDoc` satisfies it. */
export interface ActivityView {
  readonly title: string;
  readonly description?: string | null;
  readonly creator_id?: string | null;
  readonly role_id?: string | null;
  readonly capacity?: number | null;
  readonly starts_at?: number | null;
  readonly expired_at: number;
  readonly status?: string | null;
  readonly participants: readonly string[];
  readonly attendance?: readonly { readonly present: readonly string[]; readonly total: number }[];
}

const statusOf = (view: ActivityView): 'open' | 'closed' | 'cancelled' =>
  view.status === 'closed' || view.status === 'cancelled' ? view.status : 'open';

/** Mentions until the field is full, then a count of the rest. */
const participantList = (ids: readonly string[], t: BoundTranslate): string => {
  if (ids.length === 0) return t('replies:activity.none');
  const shown: string[] = [];
  for (const [index, id] of ids.entries()) {
    const line = shown.length === 0 ? `<@${id}>` : `${shown.join(' ')} <@${id}>`;
    const rest = t('replies:activity.and_more', { count: ids.length - index - 1 });
    if (line.length + rest.length + 1 > FIELD_MAX) {
      return `${shown.join(' ')} ${t('replies:activity.and_more', { count: ids.length - index })}`;
    }
    shown.push(`<@${id}>`);
  }
  return shown.join(' ');
};

const buttons = (status: 'open' | 'closed' | 'cancelled', t: BoundTranslate) => {
  if (status === 'cancelled') return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (status === 'open') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ACTIVITY_BUTTON.join)
        .setLabel(t('replies:activity.button_join'))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ACTIVITY_BUTTON.leave)
        .setLabel(t('replies:activity.button_leave'))
        .setStyle(ButtonStyle.Secondary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(ACTIVITY_BUTTON.rollCall)
      .setLabel(t('replies:activity.button_roll_call'))
      .setStyle(ButtonStyle.Primary),
  );
  if (status === 'open') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ACTIVITY_BUTTON.close)
        .setLabel(t('replies:activity.button_close'))
        .setStyle(ButtonStyle.Danger),
    );
  }
  return [row];
};

/** The full announcement for `view` in its current state. */
export const renderActivity = (
  view: ActivityView,
  t: BoundTranslate,
): Required<Pick<MessageEditOptions, 'embeds' | 'components'>> => {
  const status = statusOf(view);
  const count =
    typeof view.capacity === 'number'
      ? `${String(view.participants.length)} / ${String(view.capacity)}`
      : String(view.participants.length);
  const embed = new EmbedBuilder()
    .setTitle(t(`replies:activity.title_${status}`, { title: view.title }))
    .setColor(status === 'open' ? EMBED_COLORS.celebration : EMBED_COLORS.neutral)
    .setFooter({ text: t(`replies:activity.footer_${status}`) });
  if (view.description) embed.setDescription(view.description);
  if (typeof view.starts_at === 'number') {
    embed.addFields({
      name: t('replies:activity.field_start'),
      value: time(Math.floor(view.starts_at / 1000), TimestampStyles.LongDateTime),
      inline: true,
    });
  }
  embed.addFields(
    {
      name: t('replies:activity.field_deadline'),
      value:
        status === 'open'
          ? time(Math.floor(view.expired_at / 1000), TimestampStyles.RelativeTime)
          : t('replies:activity.deadline_passed'),
      inline: true,
    },
    { name: t('replies:activity.field_count'), value: count, inline: true },
  );
  if (view.role_id) {
    embed.addFields({ name: t('replies:activity.field_role'), value: `<@&${view.role_id}>` });
  }
  if (view.creator_id) {
    embed.addFields({ name: t('replies:activity.field_creator'), value: `<@${view.creator_id}>` });
  }
  embed.addFields({
    name: t('replies:activity.field_participants'),
    value: participantList(view.participants, t),
  });
  const latest = view.attendance?.at(-1);
  if (latest !== undefined) {
    embed.addFields({
      name: t('replies:activity.field_attendance'),
      value: `${String(latest.present.length)} / ${String(latest.total)}`,
    });
  }
  return { embeds: [embed], components: buttons(status, t) };
};
