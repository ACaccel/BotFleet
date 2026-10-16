import { describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../../src/core/time';
import { createContainer } from '../../../../src/core/ioc';
import {
  DoubleNextError,
  InteractionRouter,
  type InteractionContext,
  type InteractionMiddleware,
} from '../../../../src/core/plugin';
import { echoTranslator, silentLogger } from '../../../fixtures/runtime';

const buildCtx = (): InteractionContext => {
  // One container per ctx — bind target must match the method owner,
  // otherwise `resolve` would dispatch to a different container at
  // runtime. Tests do not exercise `resolve`, but the wiring is still
  // shape-verified here to keep the fake honest.
  const container = createContainer();
  return {
    interaction: {} as InteractionContext['interaction'],
    traceId: 'trace-1',
    state: new Map(),
    logger: silentLogger(),
    translator: echoTranslator(),
    clock: systemClock,
    resolve: container.resolve.bind(container) as InteractionContext['resolve'],
  };
};

const mw = (
  name: string,
  body: (ctx: InteractionContext, next: () => Promise<void>) => Promise<void>,
): InteractionMiddleware => ({ name, run: body });

describe('InteractionRouter', () => {
  it('runs middlewares in registration order when each calls next()', async () => {
    const log: string[] = [];
    const router = new InteractionRouter()
      .use(
        mw('a', async (_ctx, next) => {
          log.push('a-pre');
          await next();
          log.push('a-post');
        }),
      )
      .use(
        mw('b', async (_ctx, next) => {
          log.push('b-pre');
          await next();
          log.push('b-post');
        }),
      )
      .use(
        mw('c', async () => {
          log.push('c');
        }),
      );
    await router.dispatch(buildCtx());
    expect(log).toEqual(['a-pre', 'b-pre', 'c', 'b-post', 'a-post']);
  });

  it('short-circuits when a middleware does not call next()', async () => {
    const after = vi.fn();
    const router = new InteractionRouter()
      .use(mw('halt', async () => undefined))
      .use(mw('never', after));
    await router.dispatch(buildCtx());
    expect(after).not.toHaveBeenCalled();
  });

  it('throws DoubleNextError when next() is called twice from one middleware', async () => {
    const router = new InteractionRouter()
      .use(
        mw('double', async (_ctx, next) => {
          await next();
          await next();
        }),
      )
      .use(mw('downstream', async () => undefined));
    await expect(router.dispatch(buildCtx())).rejects.toBeInstanceOf(DoubleNextError);
  });

  it('propagates a middleware exception out of dispatch()', async () => {
    const router = new InteractionRouter().use(
      mw('explode', async () => {
        throw new Error('boom');
      }),
    );
    await expect(router.dispatch(buildCtx())).rejects.toThrow('boom');
  });

  it('stack() returns a frozen snapshot of registered middleware', () => {
    const router = new InteractionRouter().use(mw('a', async () => undefined));
    const snap = router.stack();
    expect(snap.length).toBe(1);
    expect(Object.isFrozen(snap)).toBe(true);
  });
});
