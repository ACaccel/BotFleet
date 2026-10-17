import { decodeEntities } from '../../link-preview/og-client';
import type { FeedPost, FeedPostMedia } from '../types';
import type { BahamutTarget } from './bahamut-target';

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match === null ? undefined : decodeEntities(match[1] ?? match[2] ?? '');
};

const hasClass = (tag: string, name: string): boolean =>
  attribute(tag, 'class')?.split(/\s+/).includes(name) === true;

/** Walk balanced divs so nested editor markup never truncates a floor. */
const contentOf = (article: string): string | undefined => {
  const tags = /<\/?div\b[^>]*>/gi;
  let start: number | undefined;
  let depth = 0;
  for (const match of article.matchAll(tags)) {
    const tag = match[0];
    if (start === undefined) {
      if (!hasClass(tag, 'c-article__content')) continue;
      start = (match.index ?? 0) + tag.length;
      depth = 1;
    } else {
      depth += /^<\//.test(tag) ? -1 : 1;
      if (depth === 0) return article.slice(start, match.index);
    }
  }
  return undefined;
};

const plainText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(?:br|\/?(?:div|p|li|tr))\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();

const mediaOf = (html: string): readonly FeedPostMedia[] => {
  const media: FeedPostMedia[] = [];
  for (const match of html.matchAll(/<(img|video)\b[^>]*>/gi)) {
    const raw = attribute(match[0], 'data-src') ?? attribute(match[0], 'src');
    if (raw === undefined) continue;
    try {
      const url = new URL(raw, 'https://forum.gamer.com.tw');
      if (url.protocol !== 'https:') continue;
      media.push({ kind: match[1]?.toLowerCase() === 'video' ? 'video' : 'photo', url: url.href });
    } catch {
      // An unusable attachment must not hide the floor's text.
    }
  }
  return media;
};

interface BahamutFloor extends FeedPost {
  readonly floorNumber?: number;
}

export interface BahamutPage {
  readonly posts: readonly BahamutFloor[];
  readonly deletedFloors: readonly { readonly id: string; readonly floorNumber: number }[];
  readonly lastPage: number;
}

const pageCount = (html: string): number => {
  let lastPage = 1;
  for (const pager of html.matchAll(
    /<p\b[^>]*class=["'][^"']*BH-pagebtnA[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi,
  )) {
    for (const page of (pager[1] ?? '').matchAll(
      /(?:[?&](?:amp;)?page=(\d+)|class=["']pagenow["']>(\d+))/g,
    )) {
      lastPage = Math.max(lastPage, Number(page[1] ?? page[2]));
    }
  }
  if (!Number.isSafeInteger(lastPage) || lastPage > 100_000) throw new Error('Invalid page count');

  return lastPage;
};

/** Parse only floor bodies; comments and signatures are outside the article boundary. */
export const parseBahamutPage = (html: string, account: string): BahamutPage => {
  const lastPage = pageCount(html);
  const posts: BahamutFloor[] = [];
  for (const section of html.matchAll(
    /<section\b[^>]*\bid=["']post_(\d+)["'][^>]*>([\s\S]*?)<\/section>/gi,
  )) {
    const sn = section[1];
    const body = section[2] ?? '';
    const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1];
    const content = article === undefined ? undefined : contentOf(article);
    const authorTag = [...body.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)].find((m) =>
      hasClass(m[0], 'userid'),
    );
    const dateTag = [...body.matchAll(/<a\b[^>]*>/gi)].find((m) => hasClass(m[0], 'edittime'));
    const floorTag = [...body.matchAll(/<(?:a|div)\b[^>]*>/gi)].find((m) =>
      hasClass(m[0], 'floor'),
    );
    const floorRaw = floorTag === undefined ? undefined : attribute(floorTag[0], 'data-floor');
    const floorNumber =
      floorRaw !== undefined && /^\d+$/.test(floorRaw) ? Number(floorRaw) : undefined;
    const created = dateTag === undefined ? undefined : attribute(dateTag[0], 'data-mtime');
    const timestamp =
      created === undefined || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created)
        ? NaN
        : Date.parse(`${created.replace(' ', 'T')}+08:00`) / 1000;
    if (
      sn === undefined ||
      content === undefined ||
      authorTag === undefined ||
      !Number.isFinite(timestamp)
    ) {
      throw new Error('Unrecognized Bahamut floor');
    }
    const [board] = account.split('/');
    posts.push({
      id: `${timestamp}:${sn}`,
      authorAccount: plainText(authorTag[1] ?? ''),
      createdTimestamp: timestamp,
      url: `https://forum.gamer.com.tw/Co.php?bsn=${board}&sn=${sn}`,
      text: plainText(content),
      isReply: floorNumber !== 1,
      isRepost: false,
      media: mediaOf(content),
      ...(floorNumber === undefined ? {} : { floorNumber }),
    });
  }
  const deletedFloors: { id: string; floorNumber: number }[] = [];
  for (const section of html.matchAll(
    /<section\b[^>]*\bid=["']disable_(\d+)["'][^>]*>([\s\S]*?)<\/section>/gi,
  )) {
    const body = section[2] ?? '';
    const floor = /\bdata-floor=["']([1-9]\d*)["']/i.exec(body)?.[1];
    if (
      section[1] !== undefined &&
      floor !== undefined &&
      /class=["'][^"']*\bc-disable\b/i.test(body)
    ) {
      deletedFloors.push({ id: section[1], floorNumber: Number(floor) });
    }
  }
  if (posts.length === 0 && deletedFloors.length === 0)
    throw new Error('No recognizable Bahamut floors');
  return { posts, deletedFloors, lastPage };
};

export interface BahamutTopic {
  readonly id: string;
  readonly title: string;
  readonly sticky: boolean;
}

export interface BahamutBoardPage {
  readonly topics: readonly BahamutTopic[];
  readonly lastPage: number;
}

/** The creation-order cookie is verified so bumped threads never masquerade as new topics. */
export const parseBahamutBoardPage = (
  html: string,
  target: Extract<BahamutTarget, { kind: 'board' }>,
): BahamutBoardPage => {
  if (!/<table\b[^>]*class=["'][^"']*\bb-list\b/i.test(html)) throw new Error('Missing board list');
  const order = [...html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)].find((m) =>
    /Forum\.B\.orderBy/.test(m[0]),
  );
  const selected =
    order === undefined
      ? undefined
      : [...(order[1] ?? '').matchAll(/<option\b[^>]*>/gi)].find((m) =>
          /\bselected(?:\s|=|>)/i.test(m[0]),
        );
  if (selected === undefined || attribute(selected[0], 'value') !== '2')
    throw new Error('Board is not ordered by thread creation');
  const topics = new Map<string, BahamutTopic>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tag = /^<tr\b[^>]*>/i.exec(row[0])?.[0] ?? '';
    if (!hasClass(tag, 'b-list__row')) continue;
    const title = [...row[0].matchAll(/<(a|p)\b[^>]*>/gi)].find((m) =>
      hasClass(m[0], 'b-list__main__title'),
    );
    if (title === undefined) continue;
    const href = attribute(title[0], 'href');
    if (href === undefined) throw new Error('Topic is missing its permalink');
    const url = new URL(href, 'https://forum.gamer.com.tw');
    if (
      url.hostname !== 'forum.gamer.com.tw' ||
      url.pathname !== '/C.php' ||
      url.searchParams.get('bsn') !== target.board
    )
      continue;
    const id = url.searchParams.get('snA');
    if (id === null || !/^[1-9]\d{0,9}$/.test(id)) throw new Error('Invalid topic ID');
    if (target.subboard !== undefined) {
      const category = /\bdata-subbsn=["'](\d+)["']/i.exec(row[0])?.[1];
      if (category !== undefined && category !== target.subboard) continue;
    }
    const titleStart = (title.index ?? 0) + title[0].length;
    const titleEnd = row[0].indexOf(`</${title[1]}`, titleStart);
    if (titleEnd < 0) throw new Error('Unterminated topic title');
    topics.set(id, {
      id,
      title: plainText(row[0].slice(titleStart, titleEnd)),
      sticky: hasClass(tag, 'b-list__row--sticky'),
    });
  }
  return { topics: [...topics.values()], lastPage: pageCount(html) };
};

export { attribute as readBahamutAttribute };
