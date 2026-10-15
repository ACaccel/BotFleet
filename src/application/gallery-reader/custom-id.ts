/**
 * The customId contract between a gallery reader message and its buttons
 * and jump form. The dispatcher routes on the leading segment, so
 * `GALLERY_PAGE_ID` is also the button and modal handlers' directory name.
 *
 * The payload carries no authority and no state beyond the target: any
 * member may turn the page, and the handler reloads the gallery and clamps
 * the page itself. The trailing slot letter keeps the five buttons' ids
 * unique when two of them target the same page (first and previous on
 * page 2).
 */
import { isGallerySourceName, type GallerySourceName } from '../../infra/link-preview';

const GALLERY_PAGE_ID = 'gallery_page';

/** Text input id inside the jump form. */
export const GALLERY_JUMP_INPUT_ID = 'page';

type Slot = 'f' | 'p' | 'n' | 'l';

interface GalleryTarget {
  readonly source: GallerySourceName;
  readonly id: string;
}

type GalleryButtonTarget =
  | (GalleryTarget & { readonly action: 'page'; readonly page: number })
  | (GalleryTarget & { readonly action: 'jump'; readonly total: number });

/** `gallery_page|<source>|<id>|<page>|<slot>`, far inside the 100-character limit. */
export const encodeGalleryPageButtonId = (
  target: GalleryTarget,
  page: number,
  slot: Slot,
): string => `${GALLERY_PAGE_ID}|${target.source}|${target.id}|${page}|${slot}`;

/**
 * `gallery_page|<source>|<id>|jump|<total>`: opens the jump form. The total
 * only labels the form, which must open within the acknowledgement window
 * and so cannot wait for a metadata read; the submit clamps to the real one.
 */
export const encodeGalleryJumpButtonId = (target: GalleryTarget, total: number): string =>
  `${GALLERY_PAGE_ID}|${target.source}|${target.id}|jump|${total}`;

/** `gallery_page|<source>|<id>`: the jump form's own id. */
export const encodeGalleryJumpModalId = (target: GalleryTarget): string =>
  `${GALLERY_PAGE_ID}|${target.source}|${target.id}`;

const BUTTON_RE = /^gallery_page\|([a-z]+)\|(\d{1,9})\|(?:(\d{1,4})\|[fpnl]|jump\|(\d{1,4}))$/u;
const MODAL_RE = /^gallery_page\|([a-z]+)\|(\d{1,9})$/u;

/** Read a button target back, or `undefined` when this build never writes the id. */
export const decodeGalleryButtonId = (customId: string): GalleryButtonTarget | undefined => {
  const match = BUTTON_RE.exec(customId);
  const source = match?.[1];
  const id = match?.[2];
  if (source === undefined || id === undefined || !isGallerySourceName(source)) return undefined;
  if (match?.[4] !== undefined) return { source, id, action: 'jump', total: Number(match[4]) };
  return { source, id, action: 'page', page: Number(match?.[3]) };
};

export const decodeGalleryModalId = (customId: string): GalleryTarget | undefined => {
  const match = MODAL_RE.exec(customId);
  const source = match?.[1];
  const id = match?.[2];
  if (source === undefined || id === undefined || !isGallerySourceName(source)) return undefined;
  return { source, id };
};
