/**
 * Bounded teardown for a Node HTTP server.
 *
 * `server.close()` stops accepting new connections but waits for every
 * existing one to end — including idle keep-alive sockets a browser or
 * a monitoring probe is holding open. A plugin's `onShutdown` that only
 * awaits `close` therefore stalls the whole graceful-shutdown sequence
 * until the process is killed, which is exactly the outcome the
 * SIGINT handler exists to avoid.
 */
import type { Server } from 'node:http';

/**
 * Upper bound on how long a shutdown waits for a server to close before
 * giving up and letting the rest of the teardown proceed. Kept well
 * under the process-level 5-second hard timeout so an unresponsive
 * server does not consume the entire budget.
 */
const SERVER_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Close `server`, destroying live sockets first and giving up after
 * {@link SERVER_CLOSE_TIMEOUT_MS}.
 *
 * Always resolves — a shutdown path has no useful way to handle a
 * failed close, and reporting is the caller's job via `onTimeout`.
 *
 * @param onTimeout - invoked when the deadline is reached, so the
 *   caller can record that the port may still be held.
 */
export const closeServerBounded = async (server: Server, onTimeout?: () => void): Promise<void> => {
  // Idle keep-alive sockets never end on their own; without this the
  // close callback can wait out the client's timeout, not ours.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      resolve();
    }, SERVER_CLOSE_TIMEOUT_MS);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
};
