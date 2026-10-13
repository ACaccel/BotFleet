/**
 * The `/traffic` reply: an embed with the report title and the dashboard
 * image, and for activity dashboards a second, untitled embed with the
 * details image. Overview and channel reports put the top messages in the
 * first embed's text, where their jump links stay clickable and their
 * previews selectable; Discord draws the image under that text.
 */
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

import type { TrafficOutcome } from './run';

const DASHBOARD_FILE = 'traffic-dashboard.png';
const DETAILS_FILE = 'traffic-details.png';
const TITLE_LIMIT = 256;

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export interface DashboardReply {
  readonly title: string;
  readonly image: Buffer;
  /** A second image, sent in its own embed under the first. */
  readonly details?: Buffer;
  /** Embed text above the image, e.g. the top messages. */
  readonly description?: string;
}

export const dashboardReply = (reply: DashboardReply): TrafficOutcome => {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(clip(reply.title, TITLE_LIMIT))
    .setImage(`attachment://${DASHBOARD_FILE}`);
  if (reply.description !== undefined && reply.description.length > 0)
    embed.setDescription(reply.description);
  const files = [new AttachmentBuilder(reply.image, { name: DASHBOARD_FILE })];
  if (reply.details === undefined) return { kind: 'reply', embeds: [embed], files };
  const details = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setImage(`attachment://${DETAILS_FILE}`);
  return {
    kind: 'reply',
    embeds: [embed, details],
    files: [...files, new AttachmentBuilder(reply.details, { name: DETAILS_FILE })],
  };
};
