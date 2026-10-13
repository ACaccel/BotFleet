import type { ArchiveGapReason, ArchiveProgressSnapshot } from './progress';

/**
 * Storage contracts contain only approved display data, never Discord SDK objects.
 * Field names follow discord.js; the full field reference is `docs/message-archive.md`.
 */
/** Compile-time type equality, used to pin contracts that must stay in sync. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Keys a type requires (not optional). */
export type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
/** Version of every document in `messages`; documents of older versions are never read. */
export const ARCHIVE_SCHEMA_VERSION = 3;
/** Most previous versions kept per message; older ones are dropped and counted. */
export const ARCHIVE_EDIT_HISTORY_LIMIT = 50;
export interface ArchiveUser {
  id: string;
  username?: string;
  /** `null` when the user has no global display name. */
  globalName?: string | null;
  bot?: boolean;
}
export interface ArchiveEmoji {
  /** Absent for a Unicode emoji, whose `name` is the emoji itself. */
  id?: string;
  name?: string;
  animated?: boolean;
}
export interface ArchiveAttachment {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  flags?: number;
  /** Discord CDN location without the expiring signature (`ex`, `is`, `hm`). */
  url?: string;
}
export interface ArchiveSticker {
  id?: string;
  name?: string;
  format?: number;
}
export interface ArchiveEmbedMedia {
  url?: string;
  width?: number;
  height?: number;
}
export interface ArchiveEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: number;
  author?: { name?: string; url?: string };
  footer?: { text?: string };
  provider?: { name?: string; url?: string };
  image?: ArchiveEmbedMedia;
  thumbnail?: ArchiveEmbedMedia;
  video?: ArchiveEmbedMedia;
  fields?: { name?: string; value?: string; inline?: boolean }[];
}
export interface ArchiveReaction {
  emoji: ArchiveEmoji;
  /** Total including super reactions. */
  count?: number;
  countDetails?: { normal?: number; burst?: number };
}
export interface ArchivePoll {
  question?: { text?: string };
  answers?: { id?: number; text?: string; emoji?: ArchiveEmoji; voteCount?: number }[];
  expiresTimestamp?: number;
  allowMultiselect?: boolean;
  resultsFinalized?: boolean;
}
export interface ArchiveInteractionMetadata {
  id?: string;
  type?: number;
  user?: ArchiveUser;
  targetUserId?: string;
  targetMessageId?: string;
  interactedMessageId?: string;
}
export interface ArchiveMentions {
  users?: string[];
  roles?: string[];
  channels?: string[];
  everyone?: boolean;
}
export interface ArchiveReference {
  guildId?: string;
  channelId?: string;
  messageId?: string;
  type?: number;
  /** Author of the referenced message; absent when Discord no longer provides it. */
  authorId?: string;
}
interface ArchiveThreadSummary {
  id?: string;
  name?: string;
  type?: number;
}
/** Recursive Discord component tree, normalized to a bounded depth. */
export type ArchiveComponent = Record<string, unknown>;
export interface ArchiveMessageSnapshot {
  type?: number;
  flags?: number;
  content?: string;
  createdTimestamp?: number;
  editedTimestamp?: number | null;
  attachments?: ArchiveAttachment[];
  stickers?: ArchiveSticker[];
  embeds?: ArchiveEmbed[];
  components?: ArchiveComponent[];
}
/** Why a bot, webhook or unclassified message was kept; human messages carry none. */
interface ArchivePolicyRecord {
  version: string;
  ruleId?: string;
  reason: string;
}
/**
 * One observation of a message, normalized for storage. An absent field was not
 * observed (unknown); an empty array or `null` is authoritative emptiness.
 */
export interface ArchiveSnapshot {
  /** The Discord message ID. */
  _id: string;
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  channelId: string;
  createdTimestamp: number;
  observedAt: number;
  author?: ArchiveUser;
  webhookId?: string;
  applicationId?: string;
  interactionMetadata?: ArchiveInteractionMetadata;
  type?: number;
  flags?: number;
  content?: string;
  editedTimestamp?: number | null;
  attachments?: ArchiveAttachment[];
  stickers?: ArchiveSticker[];
  embeds?: ArchiveEmbed[];
  components?: ArchiveComponent[];
  reactions?: ArchiveReaction[];
  mentions?: ArchiveMentions;
  reference?: ArchiveReference;
  thread?: ArchiveThreadSummary;
  poll?: ArchivePoll | null;
  messageSnapshots?: ArchiveMessageSnapshot[];
  /** Fields the policy deliberately does not keep. */
  excludedFields?: ArchiveExcludableField[];
  policy?: ArchivePolicyRecord;
}
/** Fields every observation carries; they identify and date the message. */
type ArchiveIdentityField =
  | '_id'
  | 'schemaVersion'
  | 'channelId'
  | 'createdTimestamp'
  | 'observedAt';
/** Observed fields a policy may deliberately leave out. */
export type ArchiveExcludableField = Exclude<
  keyof ArchiveSnapshot,
  ArchiveIdentityField | 'excludedFields' | 'policy'
>;
/**
 * Membership stream of one reaction: its key (`reactionKey`) and `0` for normal or
 * `1` for burst (Super Reaction) users.
 */
export type ReactionStreamKey = `${string}:${0 | 1}`;
/** A version replaced by an edit; editing changes only these fields. */
export interface ArchiveEdit {
  /** The version's own edit time; `null` for the original. */
  editedTimestamp?: number | null;
  observedAt: number;
  content?: string;
  attachments?: ArchiveAttachment[];
  embeds?: ArchiveEmbed[];
  components?: ArchiveComponent[];
}
interface ArchiveReactionGeneration {
  generation: string;
  observedAt: number;
  complete: boolean;
}
/** A stored `messages` document: the latest observation plus backup metadata. */
export interface ArchiveMessage extends ArchiveSnapshot {
  /** Previous versions, oldest first. */
  editHistory?: ArchiveEdit[];
  editHistoryDropped?: number;
  /** Published membership generation per reaction stream. */
  reactionGenerations?: Partial<Record<ReactionStreamKey, ArchiveReactionGeneration>>;
  reactionsFreshAt?: number;
  reactionsStaleAt?: number;
  deletedAt?: number;
}
export interface NormalizeContext {
  /** Used when the payload omits `channel_id`. */
  channelId?: string;
  observedAt: number;
}
/** Channel details captured with a live message, before `archive_channels` may know it. */
export interface ArchiveChannelHint {
  name?: string;
  type?: number;
  parentId?: string;
  everyoneCanView?: boolean;
}
/** Payload of a `snapshot` inbox event. */
interface ArchiveSnapshotPayload {
  snapshot: ArchiveSnapshot;
  channel?: ArchiveChannelHint;
  /**
   * The snapshot is a complete MESSAGE_CREATE payload: it is stored without a REST
   * read, with an empty reaction list as of its observation.
   */
  create?: true;
}
/**
 * What a reaction or poll vote event changed: one reaction's list (`emojiKey`, of
 * one type when `type` is set), every list (`all`), or only the poll counts (`poll`).
 */
export type ArchiveReactionTarget =
  | { scope: 'emoji'; emojiKey: string; type?: 0 | 1 }
  | { scope: 'all' }
  | { scope: 'poll' };
/** Delivery state the inbox keeps for every event. */
export interface ArchiveInboxDelivery {
  eventId: string;
  observedAt: number;
  /** `dead` events exhausted their retries; they are retained for inspection and never claimed. */
  state: 'pending' | 'processing' | 'complete' | 'dead';
  claimToken?: string;
  leaseUntil?: number;
  /** Counted failed reconciliations; capacity, transient and superseded outcomes do not count. */
  attempts: number;
  /** Consecutive claims without a recorded outcome; detects crashes and expired leases. */
  claims?: number;
  /** First failure that was not capacity pressure; bounds transient retries by wall-clock time. */
  firstFailedAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
  /** A Date so a TTL index can expire dead letters. */
  deadAt?: Date;
  /** Periodic run that reported this dead letter as a coverage gap. */
  tracedRunId?: string;
}
/** What an inbox event carries, by kind; validated when the event is claimed. */
type ArchiveInboxContent =
  | { kind: 'snapshot'; messageId: string; channelId: string; payload: ArchiveSnapshotPayload }
  | { kind: 'delete'; messageId: string; channelId: string; payload: Record<string, never> }
  /** Without a target every reaction list of the message is reread. */
  | {
      kind: 'reaction';
      messageId: string;
      channelId: string;
      payload: { target?: ArchiveReactionTarget };
    }
  | { kind: 'gap'; messageId?: undefined; channelId?: string; payload: { reason?: string } };
export type ArchiveInboxEntry = ArchiveInboxDelivery & ArchiveInboxContent;
/** An event as captured, before the inbox adds its delivery state. */
export type ArchiveInboxDraft = Pick<ArchiveInboxDelivery, 'eventId' | 'observedAt'> &
  ArchiveInboxContent;
/** The stored `archive_inbox` document shape, before validation. */
export type ArchiveInboxDocument = ArchiveInboxDelivery & {
  kind: ArchiveInboxContent['kind'];
  messageId?: string;
  channelId?: string;
  payload: Record<string, unknown>;
};
/** Work a record in `archive_jobs` describes. */
export const ARCHIVE_JOB_COMMANDS = ['full-backup', 'periodic'] as const;
export const ARCHIVE_JOB_STATUSES = [
  'queued',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
] as const;
export type ArchiveJobStatus = (typeof ARCHIVE_JOB_STATUSES)[number];
/** A full backup that holds the guild's single active slot. */
export const ARCHIVE_JOB_ACTIVE = [
  'queued',
  'running',
] as const satisfies readonly ArchiveJobStatus[];
/** Finished states; `cancelled` is a stopped full backup or an interrupted periodic pass. */
export const ARCHIVE_JOB_TERMINAL = [
  'complete',
  'partial',
  'failed',
  'cancelled',
] as const satisfies readonly ArchiveJobStatus[];
/** Finished but unfinished work: the newest such full backup can resume. */
export const ARCHIVE_JOB_RESUMABLE = [
  'cancelled',
  'partial',
  'failed',
] as const satisfies readonly ArchiveJobStatus[];
export type ArchiveTerminalStatus = (typeof ARCHIVE_JOB_TERMINAL)[number];
// Every status is active or terminal, never both; resumable states are terminal.
const statusesCovered: Equal<
  (typeof ARCHIVE_JOB_ACTIVE)[number] | ArchiveTerminalStatus,
  ArchiveJobStatus
> = true;
const resumableTerminal: Equal<
  Extract<(typeof ARCHIVE_JOB_RESUMABLE)[number], ArchiveTerminalStatus>,
  (typeof ARCHIVE_JOB_RESUMABLE)[number]
> = true;
void statusesCovered;
void resumableTerminal;
export const isArchiveTerminalStatus = (
  status: ArchiveJobStatus,
): status is ArchiveTerminalStatus =>
  (ARCHIVE_JOB_TERMINAL as readonly ArchiveJobStatus[]).includes(status);
/** Scan kinds with separate per-channel checkpoints. */
export type ArchiveScanKind = 'full-backup' | 'periodic';
/** Access states of `archive_channels`. */
export const ARCHIVE_CHANNEL_ACCESS = ['readable', 'denied', 'unknown', 'deleted'] as const;
/** Recurring workload of one channel, used to estimate periodic passes. */
export interface PeriodicHistory {
  version?: 2;
  policyHash?: string;
  lastCutoff: number;
  windowMs: number;
  scanned: number;
  elapsedMs: number;
  samples: number;
}
/** Where a channel's history scan of one kind stands. */
export interface ArchiveHistoryCheckpoint {
  runId: string;
  cutoff: number;
  before: string;
  latest?: string;
  lower?: string;
  complete: boolean;
  scanned?: number;
  admitted?: number;
  pageAdmitted?: number;
  pageSequence?: number;
  startedAt?: number;
  estimatePrevious?: PeriodicHistory;
  /** Outcome counters, so a resumed scan reports the whole run. */
  statistics?: {
    messages: ArchiveProgressSnapshot['messages'];
    reactions: number;
    staleReactions?: number;
  };
}

/** The fixed upper bound of a full backup, kept across stops and restarts. */
interface ArchiveFullBackupOptions {
  cutoff: number;
}
/** A finished full backup; the rebuild tools read `cutoff` (`tools/db` archive-legacy). */
export interface ArchiveFullBackupResult {
  cutoff: number;
  status: ArchiveTerminalStatus;
  counts?: Record<string, number>;
  /** Known coverage gaps; they never block completion. */
  gaps?: string[];
  /** Blocking failures or the thrown error. */
  issues?: string[];
  reason?: ArchiveGapReason;
  progress?: ArchiveProgressSnapshot;
}
/** The public panel that follows a full backup. */
interface ArchiveJobNotification {
  channelId: string;
  messageId?: string;
  /** A detail page shown on the panel; progress updates leave it alone. */
  view?: 'progress' | 'gaps';
  /** Terminal status already shown on the panel. */
  deliveredStatus?: ArchiveTerminalStatus;
  /** Failed result deliveries and when the next one may be tried. */
  attempts?: number;
  retryAt?: number;
}
interface ArchiveJobBase {
  jobId: string;
  requestId: string;
  guildId: string;
  runId?: string;
  cancelRequested: boolean;
  createdAt: number;
  /** When the work first started; kept across resumes. */
  startedAt?: number;
  finishedAt?: number;
}
/** A full backup: queued, running, stopped or finished. */
export interface ArchiveFullBackupJob extends ArchiveJobBase {
  command: 'full-backup';
  options: ArchiveFullBackupOptions;
  status: ArchiveJobStatus;
  /** Saved progress while running; the final result once finished. */
  result?: Partial<ArchiveFullBackupResult>;
  /** Set while queued or running; a unique index allows one per guild. */
  activeSlot?: 'full-backup';
  /** Continuity the backup was planned against; set when it first starts. */
  origin?: ArchiveRunOrigin;
  /** When the current run of the job started (first start or latest resume). */
  resumedAt?: number;
  claimToken?: string;
  leaseUntil?: number;
  notification?: ArchiveJobNotification;
}
interface ArchivePeriodicRecordResult {
  cutoff: number;
  counts?: Record<string, number>;
  gaps?: string[];
  issueCount: number;
}
/** A finished periodic pass, written once for `/archive status`; never queued. */
export interface ArchivePeriodicRecord extends ArchiveJobBase {
  command: 'periodic';
  options: { cutoff: number; full: boolean };
  status: ArchiveTerminalStatus;
  result: ArchivePeriodicRecordResult;
}
export type ArchiveJob = ArchiveFullBackupJob | ArchivePeriodicRecord;

/** A full backup holding the active slot. */
export type ArchiveActiveBackup = ArchiveFullBackupJob & {
  status: (typeof ARCHIVE_JOB_ACTIVE)[number];
};
/** A stopped or failed full backup. */
export type ArchiveResumableBackup = ArchiveFullBackupJob & {
  status: (typeof ARCHIVE_JOB_RESUMABLE)[number];
};
/** A full backup that is queued or running. */
export const isActiveBackup = (job: ArchiveJob | undefined): job is ArchiveActiveBackup =>
  job?.command === 'full-backup' &&
  (ARCHIVE_JOB_ACTIVE as readonly ArchiveJobStatus[]).includes(job.status);
/** A stopped or failed full backup; only the newest one may resume. */
export const isResumableBackup = (job: ArchiveJob | undefined): job is ArchiveResumableBackup =>
  job?.command === 'full-backup' &&
  (ARCHIVE_JOB_RESUMABLE as readonly ArchiveJobStatus[]).includes(job.status);
/** The cutoff a job or record covered, preferring its saved result. */
export const archiveJobCutoff = (job: ArchiveJob): number | undefined => {
  const cutoff = job.result?.cutoff ?? job.options.cutoff;
  return typeof cutoff === 'number' && Number.isSafeInteger(cutoff) ? cutoff : undefined;
};

/** Channel access states that leave a source out of the backup. */
export const ARCHIVE_GAP_ACCESS = [
  'denied',
  'unknown',
  'deleted',
] as const satisfies readonly ArchiveChannel['access'][];
export type ArchiveGapAccess = (typeof ARCHIVE_GAP_ACCESS)[number];
// Every access state except `readable` is a gap.
const gapAccessCovered: Equal<
  ArchiveGapAccess,
  Exclude<ArchiveChannel['access'], 'readable'>
> = true;
void gapAccessCovered;
export const isArchiveGapAccess = (access: ArchiveChannel['access']): access is ArchiveGapAccess =>
  (ARCHIVE_GAP_ACCESS as readonly string[]).includes(access);

/** Read models of `/archive status`. */
export interface ArchiveGapChannel {
  readonly channelId: string;
  readonly name: string;
  readonly access: ArchiveGapAccess;
}
export interface ArchiveCoverage {
  readonly readable: number;
  readonly gaps: Readonly<Record<ArchiveGapChannel['access'], number>>;
}
export interface ArchiveHostUsage {
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly measuredAt: number;
  /** When the reused size of the project, runtime and additional roots was walked. */
  readonly stableMeasuredAt?: number;
}
/** A periodic run is running, or ended as its last pass did. */
type ArchivePeriodicRunStatus = 'running' | 'complete' | 'partial' | 'cancelled';
export interface ArchivePeriodicRun {
  _id: string;
  runId: string;
  cutoff: number;
  full: boolean;
  status: ArchivePeriodicRunStatus;
  result?: Record<string, unknown>;
  progress?: ArchiveProgressSnapshot;
  /** When the current pass started; `cutoff` is when the run was created. */
  passStartedAt?: number;
  /** Passes that reached the end of the scan with blocking failures; bounds resumes. */
  blockedPasses?: number;
  /** Consecutive passes that threw; drives the retry backoff and resets at a scan end. */
  consecutiveFailures?: number;
  origin?: ArchiveRunOrigin;
  /** Sources an incremental run must scan fully, carried over from a closed run. */
  fullChannelIds?: string[];
  /**
   * Incremental runs rescan every source from at least this time (minus the overlap
   * window), even when its watermark is newer: Gateway events after it may be missing.
   */
  rescanFrom?: number;
  /**
   * An incremental run rereads every message after this time: the previous coverage
   * end (or `rescanFrom` when earlier) minus the overlap window. Each source starts
   * at or before it. Absent for full runs and when nothing was covered before.
   */
  coverageFrom?: number;
}
/** Continuity state a periodic run or full backup was planned against. */
export interface ArchiveRunOrigin {
  /** Worker boot that created the run; diagnostic only. */
  bootId: string;
  /** Durable Gateway gap version; a full run reconciles gaps up to it. */
  gapVersion: number;
  /** Latest continuity break index; a complete run settles every break up to it. */
  breakIndex: number;
}
/**
 * Gateway events after `start` may be missing. A guild-wide break (restart or
 * replaced session, `channelId: null`) bounds every source's incremental rescan; a
 * channel break (visibility lost or regained) makes that source scan fully.
 */
export interface ArchiveContinuityBreak {
  /** Increasing per guild; a run created after break `index` settles it on completion. */
  index: number;
  start: number;
  channelId: string | null;
}
/**
 * Durable Gateway capture continuity of one guild (`archive_gateway_continuity`,
 * `_id: 'current'`), written by the archive worker that owns the guild.
 */
export interface ArchiveGatewayContinuity {
  /** Worker boot that wrote the record; later writes are conditional on it. */
  bootId: string;
  /**
   * Start of the current lossless capture window: every Gateway event observed at or
   * after it has been captured. Restarts, replaced sessions and Gateway gaps move it
   * forward.
   */
  continuousSince: number;
  /** Latest time through which capture was confirmed lossless; never decreases within a boot. */
  confirmedAt: number;
  /** A Gateway gap occurred that no completed full run has reconciled yet. */
  fullRequired: boolean;
  /** Advances once per Gateway gap; a full run reconciles only gaps up to its origin version. */
  gapVersion: number;
  /** Index of the latest recorded break. */
  breakIndex: number;
  /** Breaks no completed run has settled yet. */
  breaks: ArchiveContinuityBreak[];
}
export interface ArchiveChannel {
  channelId: string;
  /** Absent until a discovery pass or channel event names the channel. */
  name?: string;
  type?: number;
  parentId?: string;
  observedAt: number;
  /** Records are kept after a channel is deleted, so readers can still name it. */
  access: (typeof ARCHIVE_CHANNEL_ACCESS)[number];
  /**
   * Whether `@everyone` could view the channel when last checked; kept after
   * deletion. A thread's value can lag behind its parent's permissions, so readers
   * judge threads through the parent's record.
   */
  everyoneCanView?: boolean;
  /** History checkpoints per scan kind, so one kind never resets the other's progress. */
  checkpoints?: Partial<Record<ArchiveScanKind, ArchiveHistoryCheckpoint>>;
  discovery?: {
    runId: string;
    passes?: string[];
    gaps: string[];
    verifiedAt: number;
    scope?: string;
  };
}
