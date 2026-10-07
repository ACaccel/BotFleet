type RepairCommand =
  | 'audit'
  | 'plan'
  | 'apply'
  | 'resume'
  | 'verify'
  | 'rollback'
  | 'accept'
  | 'backfill'
  | 'migrate-timestamp';

export interface RepairRequest {
  readonly jobId: string;
  readonly guildId: string;
  readonly command: RepairCommand;
  readonly options: Readonly<Record<string, unknown>>;
  readonly runId?: string;
}

export type RepairDocument = Record<string, unknown> & { _id: unknown };

export interface RepairResult {
  readonly status: 'complete' | 'partial' | 'failed' | 'cancelled';
  readonly runId?: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly issues: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

interface RepairProgressMetadata {
  readonly quality: 'exact' | 'estimated' | 'unknown';
  readonly unit: 'documents' | 'operations' | 'checks';
  readonly substep: string;
  readonly candidates?: Readonly<{ timestamps: number; duplicates: number; excluded: number }>;
  readonly outcomes?: Readonly<{ restored: number; conflicts: number; skipped: number }>;
}

export interface RepairBackfillContext {
  readonly runId: string;
  readonly cutoff: number;
  readonly jobId: string;
  readonly applyMutation: (
    collection: string,
    before: RepairDocument | null,
    after: RepairDocument | null,
    reason: string,
  ) => Promise<void>;
}

/** All collaborators are supplied exclusively by the msg-archive composition root. */
export interface RepairDependencies {
  readonly policyHash: string;
  readonly schemaHash: string;
  readonly classify: (document: RepairDocument) => 'included' | 'excluded' | 'unknown';
  readonly assertOwner: () => Promise<void>;
  readonly ensureCapacity: (additionalBytes: number) => Promise<void>;
  readonly withCapacity?: <T>(additionalBytes: number, operation: () => Promise<T>) => Promise<T>;
  readonly withMaintenance: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly isCancelled: (jobId: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly planningBatchDocuments?: number;
  readonly planningBatchBytes?: number;
  readonly backfill: (context: RepairBackfillContext) => Promise<RepairResult>;
  readonly onProgress?: (
    phase: 'repair' | 'verification',
    committed: number,
    total?: number,
    stream?: string,
    metadata?: RepairProgressMetadata,
  ) => Promise<void>;
  readonly now?: () => number;
}
