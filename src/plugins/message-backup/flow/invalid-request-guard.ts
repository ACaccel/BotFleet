import { ARCHIVE_INVALID_REQUESTS } from '../../../core/archive/limits';

/** How close the process is to Discord's invalid-request ban. */
export type ArchiveInvalidRequestLevel = 'normal' | 'warning' | 'critical';

export interface ArchiveInvalidRequestStep {
  readonly level: ArchiveInvalidRequestLevel;
  readonly previous: ArchiveInvalidRequestLevel;
  /** Background reads admitted at once; `undefined` admits up to the concurrency. */
  readonly backgroundLimit: number | undefined;
  /**
   * The count is under `recovery` and this process has observed a whole window, so
   * Discord's own ten-minute count is low as well.
   */
  readonly settled: boolean;
}

type Thresholds = {
  readonly [K in 'warning' | 'critical' | 'recovery' | 'restoreStepMs' | 'windowMs']: number;
};

/**
 * Turns the invalid-request count of the last ten minutes into a level and a
 * background admission limit. Crossing `warning` halves the limit and `critical`
 * drops it to one; the level holds until the count falls under `recovery`, then the
 * limit doubles every `restoreStepMs` until it is lifted.
 */
export class ArchiveInvalidRequestGuard {
  private level: ArchiveInvalidRequestLevel = 'normal';
  private limit: number | undefined;
  private restoreAt = 0;
  private readonly startedAt: number;

  public constructor(
    private readonly concurrency: number,
    now: number,
    private readonly thresholds: Thresholds = ARCHIVE_INVALID_REQUESTS,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('invalid-archive-concurrency');
    this.startedAt = now;
  }

  public observe(count: number, now: number): ArchiveInvalidRequestStep {
    const { warning, critical, recovery, restoreStepMs, windowMs } = this.thresholds;
    const previous = this.level;
    this.level =
      count >= critical
        ? 'critical'
        : count >= warning || (previous !== 'normal' && count >= recovery)
          ? 'warning'
          : 'normal';
    if (this.level === 'critical') this.limit = 1;
    else if (this.level === 'warning') this.limit = Math.max(1, Math.floor(this.concurrency / 2));
    else if (previous !== 'normal') this.restoreAt = now + restoreStepMs;
    else if (this.limit !== undefined && now >= this.restoreAt) {
      const doubled = this.limit * 2;
      this.limit = doubled >= this.concurrency ? undefined : doubled;
      this.restoreAt = now + restoreStepMs;
    }
    return {
      level: this.level,
      previous,
      backgroundLimit: this.limit,
      settled: this.level === 'normal' && count < recovery && now - this.startedAt >= windowMs,
    };
  }
}
