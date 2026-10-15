/** Renders a relayed notification as one Discord embed. */
import type { APIEmbed } from 'discord.js';

import type { Translator } from '../../../core/i18n';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import type { Notification, NotificationStatus, StageState } from './request';

/** Discord's embed description limit. */
const DESCRIPTION_LIMIT = 4096;

const STAGE_MARKS: Readonly<Record<StageState, string>> = {
  pending: '○',
  running: '●',
  done: '✓',
  failed: '✗',
  skipped: '–',
};

const STATUS_COLORS: Readonly<Record<NotificationStatus, number>> = {
  running: EMBED_COLORS.info,
  succeeded: EMBED_COLORS.success,
  failed: EMBED_COLORS.error,
  cancelled: EMBED_COLORS.neutral,
};

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * The request schema already bounds every part within Discord's limits; the
 * description is truncated anyway because it joins two caller inputs.
 */
export const renderNotification = (
  notification: Notification,
  translator: Pick<Translator, 't'>,
  timestamp: Date,
): APIEmbed => {
  const stageLines = notification.stages.map(
    (stage) => `${STAGE_MARKS[stage.state]} ${stage.label}`,
  );
  const description = [notification.description ?? '', stageLines.join('\n')]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const fields = [
    {
      name: translator.t('replies:notification_relay.status_field'),
      value: translator.t(`replies:notification_relay.status.${notification.status}`),
    },
  ];
  if (notification.summary !== undefined && notification.summary.length > 0) {
    fields.push({
      name: translator.t('replies:notification_relay.summary_field'),
      value: notification.summary,
    });
  }
  return {
    title: notification.title,
    ...(notification.url === undefined ? {} : { url: notification.url }),
    ...(description.length === 0 ? {} : { description: truncate(description, DESCRIPTION_LIMIT) }),
    color: STATUS_COLORS[notification.status],
    fields,
    timestamp: timestamp.toISOString(),
  };
};
