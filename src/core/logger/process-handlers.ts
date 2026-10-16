/**
 * Process-level safety net, installed once per process (see
 * {@link installed}) even when several BaseBots share it.
 *
 * `SIGINT` / `SIGTERM` run the injected `gracefulShutdown` under the same
 * re-entrancy guard and hard timeout as the fatal path, then exit 0, so a
 * `restart: on-failure` supervisor treats an intentional stop as one. Without
 * these listeners Node exits immediately, leaving Mongo connections, a
 * half-written backup transcript and a bound HTTP port behind. A second
 * signal during shutdown means the caller will not wait: exit 1 at once.
 *
 * The exit status only escalates: a fatal exception during a clean teardown,
 * or a throwing `gracefulShutdown`, raises it to 1.
 *
 * `uncaughtException`: a transient outbound-socket failure (see the
 * deliberately narrow {@link isTransientNetworkError}) is logged, counted
 * ({@link getTransientNetworkErrorCount}) and tolerated, because the owning
 * client reconnects on its own. Anything else leaves the process in an
 * indeterminate state, so it is fatal: best-effort graceful shutdown with a
 * 5-second hard timeout, then exit 1.
 *
 * `unhandledRejection` is logged and counted ({@link getUnhandledRejectionCount})
 * but never exits: many libraries reject fire-and-forget promises benignly
 * during teardown.
 */
import { isTransientNetworkError } from '../errors';

import type { Logger } from './logger';

let installed = false;
let unhandledRejectionCount = 0;
let transientNetworkErrorCount = 0;
let shuttingDown = false;
/**
 * Status the process will exit with once the in-flight teardown
 * finishes. Only ever escalated (see {@link escalateExitCode}) so a
 * fault arriving during a clean SIGTERM cannot be reported to the
 * supervisor as a clean stop.
 */
let pendingExitCode = 0;
/** Guards against a second `exit` call on the hard-timeout path. */
let exited = false;

/** Process-termination primitive; `process.exit` in production. */
type ExitFn = (code: number) => void;

interface InstallProcessHandlersInput {
  readonly logger: Logger;
  /**
   * Called when a termination signal or a fatal uncaughtException
   * fires. Implementations should close Discord clients + mongo
   * connections etc. The handler enforces a 5-second cap before
   * calling {@link InstallProcessHandlersInput.exit}.
   */
  readonly gracefulShutdown: () => Promise<void>;
  /**
   * Termination primitive. Defaults to `process.exit`. Injectable so
   * the shutdown paths can be exercised without tearing down the
   * caller's process.
   */
  readonly exit?: ExitFn;
}

const SHUTDOWN_HARD_TIMEOUT_MS = 5_000;

/** Signals that mean "stop this process"; both take the graceful path. */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export const installProcessHandlers = (input: InstallProcessHandlersInput): void => {
  if (installed) return;
  installed = true;

  const rawExit: ExitFn = input.exit ?? ((code) => process.exit(code));
  // `process.exit` never returns, but an injected double does. Guard so
  // the hard-timeout arm and the `finally` arm cannot both terminate.
  const exit: ExitFn = (code) => {
    if (exited) return;
    exited = true;
    rawExit(code);
  };
  const escalateExitCode = (code: number): void => {
    pendingExitCode = Math.max(pendingExitCode, code);
  };

  /**
   * Run `gracefulShutdown` under a hard timeout, then exit with the
   * escalated status. Only the first call owns the timer and the exit;
   * a later trigger still raises {@link pendingExitCode}, so a fatal
   * fault that lands mid-teardown is not reported as a clean stop.
   *
   * `Promise.resolve().then(...)` normalises a synchronous throw inside
   * `gracefulShutdown` into a rejected promise so the `.catch` arm
   * always runs — without this, a sync throw would bypass `.catch` and
   * only the hard timeout would force the exit.
   */
  const beginShutdown = (exitCode: number, event: string): void => {
    escalateExitCode(exitCode);
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => {
      input.logger.fatal(
        { timeoutMs: SHUTDOWN_HARD_TIMEOUT_MS, event },
        'graceful shutdown hit hard timeout; forcing exit',
      );
      exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    // Defensive: do not let the timer keep the process alive longer than necessary.
    timer.unref?.();

    Promise.resolve()
      .then(() => input.gracefulShutdown())
      .catch((shutdownErr: unknown) => {
        input.logger.fatal(
          {
            err: shutdownErr instanceof Error ? shutdownErr : new Error(String(shutdownErr)),
            event,
          },
          'graceful shutdown threw; forcing exit',
        );
        // Teardown did not complete: the port may still be bound and the
        // database connections may still be open, so this is not a clean
        // stop however it was triggered.
        escalateExitCode(1);
      })
      .finally(() => {
        clearTimeout(timer);
        exit(pendingExitCode);
      });
  };

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    unhandledRejectionCount += 1;
    input.logger.error(
      {
        err: reason instanceof Error ? reason : new Error(String(reason)),
        promise: String(promise),
        unhandledRejectionCount,
      },
      'unhandledRejection',
    );
  });

  process.on('uncaughtException', (err: Error) => {
    // A transient outbound-socket failure can surface here when an
    // EventEmitter (e.g. discord.js's gateway) emits 'error' with no
    // listener: Node rethrows it as an uncaughtException. The process
    // state is not corrupted by a connectivity blip, so log it and keep
    // running — the owning client reconnects itself. The whitelist is
    // narrow so genuine defects still fall through to the fatal path.
    if (isTransientNetworkError(err)) {
      transientNetworkErrorCount += 1;
      input.logger.error(
        { err, transientNetworkErrorCount },
        'uncaughtException: transient network error; not shutting down',
      );
      return;
    }
    input.logger.fatal({ err }, 'uncaughtException; initiating graceful shutdown');
    // Re-entrancy guard: a secondary uncaughtException while shutdown
    // is already running should NOT arm a second timer or kick off a
    // second shutdown attempt. The first timer + finally will still
    // force-exit within SHUTDOWN_HARD_TIMEOUT_MS.
    beginShutdown(1, 'uncaughtException');
  });

  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) {
        // The operator asked twice (a second Ctrl+C). Stop waiting for
        // the in-flight teardown and terminate immediately.
        input.logger.fatal(
          { signal },
          'second termination signal received during shutdown; exiting immediately',
        );
        exit(1);
        return;
      }
      input.logger.info({ signal }, 'termination signal received; initiating graceful shutdown');
      beginShutdown(0, signal);
    });
  }
};

/** Test-only — reset module state between cases. */
export const __resetProcessHandlersForTests = (): void => {
  installed = false;
  unhandledRejectionCount = 0;
  transientNetworkErrorCount = 0;
  shuttingDown = false;
  pendingExitCode = 0;
  exited = false;
};

export const getUnhandledRejectionCount = (): number => unhandledRejectionCount;

/**
 * Count of `uncaughtException`s that were downgraded as transient
 * network blips (logged + tolerated rather than fatal). Surfaced for a
 * /health endpoint so operators can see connectivity churn.
 */
export const getTransientNetworkErrorCount = (): number => transientNetworkErrorCount;
