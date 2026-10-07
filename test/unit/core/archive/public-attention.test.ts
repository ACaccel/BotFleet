import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { renderArchiveProgress } from '../../../../src/core/archive/progress-renderer';

const localesDir = path.resolve(__dirname, '../../../../src/i18n/locales');
const checks = {
  pendingOperations: 1,
  unresolvedEvidence: 0,
  invalidOperations: 0,
  missingDependencies: 0,
};

describe('public archive stopped-work guidance', () => {
  it.each(['en', 'zh-TW'] as const)(
    'explains stopped %s jobs, retained writes, actual repair work and safe manual continuation',
    async (locale) => {
      const translator = await createDefaultTranslator({ localesDir, fallbackLocale: locale });
      for (const work of ['apply', 'resume'])
        for (const state of ['partial', 'failed']) {
          const snapshot = sanitizeArchiveProgress({
            version: 2,
            work,
            state,
            phase: 'discovery',
            reason: 'invalid-progress-total https://secret.example/token',
            jobId: 'j'.repeat(160),
            cutoff: new Date(1000).toISOString(),
            nextAction: 'resume',
            messages: { scanned: 0, inserted: 28, updated: 2 },
            phases: {
              repair: { committed: 1126, total: 1126, unit: 'operations', quality: 'exact' },
            },
            gaps: [
              {
                sourceId: 'private-source',
                name: 'confidential-source',
                reason: 'invalid-progress-total https://secret.example/token',
              },
            ],
            validation: { state: 'incomplete', coverage: 'incomplete', checks },
          })!;
          const content = renderArchiveProgress(snapshot, translator, 6000, { public: true });
          expect(content).toContain(translator.t('replies:archive.view_public_stopped'));
          expect(content).toContain(translator.t('replies:archive.view_public_cause_unknown'));
          expect(content).toContain(translator.t('replies:archive.view_public_next_resume'));
          expect(content).toContain(
            translator.t('replies:archive.view_message_summary', { count: 0 }),
          );
          expect(content).toContain(
            translator.t('replies:archive.view_operation_summary', {
              count: '1,126',
              unit: translator.t('replies:archive.view_unit_operations'),
            }),
          );
          expect(content).toContain(
            translator.t('replies:archive.view_writes', { inserted: 28, updated: 2, unchanged: 0 }),
          );
          expect(content).toContain(translator.t('replies:archive.view_validation_incomplete'));
          expect(content).toContain(snapshot.jobId);
          expect(content).not.toMatch(
            /invalid-progress-total|secret\.example|confidential|private-source/,
          );
          expect(content.length).toBeLessThanOrEqual(1900);
        }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'preserves safe %s issue categories, aggregate validation and complete public IDs within budget',
    async (locale) => {
      const translator = await createDefaultTranslator({ localesDir, fallbackLocale: locale });
      const large = Number.MAX_SAFE_INTEGER;
      const snapshot = sanitizeArchiveProgress({
        version: 2,
        work: 'apply',
        state: 'partial',
        phase: 'verification',
        jobId: 'j'.repeat(160),
        cutoff: new Date(1000).toISOString(),
        nextAction: 'replan',
        reason: 'conflict',
        gaps: ['permission', 'discovery', 'capacity'].map((reason) => ({
          sourceId: `private-${reason}`,
          name: '*'.repeat(100),
          reason,
        })),
        sources: { completed: large, total: large },
        messages: { scanned: large, inserted: large, updated: large, unchanged: large },
        phases: { repair: { committed: large, unit: 'operations' } },
        reactions: { required: large, completed: large },
        validation: { state: 'incomplete', coverage: 'timestamps-only', checks },
      })!;
      const content = renderArchiveProgress(snapshot, translator, 6000, {
        public: true,
        target: `${'*'.repeat(100)} (ID 12345678901234567890)`,
      });
      for (const reason of ['permission', 'discovery', 'capacity', 'conflict'])
        expect(content).toContain(translator.t(`replies:archive.view_detail_gap_${reason}`));
      expect(content).toContain(translator.t('replies:archive.view_public_next_replan'));
      expect(content).toContain(translator.t('replies:archive.view_validation_incomplete'));
      expect(content).toContain(translator.t('replies:archive.view_coverage_timestamps-only'));
      expect(content).toContain(snapshot.jobId);
      expect(content).toContain('12345678901234567890');
      expect(content).not.toContain('private-');
      expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity/);
      expect(content.length).toBeLessThanOrEqual(1900);
      const unknown = renderArchiveProgress({ ...snapshot, reason: 'other' }, translator, 6000, {
        public: true,
        target: `${'*'.repeat(100)} (ID 12345678901234567890)`,
      });
      expect(unknown).toContain(translator.t('replies:archive.view_public_cause_unknown'));
      expect(unknown).toContain(translator.t('replies:archive.view_validation_incomplete'));
      expect(unknown.length).toBeLessThanOrEqual(1900);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'distinguishes stopped %s scan passes from later scheduled attempts and active work',
    async (locale) => {
      const translator = await createDefaultTranslator({ localesDir, fallbackLocale: locale });
      for (const state of ['partial', 'failed', 'running']) {
        const snapshot = sanitizeArchiveProgress({ work: 'periodic', phase: 'discovery', state })!;
        const content = renderArchiveProgress(snapshot, translator, 6000, { public: true });
        expect(content).not.toContain(translator.t('replies:archive.view_public_stopped'));
        if (state === 'running') {
          expect(content).not.toContain(translator.t('replies:archive.view_public_scan_stopped'));
          expect(content).not.toContain(translator.t('replies:archive.view_public_cause_unknown'));
        } else {
          expect(content).toContain(translator.t('replies:archive.view_public_scan_stopped'));
          expect(content).toContain(translator.t('replies:archive.view_public_next_status'));
          expect(content).toContain(translator.t('replies:archive.view_public_cause_unknown'));
          expect(content).toContain(translator.t('replies:archive.view_periodic_scope'));
        }
      }
      const documentWork = sanitizeArchiveProgress({
        work: 'apply',
        phase: 'repair',
        state: 'running',
        phases: { repair: { committed: 20, unit: 'documents' } },
      })!;
      expect(renderArchiveProgress(documentWork, translator, 6000, { public: true })).not.toContain(
        translator.t('replies:archive.view_operation_summary', {
          count: 20,
          unit: translator.t('replies:archive.view_unit_operations'),
        }),
      );
    },
  );
});
