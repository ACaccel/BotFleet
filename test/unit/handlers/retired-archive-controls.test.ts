/**
 * Components on archive panels from earlier versions: every retired prefix
 * is still registered through the real generated registries and answers
 * privately that the panel is out of date, without editing the old message
 * or throwing when the reply itself fails.
 */
import {
  DiscordAPIError,
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { executeButton, registerButtons } from '../../../src/handlers/buttons';
import { executeModal, registerModals } from '../../../src/handlers/modals';
import { executeSSM, registerSSMs } from '../../../src/handlers/select-menus';
import type { BaseBot } from '../../../src/bot';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

type Family = 'button' | 'select menu' | 'modal';

const RETIRED: ReadonlyArray<readonly [Family, string]> = [
  ['button', 'archive_browse'],
  ['button', 'archive_confirm'],
  ['button', 'archive_jobs'],
  ['button', 'archive_manage'],
  ['button', 'archive_panel'],
  ['button', 'archive_view'],
  ['select menu', 'archive_actions'],
  ['select menu', 'archive_category'],
  ['select menu', 'archive_pick'],
  ['modal', 'archive_attachment'],
];

const hostBot = async () => {
  const fake = buildFakeBot({
    buttonHandlers: new Map(),
    ssmHandlers: new Map(),
    modalHandlers: new Map(),
  });
  await registerButtons(fake.bot);
  await registerSSMs(fake.bot);
  await registerModals(fake.bot);
  return fake;
};

/**
 * Every way an old panel could be changed is a spy, so the assertion that
 * nothing but a private reply happened covers all of them.
 */
const oldPanelInteraction = (customId: string, replyError?: Error) => {
  const reply = vi.fn(async () => {
    if (replyError !== undefined) throw replyError;
  });
  const edits = {
    update: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
    message: { edit: vi.fn(), delete: vi.fn() },
  };
  const interaction = {
    customId,
    guildId: 'g-1',
    replied: false,
    deferred: false,
    reply,
    ...edits,
  };
  return { interaction, reply, edits };
};

const dispatch = async (family: Family, interaction: object, bot: BaseBot): Promise<void> => {
  if (family === 'button') await executeButton(interaction as ButtonInteraction, bot);
  else if (family === 'select menu')
    await executeSSM(interaction as StringSelectMenuInteraction, bot);
  else await executeModal(interaction as ModalSubmitInteraction, bot);
};

const expectPanelUntouched = (edits: ReturnType<typeof oldPanelInteraction>['edits']) => {
  expect(edits.update).not.toHaveBeenCalled();
  expect(edits.deferUpdate).not.toHaveBeenCalled();
  expect(edits.editReply).not.toHaveBeenCalled();
  expect(edits.followUp).not.toHaveBeenCalled();
  expect(edits.message.edit).not.toHaveBeenCalled();
  expect(edits.message.delete).not.toHaveBeenCalled();
};

describe('retired archive controls', () => {
  it.each(RETIRED)('answers an old %s %s privately as stale', async (family, prefix) => {
    const { bot } = await hostBot();
    const { interaction, reply, edits } = oldPanelInteraction(`${prefix}|legacy|123`);

    await expect(dispatch(family, interaction, bot)).resolves.toBeUndefined();

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      content: 'replies:archive.navigation_stale',
      flags: MessageFlags.Ephemeral,
    });
    expectPanelUntouched(edits);
  });

  it.each(RETIRED)('answers a bare old %s %s prefix as stale', async (family, prefix) => {
    const { bot } = await hostBot();
    const { interaction, reply } = oldPanelInteraction(prefix);

    await dispatch(family, interaction, bot);

    expect(reply.mock.calls[0]).toEqual([
      { content: 'replies:archive.navigation_stale', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('logs and swallows an expired interaction instead of throwing', async () => {
    const { bot, logger } = await hostBot();
    const expired = new DiscordAPIError(
      { code: 10062, message: 'Unknown interaction' },
      10062,
      404,
      'POST',
      '/interactions/1/token/callback',
      {},
    );
    const { interaction, edits } = oldPanelInteraction('archive_panel|job', expired);

    await expect(dispatch('button', interaction, bot)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expectPanelUntouched(edits);
  });

  it('logs and swallows any other reply failure instead of throwing', async () => {
    const { bot, logger } = await hostBot();
    const { interaction } = oldPanelInteraction('archive_pick|1', new Error('network down'));

    await expect(dispatch('select menu', interaction, bot)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ customId: 'archive_pick|1', guildId: 'g-1' }),
      'Retired archive control reply failed',
    );
  });

  it('translates the stale notice through the bot translator', async () => {
    const t = vi.fn(() => 'This panel is out of date.');
    const fake = buildFakeBot({ modalHandlers: new Map(), translator: { t } });
    await registerModals(fake.bot);
    const { interaction, reply } = oldPanelInteraction('archive_attachment|x');

    await executeModal(interaction as unknown as ModalSubmitInteraction, fake.bot);

    expect(t).toHaveBeenCalledWith('replies:archive.navigation_stale', undefined);
    expect(reply).toHaveBeenCalledWith({
      content: 'This panel is out of date.',
      flags: MessageFlags.Ephemeral,
    });
  });
});
