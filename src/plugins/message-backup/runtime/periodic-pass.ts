import type { ArchiveGapReason } from '../../../core/archive/progress';
import type {
  ArchivePassHealth,
  ArchivePassOutcome,
  ArchivePeriodicSummary,
} from '../../../core/archive/schedule';

/**
 * `reason` classifies the first blocking failure of a partial or failed pass;
 * `summary` is set for a pass that reached its end or failed after its run began.
 */
export type PeriodicPassResult =
  | {
      readonly outcome: Exclude<ArchivePassOutcome, { kind: 'failed' }>;
      readonly reason?: ArchiveGapReason;
      readonly summary?: ArchivePeriodicSummary;
    }
  | {
      readonly outcome: Extract<ArchivePassOutcome, { kind: 'failed' }>;
      readonly error: unknown;
      readonly reason: ArchiveGapReason;
      readonly summary?: ArchivePeriodicSummary;
    };
/** How a finished (or rejected, when `undefined`) periodic pass affects schedule health. */
export const archivePassHealth = (pass: PeriodicPassResult | undefined): ArchivePassHealth => {
  if (pass === undefined) return { kind: 'failure', reason: 'other' };
  switch (pass.outcome.kind) {
    case 'complete':
      return { kind: 'success' };
    case 'partial':
    case 'failed':
      return { kind: 'failure', reason: pass.reason ?? 'other' };
    // Only capture-only mode skips a pass; it is not backing anything up.
    case 'skipped':
      return { kind: 'failure', reason: 'other' };
    case 'interrupted':
      return { kind: 'neutral' };
    default: {
      const unreachable: never = pass.outcome;
      throw new TypeError(`Unknown archive pass outcome ${JSON.stringify(unreachable)}`);
    }
  }
};
