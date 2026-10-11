import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'discord.js';
import type { ArchiveContinuityBreak } from '../../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import type { ArchivePolicy } from '../../../core/archive/policy';
import type { Logger } from '../../../core/logger';
import type { Translator } from '../../../core/i18n';
import type { GuildRegistry } from '../../../bot/guild-registry';
import type { ConnectionManager } from '../../../infra/mongo/connection-manager';
import type { GuildConnection } from '../../../persistence/connection';
import type { ArchiveContinuityRepo } from '../../../persistence/repositories/archive-continuity.repo';
import type {
  ArchiveRepos,
  ArchiveReposFactory,
  ArchiveWriterRepos,
  ArchiveWriterReposFactory,
} from '../../../persistence/repositories/archive-repos';
import { ArchivePipelineBudget } from '../flow/pipeline';
import type { ProgressNotifier, ProgressTracker } from '../flow/progress';
import type { ArchiveRestTelemetry } from '../flow/rest-telemetry';
import type { ArchiveScheduler } from '../flow/scheduler';
import type { ArchiveRuntimeConfig } from '../config';
import type { ArchiveBackupPanelPublisher, ArchiveBackupPublisherFactory } from './backup-notifier';
import type { ArchiveDirtyTracker } from './dirty-tracker';
import type { ArchiveGatewayReadiness } from './gateway-readiness';
import { classifyArchiveInboxFailure } from './inbox-failure';
import type { ArchiveInboxLoop } from './inbox-loop';
import type { ArchiveSerialWriter } from './serial-writer';
import type { ArchiveStorageMonitor } from './storage-monitor';
import type { ArchiveWorkSlot } from './work-slot';

export interface ArchiveWorkerOptions {
  client: Client;
  registry: GuildRegistry;
  connections: ConnectionManager;
  logger: Logger;
  translator: Translator;
  guildIds: readonly string[];
  config: ArchiveRuntimeConfig;
  policy: ArchivePolicy;
  backupLogEnabled?: boolean;
  /** Without it, Gateway continuity is never confirmed beyond each boot's start. */
  gateway?: ArchiveGatewayReadiness;
  /** Builds each guild's full-backup panel publisher once, when the guild opens. */
  backupNotifiers: ArchiveBackupPublisherFactory;
  /** Builds each guild's archive metadata repositories once, when the guild opens. */
  archiveRepos: ArchiveReposFactory;
  /** Builds each guild's archive writer repositories once, when the guild opens. */
  writerRepos: ArchiveWriterReposFactory;
  /** First wait between terminal-write retries (doubling); tests shorten it. */
  terminalRetryBaseMs?: number;
  /**
   * Whether each guild reduces its inbox in a background loop (default). Tests that
   * drain explicitly turn it off.
   */
  inboxLoop?: boolean;
}

/**
 * Gateway continuity of one guild (`ArchiveGatewayContinuity`), kept in memory and
 * persisted. Only `GatewayContinuity` writes it; other collaborators read it.
 */
interface ArchiveContinuityState {
  readonly repo: ArchiveContinuityRepo;
  /** Serializes continuity writes so an older snapshot never overwrites a newer one. */
  write: Promise<void>;
  /** Confirms and persists continuity periodically. */
  timer?: ReturnType<typeof setInterval>;
  /** A Gateway gap awaits a full reconciliation. */
  fullRequired: boolean;
  /** Advances only when Gateway events may have been lost; durable across boots. */
  gapVersion: number;
  /**
   * Start of the current lossless capture window. Reaction lists refreshed at or
   * after it reflect every later change through live events.
   */
  continuousSince: number;
  /** Latest time through which capture was confirmed lossless. */
  confirmedAt: number;
  /** Index of the latest continuity break. */
  breakIndex: number;
  /** Continuity breaks no completed run has settled yet. */
  breaks: ArchiveContinuityBreak[];
}

/** Progress publication of the running scan; only `ProgressPublisher` uses it. */
interface ArchivePublicationState {
  notifications?: ProgressNotifier<ArchiveProgressSnapshot>;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatWork?: Promise<void>;
  scope?: { generation: string; jobId?: string; scanId?: string };
  route?: string;
}

/** Reaction refresh bookkeeping; only `ReactionRefresher` uses it. */
interface ArchiveReactionState {
  /** In-flight refresh generations per message; garbage collection keeps them. */
  readonly generations: Map<string, Set<string>>;
  /** Recent membership read speeds, seeding the next estimate. */
  rates?: number[];
  nextGarbageAt?: number;
}

/** Inbox admission and reduction; `GatewayCapture` admits, `ArchiveInboxReducer` reduces. */
interface ArchiveInboxState {
  /** Serializes admission so the cached byte budget stays an upper bound. */
  readonly writer: ArchiveSerialWriter;
  budget?: { bytes: number; measuredAt: number };
  /** The reduction round in progress, which concurrent callers share. */
  draining?: Promise<number>;
  /** The guild's inbox loop (see `ArchiveInboxReducer.startInboxLoop`) and its run. */
  loop?: ArchiveInboxLoop;
  run?: Promise<void>;
  /** Set once the current pass has logged a deferred inbox drain. */
  drainWarned?: boolean;
}

/** One opened guild's archive state, shared by the worker's collaborators. */
export interface ArchiveGuildState {
  readonly conn: GuildConnection;
  /** Archive writer repositories: messages, inbox, reactions, channels, jobs and owner. */
  readonly repos: ArchiveWriterRepos;
  /** Archive metadata repositories: periodic run, schedule, continuity, storage, control. */
  readonly archive: ArchiveRepos;
  /** Publishes full-backup progress and results to the panel that follows the job. */
  readonly notifier: ArchiveBackupPanelPublisher;
  /** Serializes archive mutations. */
  readonly writer: ArchiveSerialWriter;
  readonly storage: ArchiveStorageMonitor;
  /** Aborted at shutdown. */
  readonly signal: AbortController;
  /** False in capture-only mode, while structural maintenance is required. */
  ready: boolean;
  readonly continuity: ArchiveContinuityState;
  readonly dirty: ArchiveDirtyTracker;
  /**
   * Dirty version of each event captured by this process, settled when the event is
   * retired. Entries leave on acknowledgement, dead-lettering or a failed inbox
   * write, so the map is bounded by this process's share of the durable inbox,
   * which `max_inbox_bytes` limits.
   */
  readonly captureVersions: Map<string, { messageId: string; version: number }>;
  /** Channel IDs `archive_channels` holds; loaded once, so live capture does not query per message. */
  knownChannels?: Set<string>;
  /** The running scan's progress. */
  progress?: ProgressTracker;
  readonly publication: ArchivePublicationState;
  readonly reactions: ArchiveReactionState;
  readonly inbox: ArchiveInboxState;
  readonly work: ArchiveWorkSlot;
}

/** Durations reported with the worker's performance log at shutdown. */
export interface ArchiveWorkerDurations {
  ownerRenewalMs: number;
  checkpointMs: number;
  shutdownDrainMs: number;
  inboxOldestAgeMs: number;
  inboxEvents: number;
  inboxLatencyMs: number;
}

/** Worker-wide services and lifecycle flags every collaborator shares. */
export class ArchiveWorkerContext {
  /** Opened guilds. */
  public readonly states = new Map<string, ArchiveGuildState>();
  /** Set once shutdown begins; no new work starts after it. */
  public stopped = false;
  /** Capture stops here; continuity is never confirmed past it. */
  public stoppedAt: number | undefined;
  public performanceReportedAt = 0;
  public readonly pipelineBudget = new ArchivePipelineBudget();
  public readonly durations: ArchiveWorkerDurations = {
    ownerRenewalMs: 0,
    checkpointMs: 0,
    shutdownDrainMs: 0,
    inboxOldestAgeMs: 0,
    inboxEvents: 0,
    inboxLatencyMs: 0,
  };
  /** Identifies this worker's in-memory Gateway state; a new instance starts a new boot. */
  public readonly bootId = randomUUID();
  public readonly policyHash: string;

  public constructor(
    public readonly options: ArchiveWorkerOptions,
    public readonly scheduler: ArchiveScheduler,
    public readonly telemetry: ArchiveRestTelemetry,
    /**
     * Opens a guild's state once; concurrent callers share the opening. This is the
     * worker's `initialize`, handed down so a collaborator reached for an unopened
     * guild (a Gateway event, a poll) can open it without holding the worker.
     */
    public readonly initialize: (guildId: string) => Promise<ArchiveGuildState>,
  ) {
    this.policyHash = createHash('sha256').update(JSON.stringify(options.policy)).digest('hex');
  }
}

/** The worker context with only the options a collaborator reads. */
export type ArchiveWorkerContextFor<K extends keyof ArchiveWorkerOptions> = Omit<
  ArchiveWorkerContext,
  'options'
> & { readonly options: Pick<ArchiveWorkerOptions, K> };

/** A pause, cancellation or shutdown observed at a scan boundary. */
export class ArchiveScanInterruptedError extends Error {}

/**
 * Programmer errors propagate instead of being retried as event failures. A
 * `TypeError` from a failed network call (for example `fetch failed`) carries a
 * transient cause and is classified as an event failure instead.
 */
export const isProgrammerError = (error: unknown): boolean =>
  (error instanceof TypeError || error instanceof ReferenceError) &&
  classifyArchiveInboxFailure(error).kind === 'retry';

/** Runs a small archive write on the guild's serialized writer under a storage reservation. */
export const mutateArchive = async <T>(
  state: ArchiveGuildState,
  operation: () => Promise<T>,
): Promise<T> => state.writer.run(() => state.storage.withReservation(4096, false, operation));
