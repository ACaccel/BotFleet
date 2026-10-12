/**
 * The `/traffic` reply: one embed with the report title and the landscape
 * dashboard image. Overview and channel reports put the top messages in the
 * embed text, where their jump links stay clickable and their previews
 * selectable; Discord draws the image under that text.
 */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

import type { TrafficOutcome } from './run';

const DASHBOARD_FILE = 'traffic-dashboard.png';
const EMBED_COLOR = 0x3987e5;
const TITLE_LIMIT = 256;

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export interface DashboardReply {
  readonly title: string;
  readonly image: Buffer;
  /** Embed text above the image, e.g. the top messages. */
  readonly description?: string;
}

export const dashboardReply = (reply: DashboardReply): TrafficOutcome => {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(clip(reply.title, TITLE_LIMIT))
    .setImage(`attachment://${DASHBOARD_FILE}`);
  if (reply.description !== undefined && reply.description.length > 0)
    embed.setDescription(reply.description);
  return {
    kind: 'reply',
    embeds: [embed],
    files: [new AttachmentBuilder(reply.image, { name: DASHBOARD_FILE })],
  };
};
