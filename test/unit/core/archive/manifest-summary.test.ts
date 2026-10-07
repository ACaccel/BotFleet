import { describe, expect, it } from 'vitest';
import { archiveManifestCategory } from '../../../../src/core/archive/manifest-summary';

describe('archive manifest category contracts', () => {
  it.each([
    ['fetches', 'reset-cursor-for-full-reconciliation', 'reset-progress'],
    ['fetches', 'delete-duplicate-cursor', 'remove-duplicate-progress'],
    ['messages', 'rescue-timestamp', 'repair-message-time'],
    ['messages', 'merge-compatible-duplicate', 'merge-duplicate-messages'],
    ['messages', 'delete-verified-duplicate', 'merge-duplicate-messages'],
    ['messages', 'policy-excluded-source', 'exclude-by-policy'],
    ['archive_revisions', 'policy-excluded-related-record', 'exclude-by-policy'],
    ['archive_reactions', 'policy-excluded-related-record', 'exclude-by-policy'],
    ['archive_quarantine', 'preserve-quarantine-evidence', 'quarantine-data'],
    ['messages', 'relocate-to-quarantine', 'quarantine-data'],
    ['fetches', 'quarantine-invalid-cursor', 'quarantine-data'],
  ])('classifies %s / %s as %s', (collection, reason, category) => {
    expect(archiveManifestCategory(collection, reason)).toBe(category);
  });

  it.each([
    ['messages', 'delete-duplicate-cursor'],
    ['messages', 'future-repair-code'],
    ['unknown-collection', 'rescue-timestamp'],
    ['messages', null],
    ['messages', { reason: 'rescue-timestamp' }],
    [undefined, 'rescue-timestamp'],
    [null, null],
  ])('keeps unexpected or malformed %s / %s visible as unknown', (collection, reason) => {
    expect(archiveManifestCategory(collection, reason)).toBe('unknown');
  });
});
