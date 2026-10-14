/**
 * Routing contract of the dispatch middleware.
 *
 * The middleware is a switch over the interaction discriminant, and the
 * autocomplete arm is the one that must not be reached by any other:
 * `executeCommand` replies on a handler miss, and an autocomplete
 * interaction has no reply channel — that call would reject, escape to
 * the bridge, and be retried there against the same dead interaction.
 *
 * The dispatchers themselves are stubbed; what is asserted here is
 * which one was picked and that `next()` still ran, so the
 * observability stages behind dispatch keep firing.
 */
/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handler barrels pull in the generated registry, and with it every
// handler in the tree. Stub them; this suite is about the switch.
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';

// `vi.hoisted` so the spies exist before the hoisted `vi.mock` factory
// closes over them.
const dispatchers = vi.hoisted(() => ({
  executeCommand: vi.fn(async () => undefined),
  executeAutocomplete: vi.fn(async () => undefined),
}));

vi.mock('@cmd', () => ({ ...barrelStubs.cmd, ...dispatchers }));
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);

import { createDispatchMiddleware } from '../../../src/bot/middlewares';
import type { InteractionContext } from '../../../src/core/plugin';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import {
  buildAutocompleteInteraction,
  buildChatInputInteraction,
} from '../../fixtures/discord/interaction-builder';

const { bot } = buildFakeBot();

const run = async (interaction: unknown): Promise<{ nextCalls: number }> => {
  let nextCalls = 0;
  const middleware = createDispatchMiddleware(bot);
  await middleware.run({ interaction } as unknown as InteractionContext, async () => {
    nextCalls += 1;
  });
  return { nextCalls };
};

describe('dispatch middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes an autocomplete interaction to the autocomplete dispatcher', async () => {
    const interaction = buildAutocompleteInteraction({ commandName: 'feed_unsubscribe' });

    const { nextCalls } = await run(interaction);

    expect(dispatchers.executeAutocomplete).toHaveBeenCalledTimes(1);
    expect(dispatchers.executeAutocomplete).toHaveBeenCalledWith(interaction, bot);
    // The command dispatcher would reply to a handler miss, which this
    // interaction cannot accept.
    expect(dispatchers.executeCommand).not.toHaveBeenCalled();
    expect(nextCalls).toBe(1);
  });

  it('still routes a chat-input command to the command dispatcher', async () => {
    const interaction = buildChatInputInteraction({ commandName: 'feed_unsubscribe' });

    const { nextCalls } = await run(interaction);

    expect(dispatchers.executeCommand).toHaveBeenCalledTimes(1);
    expect(dispatchers.executeAutocomplete).not.toHaveBeenCalled();
    expect(nextCalls).toBe(1);
  });

  it('runs the rest of the chain even when the autocomplete arm did nothing useful', async () => {
    // `executeAutocomplete` never rejects by contract; this pins the
    // other half — that dispatch does not short-circuit the chain.
    const { nextCalls } = await run(buildAutocompleteInteraction({ commandName: 'ghost' }));

    expect(nextCalls).toBe(1);
  });

  it('claims an autocomplete interaction before the reply fallback can', async () => {
    // `isRepliable` is forced true so the fallback arm is genuinely
    // reachable: with it false the assertion would hold even if the
    // autocomplete branch were deleted, which is what makes branch
    // *order* — the thing middlewares.ts calls load-bearing — the
    // property actually under test here.
    const reply = vi.fn();
    const interaction = {
      ...buildAutocompleteInteraction({}),
      isAutocomplete: () => true,
      isRepliable: () => true,
      reply,
    };

    await run(interaction);

    expect(dispatchers.executeAutocomplete).toHaveBeenCalledTimes(1);
    // Replying is not merely unwanted here; Discord rejects it, and the
    // rejection would escape to the bridge.
    expect(reply).not.toHaveBeenCalled();
  });

  it('falls back to the unsupported-type reply for a repliable interaction it cannot route', async () => {
    // The other side of the same branch order: the fallback still fires
    // for an interaction no dispatcher claims.
    const reply = vi.fn();
    const interaction = {
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      reply,
    };

    await run(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(dispatchers.executeAutocomplete).not.toHaveBeenCalled();
    expect(dispatchers.executeCommand).not.toHaveBeenCalled();
  });
});
