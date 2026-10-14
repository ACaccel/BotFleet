/**
 * Process-handler installer tests.
 *
 * We verify the install-once contract, the counter side-effects, and the
 * signal-driven graceful shutdown. The termination primitive is injected
 * (`exit`) so the shutdown paths run to completion without tearing down
 * the test runner. The *fatal* `uncaughtException` path is left to the
 * classifier's own unit tests; the two paths that do NOT exit —
 * `unhandledRejection` and a *transient-network* `uncaughtException` —
 * are exercised directly because the handler returns without shutting
 * down.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetProcessHandlersForTests,
  getTransientNetworkErrorCount,
  getUnhandledRejectionCount,
  installProcessHandlers,
} from '../../../../src/core/logger';
import { silentLogger } from '../../../fixtures/runtime';

const noopShutdown = async (): Promise<void> => undefined;

/** Yield long enough for the shutdown promise chain's `.finally` to run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

const TRACKED_EVENTS = ['unhandledRejection', 'uncaughtException', 'SIGINT', 'SIGTERM'] as const;

describe('installProcessHandlers', () => {
  // Snapshot and restore rather than `removeAllListeners`: the runner
  // registers its own handlers on these events in this fork, and
  // stripping them would leak across test files.
  type AnyListener = (...args: never[]) => void;
  const listenersOf = (event: string): AnyListener[] =>
    (process.listeners as unknown as (e: string) => AnyListener[])(event);
  let baseline: Map<string, AnyListener[]>;

  beforeEach(() => {
    baseline = new Map(TRACKED_EVENTS.map((e) => [e, [...listenersOf(e)]]));
  });

  afterEach(() => {
    for (const event of TRACKED_EVENTS) {
      const keep = new Set(baseline.get(event) ?? []);
      for (const listener of listenersOf(event)) {
        if (!keep.has(listener)) {
          (process.removeListener as unknown as (e: string, l: AnyListener) => void)(
            event,
            listener,
          );
        }
      }
    }
    __resetProcessHandlersForTests();
  });

  it('only attaches handlers once across repeated install calls (idempotent)', () => {
    const logger = silentLogger();
    // Vitest installs its own listeners on these events; measure the
    // delta our installer contributes rather than the absolute count.
    const baselineRejection = process.listenerCount('unhandledRejection');
    const baselineException = process.listenerCount('uncaughtException');
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');
    installProcessHandlers({ logger, gracefulShutdown: noopShutdown });
    const afterFirstRejection = process.listenerCount('unhandledRejection');
    const afterFirstException = process.listenerCount('uncaughtException');
    expect(afterFirstRejection - baselineRejection).toBe(1);
    expect(afterFirstException - baselineException).toBe(1);
    expect(process.listenerCount('SIGINT') - baselineSigint).toBe(1);
    expect(process.listenerCount('SIGTERM') - baselineSigterm).toBe(1);
    installProcessHandlers({ logger, gracefulShutdown: noopShutdown });
    expect(process.listenerCount('unhandledRejection')).toBe(afterFirstRejection);
    expect(process.listenerCount('uncaughtException')).toBe(afterFirstException);
    expect(process.listenerCount('SIGINT') - baselineSigint).toBe(1);
    expect(process.listenerCount('SIGTERM') - baselineSigterm).toBe(1);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    '%s runs the graceful shutdown and then exits 0',
    async (signal) => {
      const logger = silentLogger();
      const exitCodes: number[] = [];
      let shutdownCalls = 0;
      installProcessHandlers({
        logger,
        gracefulShutdown: async () => {
          shutdownCalls += 1;
        },
        exit: (code) => exitCodes.push(code),
      });

      process.emit(signal, signal);
      await flush();

      expect(shutdownCalls).toBe(1);
      expect(exitCodes).toEqual([0]);
    },
  );

  it('exits immediately on a second SIGINT instead of waiting for the in-flight shutdown', async () => {
    const logger = silentLogger();
    const exitCodes: number[] = [];
    let shutdownCalls = 0;
    let releaseShutdown: () => void = () => {};
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    installProcessHandlers({
      logger,
      gracefulShutdown: async () => {
        shutdownCalls += 1;
        await shutdownGate;
      },
      exit: (code) => exitCodes.push(code),
    });

    process.emit('SIGINT', 'SIGINT');
    await flush();
    // The first shutdown is still hanging on the gate, so nothing exited yet.
    expect(exitCodes).toEqual([]);

    process.emit('SIGINT', 'SIGINT');
    // The second signal must not wait for the gate.
    expect(exitCodes).toEqual([1]);
    // ...and must not start a second teardown.
    expect(shutdownCalls).toBe(1);

    releaseShutdown();
    await flush();
    expect(shutdownCalls).toBe(1);
  });

  it('exits non-zero when the graceful shutdown itself throws', async () => {
    const logger = silentLogger();
    const exitCodes: number[] = [];
    installProcessHandlers({
      logger,
      gracefulShutdown: () => {
        throw new Error('teardown exploded');
      },
      exit: (code) => exitCodes.push(code),
    });

    process.emit('SIGTERM', 'SIGTERM');
    await flush();

    // The port may still be bound and the connections may still be
    // open, so this is not the clean stop the signal asked for.
    expect(exitCodes).toEqual([1]);
  });

  it('escalates the exit status when a fatal fault lands during a clean shutdown', async () => {
    const logger = silentLogger();
    const exitCodes: number[] = [];
    let releaseShutdown: () => void = () => {};
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    installProcessHandlers({
      logger,
      gracefulShutdown: () => shutdownGate,
      exit: (code) => exitCodes.push(code),
    });

    process.emit('SIGTERM', 'SIGTERM');
    await flush();
    // A genuine crash mid-teardown must not be reported to the
    // supervisor as the clean stop the signal started.
    process.emit('uncaughtException', new Error('genuine defect'));
    releaseShutdown();
    await flush();

    expect(exitCodes).toEqual([1]);
  });

  it('emitting unhandledRejection bumps the counter without exiting', async () => {
    const logger = silentLogger();
    const before = getUnhandledRejectionCount();
    installProcessHandlers({ logger, gracefulShutdown: noopShutdown });
    process.emit('unhandledRejection', new Error('test'), Promise.resolve());
    // Allow microtasks to flush.
    await new Promise<void>((r) => setImmediate(r));
    expect(getUnhandledRejectionCount()).toBe(before + 1);
  });

  it('downgrades a transient-network uncaughtException: counts it, never shuts down', async () => {
    const logger = silentLogger();
    let shutdownCalls = 0;
    const before = getTransientNetworkErrorCount();
    installProcessHandlers({
      logger,
      gracefulShutdown: async () => {
        shutdownCalls += 1;
      },
    });
    // The exact crash signature: ECONNRESET / "socket hang up". The
    // handler returns before arming the shutdown timer, so emitting it
    // here is safe — the runner is not torn down.
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    process.emit('uncaughtException', err);
    await new Promise<void>((r) => setImmediate(r));
    expect(getTransientNetworkErrorCount()).toBe(before + 1);
    expect(shutdownCalls).toBe(0);
  });
});
