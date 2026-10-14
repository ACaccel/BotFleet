/** Size limits and text helpers for `/db` replies. */
import type { AttachmentBuilder, EmbedBuilder, InteractionEditReplyOptions } from 'discord.js';

export const EMBED_DESCRIPTION_LIMIT = 4096;
/** JSON longer than this goes into an attachment instead of the embed. */
export const INLINE_JSON_LIMIT = 3800;
export const FIELD_VALUE_LIMIT = 1024;
export const SUMMARY_PART_LIMIT = 60;
export const MENU_TEXT_LIMIT = 100;

export type DbReply = InteractionEditReplyOptions & { files: AttachmentBuilder[] };

export const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

/** Keep stored text from closing the code block it is shown in. */
export const codeBlock = (language: string, text: string): string =>
  `\`\`\`${language}\n${text.replace(/```/g, '`​``')}\n\`\`\``;

/** An attachment name built from stored values, limited to safe characters. */
export const safeFileName = (extension: string, ...parts: readonly string[]): string =>
  `${parts
    .join('-')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 80)}.${extension}`;

export const formatCount = (count: number): string => count.toLocaleString('en-US');

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit] ?? 'B'}`;
};

/** Fit lines into one embed text, dropping the tail; an over-long first line is cut. */
export const joinLines = (lines: readonly string[], limit = EMBED_DESCRIPTION_LIMIT): string => {
  let text = '';
  for (const line of lines) {
    const next = text.length === 0 ? line : `${text}\n${line}`;
    if (next.length > limit) return text.length === 0 ? truncate(line, limit) : text;
    text = next;
  }
  return text;
};

/** An ephemeral-safe reply that mentions nobody and clears earlier content. */
export const dbReply = (embeds: EmbedBuilder[], extra: Partial<DbReply> = {}): DbReply => ({
  content: '',
  embeds,
  components: [],
  files: [],
  allowedMentions: { parse: [] },
  ...extra,
});
