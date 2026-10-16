import type { ArchiveObservationScope } from './dirty-tracker';
import type { ArchiveGuildState } from './worker-context';

/** The read window REST evidence came from, and whether it is still current. */
export interface SourceObservation {
  readonly since: number;
  readonly gapVersion: number;
  readonly valid: boolean;
  /** Unpins the observed message. */
  readonly release: () => void;
}

/** REST evidence read inside dirty-tracker windows, keyed by the raw object read. */
export class SourceObservations {
  private readonly observations = new WeakMap<object, SourceObservation>();

  public get(raw: object): SourceObservation | undefined {
    return this.observations.get(raw);
  }

  /**
   * Reads REST evidence inside a dirty-tracker read window. Each returned identity
   * is pinned before the window closes, so a settled Gateway event cannot hide a
   * change from this evidence; consumers release it through `release`.
   * `scope` collects releases that a consumer may never reach (discovery reads,
   * overlap messages, abandoned prefetches) so its owner can release them.
   */
  public async read<T>(
    state: ArchiveGuildState,
    operation: () => Promise<T>,
    scope?: ArchiveObservationScope,
  ): Promise<T> {
    const read = state.dirty.beginRead();
    const gapVersion = state.continuity.gapVersion;
    try {
      const result = await operation();
      for (const raw of Array.isArray(result) ? result : [result])
        if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string') {
          const unpin = state.dirty.pin(raw.id);
          const release = (): void => {
            unpin();
            scope?.remove(release);
          };
          this.observations.get(raw)?.release();
          this.observations.set(raw, {
            since: read.since,
            gapVersion,
            valid: this.unchanged(state, raw.id, read.since, gapVersion),
            release,
          });
          scope?.add(release);
        }
      return result;
    } finally {
      read.end();
    }
  }

  /** Whether REST evidence for a message read since `since` is still current. */
  public unchanged(
    state: ArchiveGuildState,
    messageId: string,
    since: number,
    gapVersion: number,
  ): boolean {
    return (
      state.continuity.gapVersion === gapVersion && !state.dirty.changedSince(messageId, since)
    );
  }

  public release(raw: object): void {
    this.observations.get(raw)?.release();
  }
}
