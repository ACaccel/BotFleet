import { describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

import BugTicketButton from '../../../../src/handlers/buttons/bug_ticket';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

describe('ticket buttons', () => {
  it('refuses anyone who is not a bot admin before touching the ticket', async () => {
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const interaction = {
      customId: 'bug_ticket|close',
      user: { id: 'member' },
      deferReply: vi.fn(async () => undefined),
      editReply,
      channel: { isThread: () => true, id: 'thread-7' },
    } as unknown as ButtonInteraction;
    const { bot } = buildFakeBot({ isAdmin: () => false });

    await new BugTicketButton().execute(interaction, bot);

    expect(editReply).toHaveBeenCalledWith({ content: 'replies:bug_report.admin_only' });
  });
});
