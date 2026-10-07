import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { archiveManifestCategories } from '../../../../src/core/archive/manifest-summary';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import {
  archiveConfirmationReply,
  archiveJobReply,
  archiveManifestReply,
} from '../../../../src/handlers/commands/archive/presentation';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

type Manifest = Awaited<ReturnType<ArchiveControlService['manifest']>>;
type Confirmation = Awaited<ReturnType<ArchiveControlService['requestConfirmation']>>;
type Job = Awaited<ReturnType<ArchiveControlService['status']>>;
const actor = { userId: '456', channelId: '789' };
const report = (): Manifest => ({
  run: {
    deletable: false,
    runId: 'r'.repeat(160),
    guildId: '123',
    status: 'complete',
    createdAt: 1_700_000_000_000,
    cutoff: 1_700_000_000_000,
    validUntil: 1_700_086_400_000,
    operations: 3_500_000,
    unresolved: 300,
    issueCount: 100,
    issueCategories: ['coverage', 'conflict'],
    journalBytes: 987_654_321,
    actions: ['accept'],
  },
  summary: {
    status: 'available',
    totalOperations: 3_500_000,
    categories: archiveManifestCategories.map((category) => ({
      category,
      operations: 500_000,
      deleteOperations: 499_999,
      insertOperations: 0,
      updateOperations: 0,
      unknownImpactOperations: 1,
    })),
    impacts: {
      deleteOperations: 3_499_993,
      insertOperations: 0,
      updateOperations: 0,
      unknownImpactOperations: 7,
    },
  },
  operations: [],
  nextSequence: -1,
  hasNext: false,
  hasPrevious: false,
});
const approval = (manifest: Manifest): Confirmation => ({
  token: 'abcdefghijklmnopqrstuvwx',
  action: 'accept',
  run: manifest.run,
  summary: manifest.summary,
  expiresAt: 1_900_000_000_000,
});
const setup = async (locale: 'en' | 'zh-TW') => {
  const translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: locale,
  });
  return { ...buildFakeBot({ translator }), translator };
};

describe('readable archive presentation acceptance', () => {
  it.each(['en', 'zh-TW'] as const)(
    'uses unique Discord component IDs across detail views and filters in %s',
    async (locale) => {
      const { bot, translator } = await setup(locale);
      const manifest = report();
      manifest.run.runId = '6964554f-a049-445d-9297-ba37589cef25';
      if (manifest.summary.status === 'available') {
        manifest.summary.totalOperations = 7;
        manifest.summary.categories = manifest.summary.categories.map((entry) => ({
          ...entry,
          operations: 1,
        }));
      }
      manifest.operations = [
        {
          operationId: 'operation',
          sequence: 10,
          collection: 'fetches',
          state: 'planned',
          reason: 'reset-cursor-for-full-reconciliation',
          category: 'reset-progress',
          impact: 'update',
          target: { identity: 'known', channelId: '123' },
          changes: [],
          dependencies: [],
          beforeHash: '',
          afterHash: '',
        },
      ];
      manifest.hasPrevious = true;
      manifest.hasNext = true;
      manifest.previousCursor = 10;
      manifest.nextCursor = 19;
      const control = {
        manifest: vi.fn().mockResolvedValue(manifest),
      } as unknown as ArchiveControlService;
      for (const view of ['changes', 'technical'] as const) {
        for (const category of [undefined, ...archiveManifestCategories]) {
          const reply = await archiveManifestReply(manifest.run.runId, bot, control, actor, {
            view,
            ...(category === undefined ? {} : { category }),
          });
          const components = JSON.parse(JSON.stringify(reply.components)) as {
            components: { custom_id: string; label?: string; options?: { label: string }[] }[];
          }[];
          const controls = components.flatMap((row) => row.components);
          const ids = controls.map((component) => component.custom_id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(components.length).toBeLessThanOrEqual(5);
          expect(components.every((row) => row.components.length <= 5)).toBe(true);
          expect(ids.every((id) => id.length <= 100)).toBe(true);
          for (const key of ['view_summary', 'page_previous', 'page_next'])
            expect(controls.map((component) => component.label)).toContain(
              translator.t(`replies:archive.${key}`),
            );
          expect(controls.filter((component) => component.options !== undefined)).toHaveLength(0);
          expect(controls.length).toBeLessThanOrEqual(3);
        }
      }
    },
  );
  it.each(['en', 'zh-TW'] as const)(
    'keeps a zero-change %s plan truthful and free of empty issue counters',
    async (locale) => {
      const { bot, translator } = await setup(locale);
      const manifest = report();
      manifest.run.status = 'planned';
      manifest.run.unresolved = 0;
      manifest.run.issueCount = 0;
      manifest.run.operations = 0;
      if (manifest.summary.status === 'available') {
        manifest.summary.totalOperations = 0;
        manifest.summary.categories = [];
        manifest.summary.recordTypes = [];
        manifest.summary.impacts = {
          deleteOperations: 0,
          insertOperations: 0,
          updateOperations: 0,
          unknownImpactOperations: 0,
        };
      }
      const confirmation = { ...approval(manifest), action: 'apply' as const };
      const text = String(archiveConfirmationReply(confirmation, bot, actor).content);
      expect(text).toContain(translator.t('commands:archive_ui.plan_not_verified'));
      expect(text).toContain(translator.t('replies:archive.plan_zero_operations'));
      expect(text).not.toContain(translator.t('commands:archive_ui.progress_only'));
      expect(text).not.toContain(
        translator.t('commands:archive_ui.plan_issues', { unresolved: 0, issues: 0 }),
      );
      expect(text).toContain(translator.t('replies:archive.plan_next_apply'));
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'retains all change impacts and acceptance consequences in one %s confirmation',
    async (locale) => {
      const { bot, translator } = await setup(locale);
      const manifest = report();
      const reply = archiveConfirmationReply(approval(manifest), bot);
      const text = String(reply.content);
      expect(text.length).toBeLessThanOrEqual(1900);
      expect(text).not.toContain(manifest.run.runId);
      expect(text).toContain('72');
      expect(text).not.toMatch(/```|beforeHash|schemaHash|dependencies|replies:|\{\{/);
      for (const category of archiveManifestCategories)
        expect(text).toContain(translator.t(`replies:archive.category_${category}`));
      expect(text).toMatch(/499,?999/);
      expect(JSON.stringify(reply.components)).toContain(
        'archive_confirm|abcdefghijklmnopqrstuvwx',
      );
      expect(JSON.stringify(reply.components)).not.toContain(`archive_view|${manifest.run.runId}`);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'keeps the recovered terminal %s panel bounded without losing confirmation or result context',
    async (locale) => {
      const { bot, translator } = await setup(locale);
      const manifest = report();
      if (manifest.summary.status === 'available') {
        manifest.run.operations = 7_000_000_000_000_000;
        manifest.summary.totalOperations = manifest.run.operations;
        manifest.summary.categories = manifest.summary.categories.map((category) => ({
          ...category,
          operations: 1_000_000_000_000_000,
          deleteOperations: 999_999_999_999_999,
        }));
        manifest.summary.impacts.deleteOperations = 6_999_999_999_999_993;
      }
      const control = {
        manifest: vi.fn().mockResolvedValue(manifest),
        requestConfirmation: vi.fn().mockResolvedValue(approval(manifest)),
      } as unknown as ArchiveControlService;
      const progress = sanitizeArchiveProgress({
        version: 2,
        jobId: 'j'.repeat(160),
        runId: manifest.run.runId,
        work: 'apply',
        state: 'complete',
        phase: 'verification',
        messageCountQuality: 'exact',
        messages: { inserted: 1234567, updated: 1234567, unchanged: 1234567 },
        reactions: { completed: 1234567, required: 1234567 },
        validation: { state: 'passed', coverage: 'complete' },
      })!;
      const job: Job = {
        jobId: 'j'.repeat(160),
        requestId: 'request',
        guildId: '123',
        command: 'apply',
        runId: manifest.run.runId,
        status: 'complete',
        cancelRequested: false,
        createdAt: 1_700_000_000_000,
        counts: {},
        issueCount: 0,
        issueCategories: [],
        progress,
      };
      const reply = await archiveJobReply(job, bot, control, null, actor);
      const text = String(reply.content);
      expect(text.length).toBeLessThanOrEqual(1900);
      expect(text).not.toContain(job.jobId);
      expect(text).not.toContain(manifest.run.runId);
      expect(text).toContain('72');
      expect(text).not.toMatch(/```|beforeHash|schemaHash|dependencies|replies:|\{\{/);
      expect(JSON.stringify(reply.components)).toContain('archive_confirm|');
      expect(JSON.stringify(reply.components)).toContain(
        translator.t('replies:archive.view_changes'),
      );
      const components = JSON.parse(JSON.stringify(reply.components)) as {
        components: { type: number }[];
      }[];
      expect(
        components.flatMap((row) => row.components).filter((component) => component.type === 2)
          .length,
      ).toBeLessThanOrEqual(5);
      expect(control.requestConfirmation).toHaveBeenCalledExactlyOnceWith(
        'accept',
        manifest.run.runId,
        actor,
      );
    },
  );

  it('prioritizes recovered job deletion and issues within five direct buttons', async () => {
    const { bot } = await setup('en');
    const manifest = report();
    manifest.run.runId = 'run';
    manifest.run.actions = ['accept', 'rollback'];
    manifest.run.deletable = true;
    const control = {
      manifest: vi.fn().mockResolvedValue(manifest),
      requestConfirmation: vi.fn().mockResolvedValue(approval(manifest)),
    } as unknown as ArchiveControlService;
    const job: Job = {
      jobId: 'job',
      requestId: 'request',
      guildId: '123',
      command: 'apply',
      runId: 'run',
      status: 'complete',
      cancelRequested: false,
      createdAt: 1_700_000_000_000,
      counts: {},
      issueCount: 1,
      issueCategories: ['coverage'],
      progress: {
        ...sanitizeArchiveProgress({ work: 'apply', state: 'complete', phase: 'verification' })!,
        gapCount: 1,
      },
    };
    const reply = await archiveJobReply(job, bot, control, null, actor);
    const components = JSON.parse(JSON.stringify(reply.components)) as {
      components: { custom_id: string; type: number }[];
    }[];
    expect(components).toHaveLength(1);
    expect(components[0]!.components).toHaveLength(5);
    expect(components[0]!.components.every((component) => component.type === 2)).toBe(true);
    expect(components[0]!.components.map((component) => component.custom_id)).toEqual([
      'archive_confirm|abcdefghijklmnopqrstuvwx',
      expect.stringMatching(/^archive_browse\|/),
      'archive_manage|delete-job|job',
      'archive_panel|job|p|1',
      'archive_manage|rollback|run',
    ]);
    expect(control.requestConfirmation).toHaveBeenCalledExactlyOnceWith('accept', 'run', actor);
  });

  it.each(['partial', 'cancelled', 'failed', 'accepted'])(
    'does not invent an acceptance action for a %s run without backend eligibility',
    async (status) => {
      const { bot } = await setup('zh-TW');
      const manifest = report();
      manifest.run.status = status;
      manifest.run.actions = [];
      const confirmation = vi.fn();
      const control = {
        manifest: vi.fn().mockResolvedValue(manifest),
        requestConfirmation: confirmation,
      } as unknown as ArchiveControlService;
      const reply = await archiveManifestReply(manifest.run.runId, bot, control, actor, {
        view: 'summary',
      });
      expect(confirmation).not.toHaveBeenCalled();
      expect(JSON.stringify(reply.components)).not.toContain('archive_confirm|');
    },
  );
});
