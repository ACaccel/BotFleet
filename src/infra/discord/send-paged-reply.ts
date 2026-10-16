/**
 * Ephemeral multi-page reply delivery.
 *
 * A listing longer than Discord's 2000-character message limit is sent
 * as one `editReply` plus N `followUp` messages. The naive loop —
 * `for (...) await interaction.followUp(...)` inside the handler's
 * `try` — has a specific failure mode: when page 3 of 5 is rejected,
 * the rejection escapes to the handler's `catch`, `replyForError` calls
 * `editReply`, and the error line **overwrites page 1**, leaving pages
 * 4 and 5 unsent and no indication that anything was delivered.
 *
 * So each page is isolated. A page that fails is logged and skipped,
 * the remaining pages still go out, and the partial delivery is
 * reported with one more `followUp` — never an `editReply`, because
 * everything already on screen is real output that must survive.
 *
 * Ordering is sequential on purpose: Discord renders follow-ups in
 * arrival order, and `Promise.all` would interleave the pages.
 */
import {
  MessageFlags,
  type ContextMenuCommandInteraction,
  type RepliableInteraction,
} from 'discord.js';

import { logError, logSystem, ops, type Logger } from '../../core/logger';

/** Same widening rationale as `reply-for-error.ts`. */
type HandlerInteraction = RepliableInteraction | ContextMenuCommandInteraction;

interface PagedReplyDeps {
  readonly logger: Logger | undefined;
  /**
   * Localised notice appended when at least one page could not be sent,
   * so a gap in the listing is visible rather than silent. Resolved by
   * the caller because only the handler knows its own catalog namespace.
   */
  readonly partialNotice: (failedCount: number) => string;
}

/**
 * Send `pages` as one ephemeral reply plus follow-ups.
 *
 * Never throws: a delivery failure is an operator problem, and letting
 * it reach the handler's boundary is exactly what clobbers page 1. The
 * caller has already deferred the interaction.
 *
 * @returns how many pages failed to send.
 */
export const sendPagedEphemeralReply = async (
  interaction: HandlerInteraction,
  pages: readonly string[],
  deps: PagedReplyDeps,
): Promise<number> => {
  const [first, ...rest] = pages;
  if (first === undefined) return 0;

  let failed = 0;
  try {
    await interaction.editReply({ content: first });
  } catch (err: unknown) {
    // The first page rides the deferred reply, so its failure leaves
    // nothing on screen. Counting it keeps the notice honest.
    failed += 1;
    logError(deps.logger, interaction.guildId, err);
    logSystem(deps.logger, ops.router.pageSendFailed(0, pages.length));
  }

  for (const [index, page] of rest.entries()) {
    try {
      await interaction.followUp({ content: page, flags: MessageFlags.Ephemeral });
    } catch (err: unknown) {
      failed += 1;
      logError(deps.logger, interaction.guildId, err);
      logSystem(deps.logger, ops.router.pageSendFailed(index + 1, pages.length));
    }
  }

  if (failed > 0) {
    try {
      await interaction.followUp({
        content: deps.partialNotice(failed),
        flags: MessageFlags.Ephemeral,
      });
    } catch (err: unknown) {
      // The interaction is unusable. The pages that did land stay
      // visible, which is strictly better than replacing them.
      logError(deps.logger, interaction.guildId, err);
    }
  }
  return failed;
};
