/**
 * Packs rendered lines into Discord-sendable pages.
 *
 * The companion of {@link sendPagedEphemeralReply}: that helper decides
 * how pages are delivered, this one decides where they end. Shared
 * because two commands now build a listing this way (`/feed list` and
 * `/feed subscribe`'s per-account report) and a page that overflows the
 * message limit is rejected outright — losing the whole page, not its
 * tail — so the rule is worth stating once.
 *
 * No discord.js types: the only thing borrowed from Discord is the
 * limit, which makes this testable as plain string work.
 */

/** Discord's hard limit on a single message's content. */
export const MAX_PAGE_LENGTH = 2000;

/**
 * Group `lines` into pages, never splitting one across a boundary and
 * never breaking a page early.
 *
 * A line long enough to exceed the limit on its own is hard-truncated
 * instead, because the alternative is a message Discord rejects
 * outright. Callers bound their own line lengths, so this is a guard
 * rather than a routine path.
 */
export const paginateLines = (lines: readonly string[]): readonly string[] => {
  const pages: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.length > MAX_PAGE_LENGTH ? raw.slice(0, MAX_PAGE_LENGTH) : raw;
    if (current === '') {
      current = line;
      continue;
    }
    const merged = `${current}\n${line}`;
    if (merged.length > MAX_PAGE_LENGTH) {
      pages.push(current);
      current = line;
    } else {
      current = merged;
    }
  }
  if (current !== '') pages.push(current);
  return pages;
};
