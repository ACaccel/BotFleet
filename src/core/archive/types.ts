import type { ArchiveProgressSnapshot } from './progress';

/** Storage contracts contain only approved display data, never Discord SDK objects. */
type ArchiveAuthorKind = 'human' | 'bot' | 'webhook' | 'unknown';
type ArchiveFieldState = 'present' | 'unknown' | 'excluded' | 'inaccessible';
type ArchiveSource = 'gateway' | 'history' | 'repair';
export interface ArchiveSourceDecision {
  policyHash: string;
  admitted: boolean;
  reason: string;
  observedAt: number;
}
export interface ArchiveGatewayObservation {
  observationId: string;
  observedAt: number;
  fieldHashes: Record<string, string>;
}
export interface ArchiveSnapshot {
  messageId: string;
  channelId: string;
  channelName: string;
  guildId: string;
  schemaVersion: 2;
  observedAt: number;
  source: ArchiveSource;
  contentVersionAt: number;
  contentHash: string;
  observationId?: string;
  versionObservationId?: string;
  gatewayObservation?: ArchiveGatewayObservation;
  presence: Record<string, ArchiveFieldState>;
  authorKind: ArchiveAuthorKind;
  archiveSourceDecision?: ArchiveSourceDecision;
  userId?: string;
  userName?: string;
  webhookId?: string;
  applicationId?: string;
  content?: string;
  timestamp?: number;
  editedTimestamp?: number | null;
  type?: number;
  flags?: number;
  parentId?: string;
  attachments?: Record<string, unknown>[];
  reactions?: Record<string, unknown>[];
  stickers?: Record<string, unknown>[];
  embeds?: Record<string, unknown>[];
  mentions?: Record<string, unknown>;
  reference?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  poll?: Record<string, unknown> | null;
  components?: Record<string, unknown>[];
  snapshots?: Record<string, unknown>[];
  deletion?: { deletedAt: number; source: string };
  policy?: { version: string; ruleId?: string; reason: string };
}
export interface NormalizeContext {
  guildId: string;
  channelId?: string;
  channelName?: string;
  parentId?: string;
  observedAt: number;
  source: ArchiveSource;
  observationId?: string;
}
export interface ArchiveInboxEntry {
  eventId: string;
  kind: 'snapshot' | 'delete' | 'reaction' | 'gap';
  messageId?: string;
  channelId?: string;
  payload: Record<string, unknown>;
  observedAt: number;
  state: 'pending' | 'processing' | 'complete';
  claimToken?: string;
  leaseUntil?: number;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}
export interface ArchiveJob {
  jobId: string;
  requestId: string;
  guildId: string;
  command:
    | 'audit'
    | 'plan'
    | 'apply'
    | 'resume'
    | 'verify'
    | 'rollback'
    | 'accept'
    | 'backfill'
    | 'migrate-timestamp'
    | 'refresh-attachment';
  options: Record<string, unknown>;
  runId?: string;
  status: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  cancelRequested: boolean;
  deleteRequestedAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  acceptedAt?: number;
  expiresAt?: number;
  claimToken?: string;
  leaseUntil?: number;
  notification?: {
    channelId: string;
    messageId?: string;
    deliveredStatus?: ArchiveJob['status'];
    nextAttemptAt?: number;
    attempts?: number;
    deliveredAt?: number;
    supersededAt?: number;
  };
}
export interface ArchivePeriodicRun {
  _id: string;
  runId: string;
  cutoff: number;
  full: boolean;
  status: string;
  result?: Record<string, unknown>;
  progress?: ArchiveProgressSnapshot;
  notification?: ArchiveJob['notification'];
}
export interface ArchiveJournal {
  journalId: string;
  runId: string;
  operationId: string;
  sequence: number;
  collection: string;
  documentId: unknown;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeHash: string;
  afterHash: string;
  state: 'planned' | 'journaled' | 'applied' | 'verified' | 'rolled-back' | 'conflict';
  reason: string;
  dependencies: string[];
  createdAt: number;
}
export interface ArchiveChannel {
  channelId: string;
  name: string;
  type: number;
  parentId?: string;
  observedAt: number;
  access: 'readable' | 'denied' | 'unknown' | 'deleted';
  checkpoint?: Record<string, unknown>;
  discovery?: {
    runId: string;
    passes?: string[];
    gaps: string[];
    verifiedAt: number;
    scope?: string;
  };
}
