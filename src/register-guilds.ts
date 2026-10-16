/**
 * Paginated fetch of the bot's guild list for the register CLI.
 *
 * `GET /users/@me/guilds` (`Routes.userGuilds()`) returns at most 200
 * guilds per page. A single request therefore silently truncates the
 * list for any bot in more than 200 guilds, which would leave their
 * guild-scoped commands un-pruned. This follows Discord's `after`
 * cursor (a guild id) until a short page (< limit) signals the end.
 *
 * Kept in its own module (not inline in `register.ts`) so it can be unit
 * tested without `register.ts` running its `main()` on import.
 */
import { Routes } from 'discord.js';
import type { REST } from 'discord.js';

/** Discord's hard cap on `GET /users/@me/guilds` results per page. */
export const GUILD_PAGE_LIMIT = 200;

export interface PartialUserGuild {
  readonly id: string;
  readonly name: string;
}

/**
 * Fetch every guild the bot is a member of, paging through Discord's
 * `after`-cursor pagination so bots in more than {@link GUILD_PAGE_LIMIT}
 * guilds are fully covered.
 */
export const fetchAllUserGuilds = async (rest: REST): Promise<PartialUserGuild[]> => {
  const all: PartialUserGuild[] = [];
  let after: string | undefined;

  for (;;) {
    const query = new URLSearchParams({ limit: String(GUILD_PAGE_LIMIT) });
    if (after !== undefined) query.set('after', after);

    const page = (await rest.get(Routes.userGuilds(), { query })) as PartialUserGuild[];
    all.push(...page);

    // A short page (including an empty one) is the last page.
    if (page.length < GUILD_PAGE_LIMIT) break;

    const last = page[page.length - 1];
    if (last === undefined) break;
    after = last.id;
  }

  return all;
};
