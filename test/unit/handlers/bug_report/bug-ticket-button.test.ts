import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';

import BugTicketButton from '../../../../src/handlers/buttons/bug_ticket';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

describe('ticket buttons', () => {
  it('refuses anyone who is not a bot admin before touching the ticket', async () => {
    const sink = newInteractionSink();
    const interaction = buildButtonInteraction({
      customId: 'bug_ticket|close',
      userId: 'member',
      channel: { id: 'thread-7', isThread: () => true },
      sink,
    });
    const { bot } = buildFakeBot({ isAdmin: () => false });

    await new BugTicketButton().execute(interaction, bot);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(sink.editReplies).toEqual([{ content: 'replies:bug_report.admin_only' }]);
  });
});
