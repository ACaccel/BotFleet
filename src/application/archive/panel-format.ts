import { escapeMarkdown } from 'discord.js';
import type { Translator } from '../../core/i18n';
import type { ArchiveGapReason } from '../../core/archive/progress';
import { EMBED_COLORS } from '../../infra/discord/presentation-colors';

/** The translation function the panels need. */
export type ArchiveText = Pick<Translator, 't'>;

/** Shared formatting for the `/archive` panels. */
export const archiveNumber = (value: number): string => Math.round(value).toLocaleString('en-US');

/** A pluralized count: `count` selects the form, `number` is the grouped digits. */
export const archiveCount = (t: ArchiveText, key: string, count: number): string =>
  t.t(`replies:archive.${key}`, { count, number: archiveNumber(count) });

/** Discord renders the timestamp in each reader's own locale and time zone. */
export const archiveTime = (ms: number, style: 'f' | 'T' | 'R' | 'd' = 'f'): string =>
  `<t:${Math.floor(ms / 1000)}:${style}>`;

export const archiveDuration = (t: ArchiveText, ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return t.t('replies:archive.duration_days', { days, hours: hours % 24 });
  if (hours > 0) return t.t('replies:archive.duration_hours', { hours, minutes: minutes % 60 });
  if (minutes > 0) return t.t('replies:archive.duration_minutes', { minutes });
  return t.t('replies:archive.duration_under_minute');
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const unitOf = (bytes: number): number => {
  let unit = 0;
  for (let value = Math.max(0, bytes); value >= 1000 && unit < UNITS.length - 1; value /= 1000)
    unit += 1;
  return unit;
};
/** Up to one decimal, without a trailing `.0`. */
const scaled = (bytes: number, unit: number): string =>
  String(Number((Math.max(0, bytes) / 1000 ** unit).toFixed(unit === 0 ? 0 : 1)));

export const archiveBytes = (bytes: number): string => {
  const unit = unitOf(bytes);
  return `${scaled(bytes, unit)} ${UNITS[unit]}`;
};

/** `42.1 / 100 GB`: both values in the larger value's unit. */
export const archiveBytesOf = (used: number, total: number): string => {
  const unit = unitOf(Math.max(used, total));
  return `${scaled(used, unit)} / ${scaled(total, unit)} ${UNITS[unit]}`;
};

/** Channel names are shown escaped and without mentions. */
export const archiveChannelName = (t: ArchiveText, name: string | undefined): string =>
  name === undefined || name.length === 0
    ? t.t('replies:archive.channel_unnamed')
    : `#${escapeMarkdown(name)}`;

const REASON_KEYS: Readonly<Record<ArchiveGapReason, string>> = {
  permission: 'replies:archive.reason_permission',
  discovery: 'replies:archive.reason_discovery',
  capacity: 'replies:archive.reason_capacity',
  conflict: 'replies:archive.reason_conflict',
  other: 'replies:archive.reason_unexpected',
};
export const archiveReason = (t: ArchiveText, reason: ArchiveGapReason | undefined): string =>
  t.t(REASON_KEYS[reason ?? 'other']);

export const ARCHIVE_COLORS = {
  running: EMBED_COLORS.info,
  complete: EMBED_COLORS.success,
  gaps: EMBED_COLORS.warning,
  stopped: EMBED_COLORS.neutral,
  failed: EMBED_COLORS.error,
} as const;
