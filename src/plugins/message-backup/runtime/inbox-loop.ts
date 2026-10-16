/** First wait after a failed round; it doubles per consecutive failure. */
const ARCHIVE_INBOX_RETRY_BASE_MS = 1000;
/** Longest wait after failed rounds. */
const ARCHIVE_INBOX_RETRY_MAX_MS = 60_000;

/** One inbox round: how many events it retired and whether it joined a round already running. */
export interface ArchiveInboxRound {
  readonly retired: number;
  readonly joined: boolean;
}

interface ArchiveInboxLoopOptions {
  readonly round: () => Promise<ArchiveInboxRound>;
  /** Events a round may retire; a full round is followed by another at once. */
  readonly roundSize: number;
  /** Wait between rounds while nothing new is captured; deferred retries come due meanwhile. */
  readonly idleMs: number;
  /** Ends the loop at its next wait or round boundary. */
  readonly signal: AbortSignal;
  /** A failed round, with the number of consecutive failures. */
  readonly onFailure: (error: unknown, failures: number) => void;
  /** First wait after a failed round (default one second); tests shorten it. */
  readonly retryBaseMs?: number;
}

/**
 * A guild's inbox reducer, independent of history scans. A round runs at once again
 * while events remain, a capture arrived during it, or it only joined a round that
 * another caller started (which may have claimed before that capture); otherwise
 * the loop waits `idleMs` or until woken. A failed round waits one second, doubling
 * to a minute, and success resets the backoff.
 */
export class ArchiveInboxLoop {
  private captured = false;
  private wakeIdle: (() => void) | undefined;

  public constructor(private readonly options: ArchiveInboxLoopOptions) {}

  /** Records a capture: an idle loop runs a round at once, a running one runs another. */
  public wake(): void {
    this.captured = true;
    this.wakeIdle?.();
  }

  /** Runs until the signal aborts. */
  public async run(): Promise<void> {
    const { signal } = this.options;
    let failures = 0;
    while (!signal.aborted) {
      this.captured = false;
      let next: ArchiveInboxRound | undefined;
      try {
        next = await this.options.round();
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        this.options.onFailure(error, failures);
      }
      if (
        next !== undefined &&
        (next.retired >= this.options.roundSize || next.joined || this.captured)
      )
        continue;
      await this.idle(
        failures === 0
          ? this.options.idleMs
          : Math.min(
              ARCHIVE_INBOX_RETRY_MAX_MS,
              (this.options.retryBaseMs ?? ARCHIVE_INBOX_RETRY_BASE_MS) * 2 ** (failures - 1),
            ),
        failures === 0,
      );
    }
  }

  /** Waits `ms`; a capture ends the wait unless it follows a failure. */
  private idle(ms: number, wakeable: boolean): Promise<void> {
    const { signal } = this.options;
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (this.wakeIdle === done) this.wakeIdle = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      if (signal.aborted || (wakeable && this.captured)) {
        done();
        return;
      }
      signal.addEventListener('abort', done, { once: true });
      if (wakeable) this.wakeIdle = done;
    });
  }
}
