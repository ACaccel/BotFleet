import type {
  ArchiveChannel,
  ArchiveHistoryCheckpoint,
  ArchivePeriodicRun,
  ArchiveScanKind,
} from '../../../core/archive/types';
import type { ArchiveGapReason } from '../../../core/archive/progress';
import { PERMISSION_GAPS } from '../flow/discovery';
import type { ChannelLocator } from './channel-location';
import type { GatewayContinuity } from './continuity';
import type { ArchiveInboxReducer } from './inbox-reducer';
import type { HistoryIngestor } from './ingestor';
import type { SourceObservations } from './observations';
import type { ProgressPublisher } from './progress-publisher';

/** Scan outcome: blocking issues and known coverage gaps are reported separately. */
export interface ArchiveScanResult {
  readonly status: 'complete' | 'partial' | 'cancelled';
  readonly counts: Readonly<Record<string, number>>;
  readonly details: Readonly<Record<string, unknown>>;
  /** Blocking failures; any entry keeps the run partial. */
  readonly issues: readonly string[];
  /** Known coverage gaps that do not block completion. */
  readonly gaps: readonly string[];
  /** Why the pass stopped before its end (pause, preemption, shutdown or cancellation). */
  readonly interruption?: string;
}

/** Per-run additions to an incremental scan's lower bounds. */
export type ArchiveScanCoverage = Pick<ArchivePeriodicRun, 'fullChannelIds' | 'rescanFrom'>;

/**
 * What a scan is for. A periodic pass scans fully or incrementally, may be paused
 * by its schedule and widens its lower bounds by `coverage`; a full backup always
 * scans fully under its job's stop requests. Each kind keeps its own checkpoints.
 */
export type ScanMode =
  | {
      readonly kind: 'periodic';
      readonly full: boolean;
      /** Resolves `false` once the schedule no longer allows the pass. */
      readonly shouldContinue?: () => Promise<boolean>;
      readonly coverage?: ArchiveScanCoverage;
    }
  | { readonly kind: 'full-backup'; readonly jobId: string };

/** One scan: its run identity, fixed cutoff and mode. */
export interface ScanRequest {
  readonly runId: string;
  readonly cutoff: number;
  readonly mode: ScanMode;
}

/** What a scan needs from the worker's other collaborators. */
export interface ScanRunnerDependencies {
  readonly continuity: Pick<GatewayContinuity, 'recordChannelBreak'>;
  readonly locator: Pick<ChannelLocator, 'locationVisibility'>;
  readonly ingestor: Pick<HistoryIngestor, 'ingest' | 'ingestPage'>;
  readonly observations: Pick<SourceObservations, 'read'>;
  readonly progress: Pick<ProgressPublisher, 'notify'>;
  readonly inbox: Pick<ArchiveInboxReducer, 'beginPass' | 'drainInboxSafely'>;
}

const permissionReason = new RegExp(
  ['permission', 'forbidden', 'access', 'denied', '403', ...PERMISSION_GAPS].join('|'),
  'i',
);

/** A channel's checkpoint for one scan kind. */
export const readCheckpoint = (
  channel: ArchiveChannel | undefined,
  kind: ArchiveScanKind,
): ArchiveHistoryCheckpoint | undefined => channel?.checkpoints?.[kind];

/** Classifies a blocking failure or gap reason for progress and pass health. */
export const archiveGapReason = (reason: string): ArchiveGapReason =>
  permissionReason.test(reason)
    ? 'permission'
    : /capacity|storage|budget/i.test(reason)
      ? 'capacity'
      : /conflict|changed/i.test(reason)
        ? 'conflict'
        : /thread|discovery|inventory|gap/i.test(reason)
          ? 'discovery'
          : 'other';
