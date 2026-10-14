/**
 * Interaction-router dispatch test. Drives a minimal
 * chat-input interaction through `InteractionRouter` with two
 * middlewares and asserts the run order, terminal `next()` semantics,
 * and that the per-interaction context is propagated unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { InteractionRouter } from '../../../../src/core/plugin/interaction-router';
import type { InteractionContext, InteractionMiddleware } from '../../../../src/core/plugin';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';

const silent = silentLogger();

describe('InteractionRouter — chat-input dispatch', () => {
  it('runs middlewares in registration order and forwards the same ctx through next()', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({
      commandName: 'ping',
      userId: 'u-1',
      sink,
    });

    const seen: string[] = [];
    const echo = (label: string): InteractionMiddleware => ({
      name: label,
      async run(ctx: InteractionContext, next) {
        seen.push(`${label}:before`);
        await next();
        seen.push(`${label}:after`);
        // Terminal middleware: surface a reply so handler-side assertions
        // can detect the flow reached the bottom of the chain.
        if (label === 'terminal' && ctx.interaction.isChatInputCommand()) {
          await ctx.interaction.reply({ content: 'pong' });
        }
      },
    });

    const router = new InteractionRouter();
    router.use(echo('outer'));
    router.use(echo('terminal'));

    const ctx: InteractionContext = {
      interaction,
      logger: silent,
      translator: echoTranslator(),
      clock: { now: () => 0, nowDate: () => new Date(0) },
      resolve: vi.fn() as InteractionContext['resolve'],
      traceId: 'trace-1',
      state: new Map<string, unknown>(),
    };
    await router.dispatch(ctx);

    expect(seen).toEqual(['outer:before', 'terminal:before', 'terminal:after', 'outer:after']);
    expect(sink.replies).toHaveLength(1);
    expect(sink.replies[0]?.content).toBe('pong');
  });
});
