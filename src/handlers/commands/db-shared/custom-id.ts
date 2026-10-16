/**
 * The customId contract between `/db list` panels and their components.
 *
 * The dispatcher selects a handler by the leading segment, so each prefix is
 * also its handler's directory name. The payload carries no authority: the
 * token names an in-memory session that the service checks against the
 * presser, and the page or row index is clamped there.
 */
import { requireCapture } from '../../../core/regex-capture';

export const DB_PAGE_BUTTON_ID = 'db_page';
export const DB_VIEW_MENU_ID = 'db_view';

/** `db_page|<token>|<page>`. */
export const encodeDbPageCustomId = (token: string, page: number): string =>
  `${DB_PAGE_BUTTON_ID}|${token}|${page}`;

/** `db_view|<token>`; the chosen value is the row index on the page. */
export const encodeDbViewCustomId = (token: string): string => `${DB_VIEW_MENU_ID}|${token}`;

const TOKEN = '([A-Za-z0-9_-]{1,32})';
const PAGE_PATTERN = new RegExp(`^db_page\\|${TOKEN}\\|(\\d{1,5})$`, 'u');
const VIEW_PATTERN = new RegExp(`^db_view\\|${TOKEN}$`, 'u');

export const decodeDbPageCustomId = (
  customId: string,
): { readonly token: string; readonly page: number } | undefined => {
  const match = PAGE_PATTERN.exec(customId);
  if (match === null) return undefined;
  return { token: requireCapture(match, 1), page: Number(requireCapture(match, 2)) };
};

export const decodeDbViewCustomId = (customId: string): string | undefined => {
  const match = VIEW_PATTERN.exec(customId);
  return match === null ? undefined : requireCapture(match, 1);
};
