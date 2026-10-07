import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { archiveJobProgress, sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { renderArchiveProgress } from '../../../../src/core/archive/progress-renderer';
import type { ArchiveJob } from '../../../../src/core/archive/types';

describe('private archive detail boundaries', () => {
  it.each(['en', 'zh-TW'] as const)(
    'distinguishes completed public %s daily scope from repair validation',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const snapshot = sanitizeArchiveProgress({
        version: 2,
        work: 'periodic',
        phase: 'verification',
        state: 'complete',
        cutoff: new Date(1000).toISOString(),
        messageCountQuality: 'exact',
        sources: { completed: 1, total: 1 },
        messages: { scanned: 1, inserted: 1 },
        reactions: { required: 1, completed: 1 },
        gaps: [{ sourceId: 'private-source', name: 'confidential', reason: 'permission' }],
      })!;
      const content = renderArchiveProgress(snapshot, translator, 6000, { public: true });
      expect(content).toContain(translator.t('replies:archive.view_periodic_scope'));
      expect(content).toContain('<t:1:f>');
      expect(content).not.toContain(translator.t('replies:archive.view_validation_passed'));
      expect(content).not.toMatch(/private-source|confidential/);
      expect(content.length).toBeLessThanOrEqual(1900);
    },
  );
  it.each(['en', 'zh-TW'] as const)(
    'renders only bounded aggregate %s public progress and validation',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const snapshot = sanitizeArchiveProgress({
        version: 2,
        work: 'apply',
        phase: 'verification',
        state: 'partial',
        jobId: 'j'.repeat(160),
        runId: 'private-run',
        cutoff: new Date(1000).toISOString(),
        activities: [
          {
            sourceId: 'private-source-id',
            name: 'confidential-source',
            step: 'writing',
            cursor: 'private-cursor',
          },
        ],
        gaps: [
          { sourceId: 'private-source-id', name: 'confidential-source', reason: 'permission' },
        ],
        sources: { completed: 2, total: 3, quality: 'discovered' },
        messages: { scanned: 12, inserted: 8, updated: 1 },
        reactions: { required: 5, completed: 4 },
        validation: {
          state: 'incomplete',
          coverage: 'incomplete',
          checks: {
            pendingOperations: 1,
            unresolvedEvidence: 0,
            invalidOperations: 0,
            missingDependencies: 0,
          },
        },
      })!;
      const content = renderArchiveProgress(snapshot, translator, 6000, {
        public: true,
        target: `${'*'.repeat(100)} (ID 12345678901234567890)`,
      });
      expect(content).not.toMatch(
        /confidential-source|private-source-id|private-cursor|private-run/,
      );
      expect(content).toContain(snapshot.jobId);
      expect(content).toContain('12345678901234567890');
      expect(content).toContain(translator.t('replies:archive.view_validation_incomplete'));
      expect(content).toContain(translator.t('replies:archive.view_private_details'));
      expect(content).toContain('<t:1:f>');
      expect(content.length).toBeLessThanOrEqual(1900);
      expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity/);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'never invents missing legacy %s scope, issues or validation',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const job: ArchiveJob = {
        jobId: 'job',
        requestId: 'request',
        guildId: '1',
        command: 'apply',
        options: {},
        status: 'complete',
        cancelRequested: false,
        createdAt: 1000,
      };
      const snapshot = archiveJobProgress(job, 6000);
      const content = renderArchiveProgress(snapshot, translator, 6000, { public: true });
      expect(snapshot.cutoffKnown).toBe(false);
      expect(snapshot.gapCountKnown).toBe(false);
      expect(content).toContain(translator.t('replies:archive.view_cutoff_unknown'));
      expect(content).toContain(translator.t('replies:archive.view_validation_unavailable'));
      expect(content).toContain(translator.t('replies:archive.view_unknown'));
      expect(content).not.toContain('100%');
      expect(content).not.toContain('<t:1:f>');
    },
  );
});
