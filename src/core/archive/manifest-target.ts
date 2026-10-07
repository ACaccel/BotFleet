import type { ArchiveManifestCategory } from './manifest-summary';
import { safeArchiveName } from './progress';

type ArchiveOperationImpact = 'insert' | 'update' | 'delete' | 'unknown';
export interface ArchiveOperationTarget {
  identity: 'known' | 'unknown';
  channelId?: string;
  messageId?: string;
  historicalName?: string;
  parentId?: string;
  sourceType?: number;
}
interface ArchiveSafeChangeValue {
  state: 'value' | 'unset' | 'unknown';
  value?: string | number;
  storageType?: 'number' | 'string';
}
export interface ArchiveOperationChange {
  field: 'lastMessageId' | 'timestamp' | 'editedTimestamp';
  before: ArchiveSafeChangeValue;
  after: ArchiveSafeChangeValue;
}
interface ArchiveOperationDependency {
  operationId: string;
  state: 'known' | 'missing' | 'unavailable';
  sequence?: number;
  executionState?: string;
}
interface ArchiveOperationSurvivor {
  documentId: string;
  evidence: 'dependency' | 'retained-record';
  operationId?: string;
  sequence?: number;
}
export interface ArchiveOperationSummary {
  operationId: string;
  documentId?: string;
  sequence: number;
  collection: string;
  state: string;
  reason: string;
  category: ArchiveManifestCategory;
  impact: ArchiveOperationImpact;
  dependencies: string[];
  beforeHash: string;
  afterHash: string;
  target: ArchiveOperationTarget;
  changes: ArchiveOperationChange[];
  dependencyReferences?: ArchiveOperationDependency[];
  dependencyReferencesComplete?: boolean;
  survivor?: ArchiveOperationSurvivor;
  survivorStatus?: 'verified' | 'unavailable' | 'not-applicable';
  policyRuleId?: string;
  policyReason?:
    | 'bot-not-allowlisted'
    | 'webhook-not-allowlisted'
    | 'rule-exclude'
    | 'guild-out-of-scope';
  quarantineReason?: string;
}
export interface ArchiveManifestGroupFilter {
  reason: string;
  collection: string;
  impact: ArchiveOperationImpact;
}
export interface ArchiveManifestGroup extends ArchiveManifestGroupFilter {
  key: string;
  category: ArchiveManifestCategory;
  operations: number;
  sourceCount: number;
  unknownSourceOperations: number;
  examples: ArchiveOperationTarget[];
  states: Record<string, number>;
}
export interface ArchiveManifestSource {
  sourceId: string;
  target: ArchiveOperationTarget;
  operations: number;
  states: Record<string, number>;
}
export type ArchiveManifestPage<T, K extends string> =
  | ({
      status: 'available';
      totalOperations: number;
      hasNext: boolean;
      hasPrevious: boolean;
      nextCursor?: string;
      previousCursor?: string;
    } & Record<K, T[]>)
  | ({
      status: 'unavailable';
      reason: 'timeout' | 'unavailable' | 'invalid-data';
      hasNext: false;
      hasPrevious: false;
    } & Record<K, T[]>);

const snowflake = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined;

/** Accept only fields that the Mongo allowlist projection explicitly supplies. */
export const safeArchiveOperationTarget = (
  data: Record<string, unknown>,
): ArchiveOperationTarget => {
  const channelId = snowflake(data['sourceId']);
  const messageId = snowflake(data['messageId']);
  const parentId = snowflake(data['parentId']);
  const historicalName = safeArchiveName(data['historicalName']);
  const sourceType = data['sourceType'];
  return {
    identity: channelId === undefined ? 'unknown' : 'known',
    ...(channelId === undefined ? {} : { channelId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(historicalName.length === 0 ? {} : { historicalName }),
    ...(typeof sourceType === 'number' && Number.isSafeInteger(sourceType) && sourceType >= 0
      ? { sourceType }
      : {}),
  };
};

const safeChangeValue = (value: unknown, kind: 'id' | 'timestamp'): ArchiveSafeChangeValue => {
  if (value === null || value === '') return { state: 'unset' };
  if (kind === 'id') {
    const parsed = snowflake(value);
    return parsed === undefined ? { state: 'unknown' } : { state: 'value', value: parsed };
  }
  const number = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number >= 0 &&
    number <= 8.64e15
    ? {
        state: 'value',
        value: number,
        storageType: typeof value === 'string' ? 'string' : 'number',
      }
    : { state: 'unknown' };
};

/** Missing recovery fields remain unknown rather than being presented as an empty value. */
export const safeArchiveOperationChanges = (
  data: Record<string, unknown>,
  category: ArchiveManifestCategory,
): ArchiveOperationChange[] => {
  if (category === 'reset-progress')
    return [
      {
        field: 'lastMessageId',
        before: safeChangeValue(data['beforeLastMessageId'], 'id'),
        after: safeChangeValue(data['afterLastMessageId'], 'id'),
      },
    ];
  if (category === 'repair-message-time')
    return [
      {
        field: 'timestamp',
        before: safeChangeValue(data['beforeTimestamp'], 'timestamp'),
        after: safeChangeValue(data['afterTimestamp'], 'timestamp'),
      },
    ];
  return [];
};
