import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { archiveProgressPageCounters } from '../../../../src/core/archive/progress-page-counters';

const localesDir = path.resolve(__dirname, '../../../../src/i18n/locales');

describe('archive detail counters', () => {
  it.each(['en', 'zh-TW'] as const)(
    'keeps saved repair outcomes and %s count quality while omitting empty reaction work',
    async (locale) => {
      const translator = await createDefaultTranslator({ localesDir, fallbackLocale: locale });
      const progress = sanitizeArchiveProgress({
        work: 'apply',
        phase: 'discovery',
        state: 'partial',
        messageCountQuality: 'lower-bound',
        messages: { scanned: 5, admitted: 4, durable: 3 },
        sources: { total: 1 },
        phases: { repair: { unit: 'operations', committed: 12 } },
        reactionCountKnown: true,
        reactions: { completed: 0, required: 0 },
      })!;
      const text = archiveProgressPageCounters(progress, translator).join('\n');
      expect(text).toContain(translator.t('replies:archive.view_counts_lower_bound'));
      expect(text).toContain(
        translator.t('replies:archive.public_operations_confirmed', {
          count: 12,
          unit: translator.t('replies:archive.view_unit_operations'),
        }),
      );
      expect(text).not.toContain(
        translator.t('replies:archive.view_reaction_summary', { count: 0, total: 0 }),
      );
      expect(text).not.toMatch(/Admitted|Durable|符合政策|已確認寫入/);
      expect(progress.messages.admitted).toBe(4);
      expect(progress.messages.durable).toBe(3);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'retains %s reaction completeness and unavailable counters',
    async (locale) => {
      const translator = await createDefaultTranslator({ localesDir, fallbackLocale: locale });
      const progress = sanitizeArchiveProgress({
        work: 'periodic',
        phase: 'history',
        state: 'partial',
        messageCountQuality: 'lower-bound',
        reactionCountKnown: false,
      })!;
      const unknown = archiveProgressPageCounters(progress, translator).join('\n');
      expect(unknown).toContain(translator.t('replies:archive.view_counts_unavailable'));
      expect(unknown).toContain(translator.t('replies:archive.view_reactions_unrecorded'));
      const withReactions = archiveProgressPageCounters(
        { ...progress, reactionCountKnown: true, reactions: { completed: 1, required: 2 } },
        translator,
      ).join('\n');
      expect(withReactions).toContain(
        translator.t('replies:archive.view_reaction_summary', { count: 1, total: 2 }),
      );
    },
  );
});
