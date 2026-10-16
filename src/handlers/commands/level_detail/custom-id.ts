/**
 * The customId contract between the `/level_detail` leaderboard and its
 * page buttons.
 *
 * The dispatcher selects a handler by the leading segment, so
 * `LEVEL_PAGE_BUTTON_ID` is also the button handler's directory name.
 * The payload carries no authority: it names the member who may page
 * and the target page, and the handler re-reads the leaderboard and
 * clamps the page itself.
 */
import { requireCapture } from '../../../core/regex-capture';

export const LEVEL_PAGE_BUTTON_ID = 'level_page';

interface LevelPageTarget {
  /** The member who ran `/level_detail`; the only one who may page. */
  readonly invokerId: string;
  /** May be `0` or past the end on a disabled button; the handler clamps it. */
  readonly page: number;
}

/** `level_page|<invokerId>|<page>`, far inside Discord's 100-character limit. */
export const encodeLevelPageCustomId = (target: LevelPageTarget): string =>
  `${LEVEL_PAGE_BUTTON_ID}|${target.invokerId}|${target.page}`;

const PATTERN = /^level_page\|([^|]+)\|(\d{1,4})$/u;

/** Read a target back, or `undefined` when the id is not one this build writes. */
export const decodeLevelPageCustomId = (customId: string): LevelPageTarget | undefined => {
  const match = PATTERN.exec(customId);
  if (match === null) return undefined;
  return { invokerId: requireCapture(match, 1), page: Number(requireCapture(match, 2)) };
};
