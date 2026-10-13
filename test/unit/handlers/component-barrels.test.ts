/**
 * Wiring coverage for the modal and select-menu barrels.
 *
 * `handler-barrel.test.ts` pins the generic registrar / dispatcher
 * against synthetic handlers. What only these two barrels can show is
 * that the real generated registry, the real handler classes, and the
 * `BaseBot` field each family publishes to are actually joined up — and
 * that the thin `giveaway_*` components forward to the shared giveaway
 * interaction bodies rather than reimplementing them.
 */
import type { ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGiveawayCreate } from '../../../src/handlers/commands/giveaway-shared/create';
import { handleGiveawayDeleteSelection } from '../../../src/handlers/commands/giveaway-shared/delete';
import { executeModal, registerModals } from '../../../src/handlers/modals';
import { executeSSM, registerSSMs } from '../../../src/handlers/select-menus';
import type { BaseBot } from '../../../src/bot';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

// The two `giveaway_*` components are pure delegations, so the bodies
// they delegate to are replaced with spies. Their own behaviour is
// covered in `test/unit/handlers/giveaway-*.test.ts`.
vi.mock('../../../src/handlers/commands/giveaway-shared/create', () => ({
  handleGiveawayCreate: vi.fn(async () => undefined),
}));
vi.mock('../../../src/handlers/commands/giveaway-shared/delete', () => ({
  handleGiveawayDeleteSelection: vi.fn(async () => undefined),
}));

/**
 * A bot carrying the two handler maps `BaseBot` seeds empty. The barrels
 * write into them on register and read them back on dispatch.
 */
const buildHostBot = (): BaseBot =>
  buildFakeBot({ modalHandlers: new Map(), ssmHandlers: new Map() }).bot;

beforeEach(() => {
  vi.clearAllMocks();
});

const modalInteraction = (customId: string): ModalSubmitInteraction =>
  ({ customId }) as unknown as ModalSubmitInteraction;

const selectInteraction = (customId: string): StringSelectMenuInteraction =>
  ({ customId }) as unknown as StringSelectMenuInteraction;

describe('modal barrel', () => {
  it('publishes one handler per generated registry entry', async () => {
    const bot = buildHostBot();

    await registerModals(bot);

    expect([...bot.modalHandlers.keys()].sort()).toEqual(['ai_settings', 'giveaway_create']);
  });

  it('routes a customId to the handler its leading segment names', async () => {
    const bot = buildHostBot();
    await registerModals(bot);

    await executeModal(modalInteraction('giveaway_create|prize'), bot);

    expect(vi.mocked(handleGiveawayCreate)).toHaveBeenCalledTimes(1);
  });

  it('ignores a modal another bot in the guild owns', async () => {
    const bot = buildHostBot();
    await registerModals(bot);

    await expect(executeModal(modalInteraction('not_ours|x'), bot)).resolves.toBeUndefined();
    expect(vi.mocked(handleGiveawayCreate)).not.toHaveBeenCalled();
  });
});

describe('select-menu barrel', () => {
  it('publishes one handler per generated registry entry', async () => {
    const bot = buildHostBot();

    await registerSSMs(bot);

    expect([...bot.ssmHandlers.keys()].sort()).toEqual(['delete_reply', 'giveaway_delete']);
  });

  it('routes a customId to the handler its leading segment names', async () => {
    const bot = buildHostBot();
    await registerSSMs(bot);

    await executeSSM(selectInteraction('giveaway_delete|msg-1'), bot);

    expect(vi.mocked(handleGiveawayDeleteSelection)).toHaveBeenCalledTimes(1);
  });

  it('ignores a select menu another bot in the guild owns', async () => {
    const bot = buildHostBot();
    await registerSSMs(bot);

    await expect(executeSSM(selectInteraction('not_ours|x'), bot)).resolves.toBeUndefined();
    expect(vi.mocked(handleGiveawayDeleteSelection)).not.toHaveBeenCalled();
  });
});
