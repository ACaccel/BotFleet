/**
 * The button that abandons a whole-channel clear.
 *
 * It touches no repository, so the only things worth asserting are that
 * it says nothing was removed, that it takes the prompt's buttons away
 * with it, and that it is as picky about who may answer as its
 * destructive twin — a cancel that any passer-by could press would let
 * them dismiss a question that was not theirs.
 */
import { describe, expect, it } from 'vitest';
import { MessageFlags } from 'discord.js';

import FeedClearCancel from '../../../../src/handlers/buttons/feed_clear_cancel';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const CHANNEL_ID = 'chan-home';
const INVOKER_ID = 'u-1';
const STRANGER_ID = 'u-2';

interface BuildOptions {
  readonly pressedBy?: string;
  readonly customId?: string;
  readonly updateError?: Error;
}

const build = (options: BuildOptions = {}) => {
  const { bot } = buildFakeBot({ translator: echoTranslatorWithParams() });
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId: options.customId ?? `feed_clear_cancel|${CHANNEL_ID}|${INVOKER_ID}`,
    userId: options.pressedBy ?? INVOKER_ID,
    updateError: options.updateError,
    sink,
  });
  return { bot, interaction, sink };
};

describe('feed_clear_cancel button handler', () => {
  it('replaces the prompt with a plain "nothing removed"', async () => {
    const { bot, interaction, sink } = build();

    await new FeedClearCancel().execute(interaction, bot);

    expect(sink.updates[0]).toEqual({
      content: 'replies:feed.clear_cancelled',
      components: [],
    });
  });

  it('answers in place rather than leaving the warning above its answer', async () => {
    const { bot, interaction, sink } = build();

    await new FeedClearCancel().execute(interaction, bot);

    expect(sink.updates).toHaveLength(1);
    expect(sink.replies).toHaveLength(0);
  });

  it('refuses a presser who is not the member who was asked', async () => {
    const { bot, interaction, sink } = build({ pressedBy: STRANGER_ID });

    await new FeedClearCancel().execute(interaction, bot);

    expect(sink.updates).toHaveLength(0);
    expect(sink.replies[0]).toEqual({
      content: 'replies:feed.clear_not_invoker',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('retires a customId that carries no scope', async () => {
    const { bot, interaction, sink } = build({ customId: 'feed_clear_cancel' });

    await new FeedClearCancel().execute(interaction, bot);

    expect(sink.replies).toHaveLength(0);
    expect(sink.updates[0]).toEqual({
      content: 'replies:feed.clear_stale',
      components: [],
    });
  });

  it('falls back to the traced failure copy when the update itself is refused', async () => {
    // `update` rejecting leaves the interaction unacknowledged, so the
    // failure copy has to arrive through `reply`, not another edit.
    const { bot, interaction, sink } = build({ updateError: new Error('gateway closed') });

    await new FeedClearCancel().execute(interaction, bot);

    expect(sink.updates).toHaveLength(0);
    const content = sink.replies.at(-1)?.content ?? '';
    expect(content).toContain('replies:feed.failed');
    expect(content).toContain('traceId');
  });
});
