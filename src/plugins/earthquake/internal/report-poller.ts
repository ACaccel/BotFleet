/**
 * Polls the CWA significant-earthquake-report feed and publishes each
 * new report exactly once per process.
 *
 * Cursor discipline:
 *   - the first successful poll only *seeds* the cursor with the newest
 *     report number, so a restart never reposts reports already out;
 *   - afterwards every report numbered above the cursor is published,
 *     oldest first;
 *   - the cursor advances *before* the publish. The broadcast already
 *     isolates per-guild failures, so a throw here would mean some
 *     guilds were posted to; retrying would duplicate those posts, and a
 *     missed report is the lesser failure for an informational feed.
 *
 * Failures (network, HTTP 401, a malformed body) are logged and retried
 * on the next tick. A failure that repeats every minute is logged once
 * when it starts and once when it clears, not on every tick.
 */
import { logError, type Logger } from '../../../core/logger';
import type { CwaReport, ParsedReports } from './cwa-report';

/** Log binding identifying this poller in every line it emits. */
const COMPONENT = 'earthquake-report';

/** Collaborators the poller needs; injected so tests drive it without HTTP or Discord. */
interface ReportPollerDeps {
  readonly fetchReports: () => Promise<ParsedReports>;
  readonly publish: (report: CwaReport) => Promise<void>;
  readonly logger: Logger;
}

/** A poller whose `poll` runs one fetch-and-publish pass. */
export interface ReportPoller {
  poll(): Promise<void>;
}

/**
 * Stable description of a poll failure, used both as the log headline
 * detail and as the key that suppresses repeats. Duck-typed on the axios
 * error shape, as `infra/social-feed/platforms/error-translator.ts` does.
 */
const describeFailure = (err: unknown): string => {
  const shape = (err ?? {}) as { code?: unknown; response?: { status?: unknown }; name?: unknown };
  if (typeof shape.response?.status === 'number') return `HTTP ${shape.response.status}`;
  if (shape.name === 'ZodError') return 'invalid response body';
  if (typeof shape.code === 'string') return shape.code;
  return err instanceof Error ? err.name : 'unknown error';
};

export const createReportPoller = (deps: ReportPollerDeps): ReportPoller => {
  const logger = deps.logger.child({ component: COMPONENT });
  let lastSeen: number | undefined;
  let activeFailure: string | undefined;
  let lastRejectedKey: string | undefined;

  const reportFailure = (err: unknown): void => {
    const failure = describeFailure(err);
    if (failure === activeFailure) return;
    activeFailure = failure;
    logger.warn({ failure, err }, 'CWA earthquake report poll failed; retrying every interval');
  };

  const reportRejected = (rejected: ParsedReports['rejected']): void => {
    // The same malformed entry stays in the newest-reports window for a
    // while; log it when it appears, not on every poll.
    if (rejected.length === 0) {
      lastRejectedKey = undefined;
      return;
    }
    const key = JSON.stringify(rejected);
    if (key === lastRejectedKey) return;
    lastRejectedKey = key;
    logger.warn({ rejected }, 'Skipped malformed CWA earthquake reports');
  };

  return {
    async poll(): Promise<void> {
      let batch: ParsedReports;
      try {
        batch = await deps.fetchReports();
      } catch (err: unknown) {
        reportFailure(err);
        return;
      }
      if (activeFailure !== undefined) {
        logger.info({ failure: activeFailure }, 'CWA earthquake report poll recovered');
        activeFailure = undefined;
      }
      reportRejected(batch.rejected);

      const ordered = [...batch.reports].sort((a, b) => a.number - b.number);
      const newest = ordered.at(-1);
      // An empty answer cannot seed the cursor; seeding on the next
      // non-empty one keeps a restart from backfilling old reports.
      if (newest === undefined) return;
      if (lastSeen === undefined) {
        lastSeen = newest.number;
        logger.info(
          { lastSeen },
          'CWA earthquake report cursor seeded; not posting existing reports',
        );
        return;
      }

      for (const report of ordered) {
        if (report.number <= lastSeen) continue;
        lastSeen = report.number;
        try {
          await deps.publish(report);
        } catch (err: unknown) {
          logError(logger, null, err);
        }
      }
    },
  };
};

/** Handle for a running poll loop. */
interface ReportPollingHandle {
  /** Cancel the pending tick. A poll already in flight finishes but schedules nothing. */
  stop(): void;
}

/**
 * Run `poller.poll` now and then `intervalMs` after each poll settles.
 *
 * A self-rescheduling `setTimeout` rather than `setInterval`, mirroring
 * the social-feed loop: a slow upstream can never stack overlapping
 * polls, and the first poll is detached so it does not hold up startup.
 */
export const startReportPolling = (
  poller: ReportPoller,
  intervalMs: number,
  logger: Logger,
): ReportPollingHandle => {
  let handle: NodeJS.Timeout | undefined;
  let stopped = false;

  const tick = async (): Promise<void> => {
    handle = undefined;
    try {
      await poller.poll();
    } catch (err: unknown) {
      logError(logger, null, err);
    } finally {
      if (!stopped) {
        handle = setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    }
  };

  void tick();
  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
};
