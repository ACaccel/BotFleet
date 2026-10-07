import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { archiveCommandConfig } from '../../src/handlers/commands/archive/config';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../src/core/archive/progress';
import { renderArchiveProgress } from '../../src/core/archive/progress-renderer';
import type { ArchivePhase, ProgressTracker } from '../../src/plugins/message-backup/flow/progress';

type State = ReturnType<ProgressTracker['snapshot']>['state'];
const phases: Record<ArchivePhase, string> = {
  discovery: 'phase_discovery',
  history: 'phase_history',
  reactions: 'phase_reactions',
  repair: 'phase_repair',
  verification: 'phase_verification',
};
const states: Record<State, string> = {
  running: 'state_running',
  queued: 'state_queued',
  waiting: 'state_waiting',
  cancelling: 'state_cancelling',
  paused: 'state_paused',
  complete: 'state_complete',
  partial: 'state_partial',
  failed: 'state_failed',
  cancelled: 'state_cancelled',
};

describe('archive progress catalog', () => {
  it.each(['zh-TW', 'en'] as const)(
    'only suggests registered archive command entries in %s',
    async (locale) => {
      const entries = new Set([
        ...archiveCommandConfig.subcommands!.map(({ name }) => name),
        ...archiveCommandConfig.subcommandGroups!.map(({ name }) => name),
      ]);
      for (const catalog of ['commands', 'replies']) {
        const source = await readFile(
          path.resolve(__dirname, `../../src/i18n/locales/${locale}/${catalog}.json`),
          'utf8',
        );
        for (const [, command] of source.matchAll(/\/archive\s+([a-z-]+)/g))
          expect(entries.has(command!)).toBe(true);
      }
    },
  );

  it.each(['zh-TW', 'en'] as const)(
    'renders every work and phase without untranslated keys in %s',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      for (const work of [
        'audit',
        'plan',
        'apply',
        'resume',
        'verify',
        'rollback',
        'accept',
        'backfill',
        'migrate-timestamp',
        'refresh-attachment',
        'periodic',
      ])
        for (const phase of Object.keys(phases)) {
          const snapshot = sanitizeArchiveProgress({ work, phase, state: 'complete' })!;
          const content = renderArchiveProgress(snapshot, translator, 6000);
          expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity/);
          expect(content.length).toBeLessThanOrEqual(1900);
        }
      const checks = {
        pendingOperations: 0,
        unresolvedEvidence: 0,
        invalidOperations: 0,
        missingDependencies: 0,
      };
      for (const state of ['passed', 'incomplete', 'previously-accepted'])
        for (const coverage of ['complete', 'incomplete', 'timestamps-only']) {
          const snapshot = sanitizeArchiveProgress({
            work: 'accept',
            phase: 'verification',
            state: 'complete',
            validation: { state, checks, coverage, recoveryExpiresAt: 12000 },
          })!;
          const content = renderArchiveProgress(snapshot, translator, 6000, { details: true });
          expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity/);
          expect(content).toContain('<t:12:f>');
        }
    },
  );

  it.each(['zh-TW', 'en'] as const)(
    'resolves all phase/state labels and ETA variants in %s',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      for (const suffix of [...Object.values(phases), ...Object.values(states)]) {
        expect(translator.t(`replies:archive.${suffix}`, undefined, locale)).not.toContain(
          'archive.',
        );
      }
      const phase = translator.t('replies:archive.phase_history', undefined, locale);
      const state = translator.t('replies:archive.state_paused', undefined, locale);
      for (const suffix of ['estimating', 'eta', 'eta_phase', 'eta_unavailable']) {
        const eta = translator.t(
          `replies:archive.${suffix}`,
          { phase, lower: 2, upper: 5, reason: state },
          locale,
        );
        expect(eta).not.toMatch(/archive\.|\{\{/);
        const content = translator.t(
          'replies:archive.progress',
          { phase, state, count: 42, eta },
          locale,
        );
        expect(content).not.toMatch(/archive\.|\{\{/);
        expect(content).toContain('42');
        expect(content).toContain(phase);
        expect(content).toContain(state);
        expect(content).toContain(eta);
        if (suffix === 'eta_phase')
          expect(eta).toContain(locale === 'en' ? 'this phase only' : '僅此階段');
      }
    },
  );
});
