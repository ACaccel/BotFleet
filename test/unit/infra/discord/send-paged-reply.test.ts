/**
 * Paged ephemeral reply delivery.
 *
 * The failure this helper exists to prevent is specific: with a naive
 * `for (...) await followUp(...)` inside the handler's `try`, a rejected
 * page escapes to the handler's `catch`, `replyForError` calls
 * `editReply`, and the error line overwrites page 1. Everything already
 * on screen is real output; it must survive.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

import { sendPagedEphemeralReply } from '../../../../src/infra/discord/send-paged-reply';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

/** The fake bot owns the single cast to the real `Logger` type. */
const deps = (bot: ReturnType<typeof buildFakeBot>['bot']) => ({
  logger: bot.logger,
  partialNotice: (failed: number) => `partial:${String(failed)}`,
});

describe('sendPagedEphemeralReply', () => {
  it('sends the first page as the deferred reply and the rest as follow-ups', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const { bot } = buildFakeBot();

    const failed = await sendPagedEphemeralReply(interaction, ['a', 'b', 'c'], deps(bot));

    expect(failed).toBe(0);
    expect(sink.editReplies.map((r) => r.content)).toEqual(['a']);
    expect(sink.followUps.map((r) => r.content)).toEqual(['b', 'c']);
  });

  it('keeps every follow-up ephemeral', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const { bot } = buildFakeBot();

    await sendPagedEphemeralReply(interaction, ['a', 'b'], deps(bot));

    expect(sink.followUps[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('does nothing at all for an empty page list', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const { bot } = buildFakeBot();

    expect(await sendPagedEphemeralReply(interaction, [], deps(bot))).toBe(0);
    expect(sink.editReplies).toHaveLength(0);
  });

  it('keeps going after a failed page and never touches the first one again', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const { bot, logger } = buildFakeBot();
    let call = 0;
    interaction.followUp = vi.fn(async (opts: { content?: string; flags?: number }) => {
      call += 1;
      if (call === 1) throw new Error('rate limited');
      sink.followUps.push(opts);
      return undefined;
    }) as unknown as typeof interaction.followUp;

    const failed = await sendPagedEphemeralReply(interaction, ['a', 'b', 'c'], deps(bot));

    expect(failed).toBe(1);
    // Page 1 still says what it said — this is the regression.
    expect(sink.editReplies.map((r) => r.content)).toEqual(['a']);
    // Page 3 was still delivered, and the gap is reported.
    expect(sink.followUps.map((r) => r.content)).toEqual(['c', 'partial:1']);
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports a failed first page rather than pretending the list was sent', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const { bot } = buildFakeBot();
    interaction.editReply = vi.fn(async () => {
      throw new Error('too long');
    }) as unknown as typeof interaction.editReply;

    const failed = await sendPagedEphemeralReply(interaction, ['a', 'b'], deps(bot));

    expect(failed).toBe(1);
    expect(sink.followUps.map((r) => r.content)).toEqual(['b', 'partial:1']);
  });

  it('never throws, even when the partial notice itself cannot be sent', async () => {
    const interaction = buildChatInputInteraction();
    const { bot } = buildFakeBot();
    interaction.followUp = vi.fn(async () => {
      throw new Error('interaction gone');
    }) as unknown as typeof interaction.followUp;

    // A rejection here would reach the handler's boundary and clobber
    // whatever did land — the exact defect this helper removes.
    await expect(
      sendPagedEphemeralReply(interaction, ['a', 'b'], deps(bot)),
    ).resolves.toBeGreaterThan(0);
  });
});
