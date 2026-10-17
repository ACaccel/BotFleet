import type { FeedPost } from '../types';
import { YOUTUBE_CHANNEL_ID } from './youtube-target';
import { parseYouTubeXml, type YouTubeXmlNode } from './youtube-xml';

const ATOM = 'http://www.w3.org/2005/Atom';
const YOUTUBE = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA = 'http://search.yahoo.com/mrss/';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeFeedPost extends FeedPost {
  readonly youtube: {
    readonly title: string;
    readonly description: string;
    readonly authorName: string;
    readonly thumbnailUrl?: string;
  };
}

const children = (node: YouTubeXmlNode, namespace: string, name: string): YouTubeXmlNode[] =>
  node.children.filter((child) => child.namespace === namespace && child.name === name);

const one = (
  node: YouTubeXmlNode,
  namespace: string,
  name: string,
  required = true,
): YouTubeXmlNode | undefined => {
  const matches = children(node, namespace, name);
  if (matches.length > 1 || (required && matches.length !== 1))
    throw new Error(`Missing or duplicate ${name}`);
  return matches[0];
};

const text = (node: YouTubeXmlNode | undefined, allowEmpty = false): string => {
  if (node === undefined) return '';
  if (node.children.length > 0 || (!allowEmpty && node.text.trim() === ''))
    throw new Error('Invalid Atom text element');
  return node.text.trim();
};

const publishedTimestamp = (value: string): number => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) throw new Error('Invalid Atom publication time');
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))
  )
    throw new Error('Invalid Atom publication time');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < 0)
    throw new Error('Invalid Atom publication time');
  return Math.floor(timestamp / 1000);
};

const thumbnailUrl = (node: YouTubeXmlNode | undefined, videoId: string): string | undefined => {
  if (node === undefined) return undefined;
  const url = new URL(node.attributes.get('url') ?? '');
  if (
    url.protocol !== 'https:' ||
    ![
      'i.ytimg.com',
      'i1.ytimg.com',
      'i2.ytimg.com',
      'i3.ytimg.com',
      'i4.ytimg.com',
      'img.youtube.com',
    ].includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !new RegExp(`^/(?:vi|vi_webp)/${videoId}/[A-Za-z0-9_-]+\\.(?:jpg|webp)$`).test(url.pathname)
  )
    throw new Error('Invalid YouTube thumbnail');
  return url.href;
};

/** Parse the complete snapshot before returning any entries, including entries callers may filter. */
export const parseYouTubeAtom = (body: string, channelId: string): readonly YouTubeFeedPost[] => {
  if (!YOUTUBE_CHANNEL_ID.test(channelId)) throw new Error('Invalid requested channel ID');
  const feed = parseYouTubeXml(body);
  if (feed.namespace !== ATOM || feed.name !== 'feed' || feed.text.trim() !== '')
    throw new Error('Expected an Atom feed');
  const feedChannel = text(one(feed, YOUTUBE, 'channelId'));
  // The public feed currently omits UC at feed level but retains it on every entry.
  if (
    ![channelId, channelId.slice(2)].includes(feedChannel) ||
    text(one(feed, ATOM, 'id')) !== `yt:channel:${feedChannel}`
  )
    throw new Error('Mismatched YouTube feed identity');
  text(one(feed, ATOM, 'title'));
  if (feed.children.some((node) => node.name === 'entry' && node.namespace !== ATOM))
    throw new Error('Invalid Atom entry namespace');
  const ids = new Set<string>();
  return children(feed, ATOM, 'entry').map((entry): YouTubeFeedPost => {
    if (entry.text.trim() !== '') throw new Error('Invalid Atom entry text');
    const id = text(one(entry, YOUTUBE, 'videoId'));
    if (
      !VIDEO_ID.test(id) ||
      text(one(entry, ATOM, 'id')) !== `yt:video:${id}` ||
      text(one(entry, YOUTUBE, 'channelId')) !== channelId ||
      ids.has(id)
    )
      throw new Error('Invalid or duplicate YouTube video identity');
    ids.add(id);
    const title = text(one(entry, ATOM, 'title'));
    const published = publishedTimestamp(text(one(entry, ATOM, 'published')));
    const author = one(entry, ATOM, 'author')!;
    const authorName = text(one(author, ATOM, 'name'));
    const authorUri = text(one(author, ATOM, 'uri'));
    if (
      ![
        `https://www.youtube.com/channel/${channelId}`,
        `http://www.youtube.com/channel/${channelId}`,
      ].includes(authorUri)
    )
      throw new Error('Mismatched YouTube author');
    const group = one(entry, MEDIA, 'group', false);
    const description =
      group === undefined ? '' : text(one(group, MEDIA, 'description', false), true);
    const thumbnail =
      group === undefined ? undefined : thumbnailUrl(one(group, MEDIA, 'thumbnail', false), id);
    const url = `https://www.youtube.com/watch?v=${id}`;
    return {
      id,
      authorAccount: channelId,
      authorName,
      createdTimestamp: published,
      url,
      text: description === '' ? title : `${title}\n\n${description}`,
      isReply: false,
      isRepost: false,
      media: [{ kind: 'video', url }],
      youtube: {
        title,
        description,
        authorName,
        ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
      },
    };
  });
};
