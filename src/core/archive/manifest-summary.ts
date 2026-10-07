export const archiveManifestCategories = [
  'reset-progress',
  'remove-duplicate-progress',
  'repair-message-time',
  'merge-duplicate-messages',
  'exclude-by-policy',
  'quarantine-data',
  'unknown',
] as const;

export type ArchiveManifestCategory = (typeof archiveManifestCategories)[number];

/** Counters describe journal operations, not distinct messages or Discord sources. */
export interface ArchiveManifestImpact {
  insertOperations: number;
  updateOperations: number;
  deleteOperations: number;
  unknownImpactOperations: number;
}

export interface ArchiveManifestCategorySummary extends ArchiveManifestImpact {
  category: ArchiveManifestCategory;
  operations: number;
  sourceCount?: number;
  unknownSourceOperations?: number;
}

export const archiveManifestCollections = [
  'fetches',
  'messages',
  'archive_revisions',
  'archive_reactions',
  'archive_quarantine',
  'unknown',
] as const;
export interface ArchiveManifestRecordTypeSummary extends ArchiveManifestImpact {
  collection: (typeof archiveManifestCollections)[number];
  operations: number;
  sourceCount?: number;
  unknownSourceOperations?: number;
}

export type ArchiveManifestSummary =
  | {
      status: 'available';
      totalOperations: number;
      categories: ArchiveManifestCategorySummary[];
      impacts: ArchiveManifestImpact;
      targets?: { distinctSources: number; unknownSourceOperations: number };
      recordTypes?: ArchiveManifestRecordTypeSummary[];
    }
  | { status: 'unavailable'; reason: 'timeout' | 'unavailable' | 'invalid-data' };

interface CategoryRule {
  category: Exclude<ArchiveManifestCategory, 'unknown'>;
  reasons: readonly string[];
  collections: readonly string[];
}

const categoryRules: readonly CategoryRule[] = [
  {
    category: 'reset-progress',
    reasons: ['reset-cursor-for-full-reconciliation'],
    collections: ['fetches'],
  },
  {
    category: 'remove-duplicate-progress',
    reasons: ['delete-duplicate-cursor'],
    collections: ['fetches'],
  },
  {
    category: 'repair-message-time',
    reasons: ['rescue-timestamp'],
    collections: ['messages'],
  },
  {
    category: 'merge-duplicate-messages',
    reasons: ['merge-compatible-duplicate', 'delete-verified-duplicate'],
    collections: ['messages'],
  },
  {
    category: 'exclude-by-policy',
    reasons: ['policy-excluded-source'],
    collections: ['messages'],
  },
  {
    category: 'exclude-by-policy',
    reasons: ['policy-excluded-related-record'],
    collections: ['archive_revisions', 'archive_reactions'],
  },
  {
    category: 'quarantine-data',
    reasons: ['preserve-quarantine-evidence'],
    collections: ['archive_quarantine'],
  },
  {
    category: 'quarantine-data',
    reasons: ['relocate-to-quarantine'],
    collections: ['messages'],
  },
  {
    category: 'quarantine-data',
    reasons: ['quarantine-invalid-cursor'],
    collections: ['fetches'],
  },
];

export const archiveManifestCategory = (
  collection: unknown,
  reason: unknown,
): ArchiveManifestCategory =>
  categoryRules.find(
    (rule) =>
      typeof collection === 'string' &&
      rule.collections.includes(collection) &&
      typeof reason === 'string' &&
      rule.reasons.includes(reason),
  )?.category ?? 'unknown';

/** Group keys stay bounded even when older or future reason codes are encountered. */
export const archiveManifestCategoryExpression = (): Record<string, unknown> => ({
  $switch: {
    branches: categoryRules.map((rule) => ({
      case: {
        $and: [{ $in: ['$collection', rule.collections] }, { $in: ['$reason', rule.reasons] }],
      },
      then: rule.category,
    })),
    default: 'unknown',
  },
});
