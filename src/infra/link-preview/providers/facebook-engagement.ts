import type { PreviewCard } from '../types';

type Engagement = NonNullable<PreviewCard['engagement']>;

const parseCount = (value: string): number | string | undefined => {
  if (value.length > 32) return undefined;
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?[KMBT]$/i.test(value)) return value;
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) return undefined;
  const count = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(count) ? count : undefined;
};

/** Facebed carries a reaction summary in og:site_name, separate from post text. */
export const parseFacebookEngagement = (siteName: string | undefined): Engagement | undefined => {
  if (siteName === undefined || !siteName.startsWith('facebed by ') || siteName.length > 4096) {
    return undefined;
  }
  const engagement: {
    likes?: number | string;
    comments?: number | string;
    shares?: number | string;
  } = {};
  for (const line of siteName.split(/\r?\n/)) {
    for (const cell of line.split(/[•·]/)) {
      const value = cell.replace(/[\s\uFE0F]/gu, '');
      const reactions = /^(?:👍|❤|🤗|😂|😮|😢|😡)+(.+)$/u.exec(value);
      const comments = /^💬(.+)$/u.exec(value);
      const shares = /^(?:🔁|🔄)(.+)$/u.exec(value);
      const key =
        reactions !== null
          ? 'likes'
          : comments !== null
            ? 'comments'
            : shares !== null
              ? 'shares'
              : undefined;
      const raw = reactions?.[1] ?? comments?.[1] ?? shares?.[1];
      if (key === undefined || raw === undefined || engagement[key] !== undefined) continue;
      const count = parseCount(raw);
      if (count !== undefined) engagement[key] = count;
    }
  }
  return Object.keys(engagement).length > 0 ? engagement : undefined;
};
