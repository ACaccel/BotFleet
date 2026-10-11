/**
 * The style-B reply: one embed carrying a title, a one-line selectable summary,
 * the data-limit notes as its footer, and the dashboard image attached to it.
 * Overview and channel reports add a second embed for the top messages.
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
  readonly summary: string;
  readonly notes: readonly string[];
  readonly image: Buffer;
  /** Embeds after the dashboard, e.g. the top messages. */
  readonly extra?: readonly EmbedBuilder[];
}

export const dashboardReply = (reply: DashboardReply): TrafficOutcome => {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(clip(reply.title, TITLE_LIMIT))
    .setDescription(reply.summary)
    .setImage(`attachment://${DASHBOARD_FILE}`);
  const notes = reply.notes.filter((note) => note.length > 0);
  if (notes.length > 0) embed.setFooter({ text: notes.join('\n') });
  return {
    kind: 'reply',
    embeds: [embed, ...(reply.extra ?? [])],
    files: [new AttachmentBuilder(reply.image, { name: DASHBOARD_FILE })],
  };
};

/** A secondary embed in the dashboard's colour. */
export const secondaryEmbed = (title: string, description: string): EmbedBuilder =>
  new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(clip(title, TITLE_LIMIT))
    .setDescription(description);
