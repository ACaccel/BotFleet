import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { archiveFailure } from '../../../../src/handlers/commands/archive/replies';
import { ArchiveAccessError } from '../../../../src/handlers/commands/archive/access';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const fixture = () => ({
  message: { flags: { has: () => false } },
  guildId: 'guild',
  deferred: false,
  replied: false,
  reply: vi.fn(),
  editReply: vi.fn(),
  followUp: vi.fn(),
});
describe('archive interaction error acknowledgement', () => {
  it('acknowledges a rejected modal-launch button before sending an error', async () => {
    const interaction = fixture();
    await archiveFailure(
      interaction as never,
      buildFakeBot().bot,
      new ArchiveAccessError('replies:archive.permission_denied'),
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'replies:archive.permission_denied',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
  it('does not overwrite the public card for an acknowledged component failure', async () => {
    const interaction = { ...fixture(), deferred: true };
    await archiveFailure(
      interaction as never,
      buildFakeBot().bot,
      new ArchiveAccessError('replies:archive.confirm_actor'),
    );
    expect(interaction.followUp).toHaveBeenCalledOnce();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
  it('finishes the modal submission acknowledgement on validation failure', async () => {
    const interaction = { ...fixture(), fields: {}, deferred: true };
    await archiveFailure(
      interaction as never,
      buildFakeBot().bot,
      new ArchiveAccessError('replies:archive.invalid_input'),
    );
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
