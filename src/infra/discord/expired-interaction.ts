/**
 * The "this interaction is already dead" test every acknowledgement path
 * needs.
 *
 * Several call sites (the reply-or-edit guards in `reply-for-error.ts` and
 * `require-guild-repos.ts`, and the autocomplete dispatcher) share the same
 * two Discord error codes, and each swallows the error rather than
 * re-throwing because there is no longer anyone to tell. One shared set
 * keeps them from drifting apart.
 */
import { DiscordAPIError } from 'discord.js';

/**
 * Codes that mean the interaction can no longer be answered:
 *
 *   - `10062` Unknown Interaction — the response window elapsed. Three
 *     seconds for a first acknowledgement, fifteen minutes for a
 *     deferred follow-up.
 *   - `40060` Interaction has already been acknowledged.
 *
 * See Discord's JSON error-code reference.
 */
const EXPIRED_INTERACTION_CODES: ReadonlySet<number> = new Set([10062, 40060]);

/**
 * True when `err` says the interaction is gone.
 *
 * The distinction is worth drawing rather than swallowing every
 * rejection alike: an expired interaction is routine and nobody's
 * defect, while a rejected payload or a revoked token is a real fault
 * that must not be filed at the same severity.
 *
 * Narrows to `DiscordAPIError` so a caller can still log the code.
 */
export const isExpiredInteractionError = (err: unknown): err is DiscordAPIError =>
  err instanceof DiscordAPIError && EXPIRED_INTERACTION_CODES.has(Number(err.code));
