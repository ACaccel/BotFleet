import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { renderArchiveProgress } from '../../../../src/core/archive/progress-renderer';
import { renderArchiveStatus } from '../../../../src/handlers/commands/archive/progress';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';

const setup = async (locale: 'en' | 'zh-TW') => {
  const translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: locale,
  });
  const snapshot = sanitizeArchiveProgress({
    version: 2,
    work: 'apply',
    state: 'complete',
    phase: 'verification',
    jobId: 'j'.repeat(160),
    scanId: 's'.repeat(160),
    runId: 'r'.repeat(160),
    cutoff: new Date(1000).toISOString(),
    sources: { completed: 3, total: 3, quality: 'discovered' },
    messages: { scanned: 42, inserted: 28, updated: 2, unchanged: 12, admitted: 30, durable: 30 },
    reactions: { required: 7, completed: 7 },
    messageCountQuality: 'exact',
    gapCount: 3,
    validation: {
      state: 'passed',
      coverage: 'complete',
      checks: {
        pendingOperations: 0,
        unresolvedEvidence: 0,
        invalidOperations: 0,
        missingDependencies: 0,
      },
    },
  })!;
  return { translator, snapshot };
};

describe('archive progress mandatory information budget', () => {
  it.each(['en', 'zh-TW'] as const)(
    'retains %s validation, coverage and acceptance effects ahead of optional source names',
    async (locale) => {
      const { translator, snapshot } = await setup(locale);
      const progress = {
        ...snapshot,
        activities: [1, 2, 3].map((id) => ({
          sourceId: String(id),
          name: '@*'.repeat(50),
          step: 'writing' as const,
          scanned: 1,
          updatedAt: 1000,
          startedAt: 1000,
        })),
        activityCount: 3,
        gaps: [1, 2, 3].map((id) => ({
          sourceId: String(id),
          name: '@*'.repeat(50),
          reason: 'permission' as const,
        })),
      };
      const content = renderArchiveProgress(progress, translator, 6000, {
        details: true,
        target: '*'.repeat(100),
        footerLines: ['f'.repeat(300), 'g'.repeat(300), 'h'.repeat(300)],
      });
      expect(content.length).toBeLessThanOrEqual(1900);
      expect(content).toContain(translator.t('replies:archive.view_validation_passed'));
      expect(content).toContain(translator.t('replies:archive.view_coverage_complete'));
      expect(content).toContain(translator.t('replies:archive.view_next_review_result'));
      for (const id of [snapshot.jobId!, snapshot.scanId!, snapshot.runId!])
        expect(content).toContain(id);
      expect(content).toContain(
        translator.t('replies:archive.view_details_sources', { command: '/archive jobs' }),
      );
      expect(content).not.toContain('/archive status');
      expect(content).not.toContain('job_id:');
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows every fetched %s gap with actionable stable next-page navigation',
    async (locale) => {
      const { translator, snapshot } = await setup(locale);
      const parent = Object.assign(
        buildTextChannel({ id: '10000000000000000000', name: '@*'.repeat(50) }),
        { parentId: null },
      );
      const ids = ['20000000000000000001', '20000000000000000002', '20000000000000000003'];
      const channels = ids.map((id) =>
        Object.assign(buildTextChannel({ id, name: '長來源名稱@*'.repeat(20) }), {
          parentId: parent.id,
        }),
      );
      const guild = buildGuild({ id: '1', name: '@*'.repeat(50), channels: [parent, ...channels] });
      const { bot } = buildFakeBot({
        translator,
        client: { guilds: { cache: new Map([['1', guild]]) } },
      });
      const progressDetails = vi.fn(async (_scope: string, page: number, limit: number) => {
        expect(limit).toBe(1);
        return {
          activities: [],
          gaps: [
            {
              sourceId: ids[page - 1]!,
              name: 'historical'.repeat(10),
              reason: 'permission' as const,
            },
          ],
          page,
          hasNext: page < 3,
        };
      });
      const control = { progressDetails } as unknown as ArchiveControlService;
      for (let page = 1; page <= 3; page += 1) {
        const content = await renderArchiveStatus(snapshot, bot, control, 'scope', page, [], {
          guildId: '1',
        });
        expect(content.length).toBeLessThanOrEqual(1900);
        expect(content).toContain(ids[page - 1]);
        expect(content).toContain(translator.t('replies:archive.view_detail_gap_permission'));
        expect(content).toContain(translator.t('replies:archive.view_validation_passed'));
        expect(content).toContain(translator.t('replies:archive.view_coverage_complete'));
        expect(content).toContain('72');
        for (const id of [snapshot.jobId!, snapshot.scanId!, snapshot.runId!])
          expect(content).not.toContain(id);
        if (page < 3)
          expect(content).toContain(
            translator.t('replies:archive.progress_page_next', { page, nextPage: page + 1 }),
          );
      }
      expect(progressDetails).toHaveBeenCalledTimes(3);
    },
  );
});
