import path from 'node:path';
import type { APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { archiveJobProgress, sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { renderArchivePublicStatus } from '../../../../src/core/archive/public-status-renderer';
import type { ArchiveJob } from '../../../../src/core/archive/types';

const localesDir = path.resolve(__dirname, '../../../../src/i18n/locales');
const translator = (locale: 'en' | 'zh-TW') =>
  createDefaultTranslator({ localesDir, fallbackLocale: locale });
const snapshot = (values: Record<string, unknown> = {}) =>
  sanitizeArchiveProgress({
    version: 2,
    work: 'apply',
    phase: 'history',
    state: 'running',
    cutoff: new Date(1000).toISOString(),
    elapsedMs: 5000,
    startedAt: 1000,
    sources: { completed: 2, total: 3 },
    messages: { scanned: 12, inserted: 8, updated: 1 },
    reactions: { completed: 4, required: 5 },
    ...values,
  })!;
const text = (embed: APIEmbed): string =>
  [
    embed.title,
    embed.description,
    ...(embed.fields?.flatMap((field) => [field.name, field.value]) ?? []),
    embed.footer?.text,
  ]
    .filter(Boolean)
    .join('\n');
const assertBudget = (embed: APIEmbed): void => {
  expect(embed.title!.length).toBeLessThanOrEqual(256);
  expect(embed.description!.length).toBeLessThanOrEqual(4096);
  expect(embed.fields!.length).toBeLessThanOrEqual(25);
  for (const field of embed.fields!) {
    expect(field.name.length).toBeLessThanOrEqual(256);
    expect(field.value.length).toBeLessThanOrEqual(1024);
  }
  expect(embed.footer!.text.length).toBeLessThanOrEqual(2048);
  expect(text(embed).length).toBeLessThanOrEqual(3000);
};
const validation = {
  state: 'passed',
  coverage: 'complete',
  recoveryExpiresAt: 12000,
  checks: {
    pendingOperations: 0,
    unresolvedEvidence: 0,
    invalidOperations: 0,
    missingDependencies: 0,
  },
};

describe('compact shared archive status', () => {
  it.each(['en', 'zh-TW'] as const)(
    'marks restored partial classification counts in %s',
    async (locale) => {
      const t = await translator(locale);
      const card = renderArchivePublicStatus(
        snapshot({
          messageClassificationVersion: 2,
          messageCountQuality: 'lower-bound',
          messages: { scanned: 200, inserted: 5, updated: 10, upgraded: 20 },
        }),
        t,
      );
      expect(card.description).toContain(t.t('replies:archive.view_counts_lower_bound'));
      expect(text(card)).toContain(
        t.t('replies:archive.public_classified_writes_partial', {
          inserted: 5,
          updated: 10,
          upgraded: 20,
        }),
      );
      expect(text(card)).not.toContain(
        t.t('replies:archive.public_classified_writes', { inserted: 5, updated: 10, upgraded: 20 }),
      );
    },
  );
  it.each(['en', 'zh-TW'] as const)(
    'separates fresh outcomes, checkpoint time and delivery time in %s',
    async (locale) => {
      const t = await translator(locale);
      const fresh = snapshot({
        messageClassificationVersion: 2,
        messages: {
          fetched: 200,
          scanned: 200,
          admitted: 190,
          excluded: 10,
          inserted: 5,
          updated: 15,
          upgraded: 100,
          unchanged: 70,
          durable: 190,
        },
        lastCheckpointAt: 4000,
        recentThroughput: { messages: 100, windowMs: 2000, observedAt: 4000 },
        reactions: { required: 20, completed: 12 },
      });
      const card = renderArchivePublicStatus(fresh, t, {
        nowMs: 6000,
        lastSuccessfulUpdateAtMs: 5500,
      });
      expect(text(card)).toContain(
        t.t('replies:archive.public_classified_writes', {
          inserted: 5,
          updated: 15,
          upgraded: 100,
        }),
      );
      expect(text(card)).toContain(t.t('replies:archive.public_reactions', { count: 12 }));
      expect(text(card)).not.toContain('12 / 20');
      expect(card.description).toContain(
        t.t('replies:archive.public_checkpoint', { time: '<t:4:R>' }),
      );
      expect(card.description).toContain(
        t.t('replies:archive.public_recent_throughput', { rate: 50, seconds: 2 }),
      );
      expect(card.timestamp).toBe(new Date(5500).toISOString());
      const expired = renderArchivePublicStatus(fresh, t, { nowMs: 35000 });
      expect(expired.description).not.toContain(
        t.t('replies:archive.public_recent_throughput', { rate: 50, seconds: 2 }),
      );
      const legacy = renderArchivePublicStatus(
        { ...fresh, messageClassificationVersion: undefined },
        t,
      );
      expect(text(legacy)).toContain(
        t.t('replies:archive.public_writes', { inserted: 5, updated: 15 }),
      );
      expect(text(legacy)).not.toContain(
        t.t('replies:archive.public_classified_writes', {
          inserted: 5,
          updated: 15,
          upgraded: 100,
        }),
      );
    },
  );
  it.each(['en', 'zh-TW'] as const)(
    'renders all %s work, state and phase labels within the combined detail budget',
    async (locale) => {
      const t = await translator(locale);
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
        for (const phase of ['discovery', 'history', 'reactions', 'repair', 'verification'])
          for (const state of [
            'queued',
            'running',
            'waiting',
            'paused',
            'cancelling',
            'complete',
            'partial',
            'failed',
            'cancelled',
          ]) {
            const embed = renderArchivePublicStatus(
              snapshot({ work, phase, state, validation }),
              t,
              { nowMs: 6000 },
            );
            const content = text(embed);
            assertBudget(embed);
            expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity|private panel|私人面板/);
            expect(embed.title).toContain(t.t(`replies:archive.view_state_${state}`));
            if (state !== 'queued')
              expect(content).toContain(t.t(`replies:archive.view_phase_${phase}`));
            if (state !== 'complete')
              expect(embed.title).not.toContain(t.t('replies:archive.view_state_complete'));
          }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows the current %s phase and a safe activity fallback without raw technical substeps',
    async (locale) => {
      const t = await translator(locale);
      for (const work of ['apply', 'resume', 'periodic', 'plan', 'rollback']) {
        const embed = renderArchivePublicStatus(
          snapshot({ work, phase: 'history', substep: 'database' }),
          t,
          { nowMs: 6000 },
        );
        expect(embed.description?.split('\n')[0]).toBe(
          t.t('replies:archive.public_phase', {
            phase: t.t('replies:archive.view_phase_history'),
          }),
        );
        expect(embed.description?.split('\n')[1]).toBe(
          t.t('replies:archive.public_activity', {
            activity: t.t('replies:archive.view_phase_history'),
          }),
        );
        expect(embed.description).not.toContain('→');
        expect(embed.description).not.toContain(t.t('replies:archive.view_substep_database'));
      }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'updates one %s activity line from real page and reaction membership progress',
    async (locale) => {
      const t = await translator(locale);
      const activity = {
        sourceId: 'private-source',
        name: 'private-name',
        step: 'processing',
        pageProcessed: 13,
        pageTotal: 100,
        scanned: 713,
        provisional: true,
      };
      const render = (values: Record<string, unknown>) =>
        renderArchivePublicStatus(snapshot({ activities: [{ ...activity, ...values }] }), t, {
          nowMs: 6000,
          currentSource: '#readable-source',
        });
      const before = render({});
      const after = render({ step: 'writing', pageProcessed: 25 });
      expect(before.description).toContain(
        t.t('replies:archive.public_activity_page', { count: 13, total: 100 }),
      );
      expect(after.description).toContain(t.t('replies:archive.view_step_writing'));
      expect(after.description).toContain(
        t.t('replies:archive.public_activity_page', { count: 25, total: 100 }),
      );
      expect(after.description).not.toBe(before.description);
      expect(after.description?.split('\n')).toHaveLength(2);
      expect(after.description).not.toMatch(/private-|awaiting checkpoint|已完成|成功/);

      const memberships = render({ step: 'reactions', reactionUsers: 123, reactionPages: 2 });
      expect(memberships.description).toContain(
        t.t('replies:archive.public_activity_memberships', { count: 123, pages: 2 }),
      );
      expect(memberships.description).not.toContain(
        t.t('replies:archive.public_activity_page', { count: 13, total: 100 }),
      );
      expect(
        render({ step: 'reactions', reactionUsers: 223, reactionPages: 3 }).description,
      ).not.toBe(memberships.description);
      const fetching = render({ step: 'fetching', reactionUsers: 123, reactionPages: 2 });
      expect(fetching.description).toContain(t.t('replies:archive.view_step_fetching'));
      expect(fetching.description).toContain(
        t.t('replies:archive.public_activity_source_scanned', { count: 713 }),
      );
      expect(fetching.description).not.toContain(
        t.t('replies:archive.public_activity_page', { count: 13, total: 100 }),
      );
      expect(fetching.description).not.toContain(
        t.t('replies:archive.public_activity_memberships', { count: 123, pages: 2 }),
      );
      assertBudget(memberships);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'renders every %s activity step and uses the source selected by the caller',
    async (locale) => {
      const t = await translator(locale);
      for (const step of [
        'fetching',
        'processing',
        'writing',
        'reactions',
        'checkpoint',
        'waiting',
        'queued',
        'draining',
      ]) {
        const embed = renderArchivePublicStatus(
          snapshot({
            activities: [
              { sourceId: 'first-private', name: 'first-secret', step },
              { sourceId: 'second-private', name: 'second-secret', step: 'reactions' },
            ],
          }),
          t,
          { nowMs: 6000, currentSource: '#selected-readable' },
        );
        expect(embed.description).toContain(t.t(`replies:archive.view_step_${step}`));
        expect(embed.description).toContain('selected\\-readable');
        expect(embed.description).not.toMatch(/private|secret|archive\.|\{\{|NaN|Infinity/);
        expect(embed.description?.split('\n')).toHaveLength(2);
        assertBudget(embed);
      }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows truthful %s nonrunning states and hides stale activity after termination',
    async (locale) => {
      const t = await translator(locale);
      const activities = [{ sourceId: 'private', name: 'private', step: 'writing', scanned: 100 }];
      for (const state of ['queued', 'waiting', 'paused', 'cancelling']) {
        const embed = renderArchivePublicStatus(snapshot({ state, activities }), t, {
          currentSource: '#readable',
          nowMs: 6000,
        });
        expect(embed.description).toContain(t.t(`replies:archive.public_activity_${state}`));
        expect(embed.description).not.toContain(t.t('replies:archive.view_step_writing'));
        expect(embed.description).not.toContain(
          t.t('replies:archive.public_activity_source_scanned', { count: 100 }),
        );
        expect(embed.description?.split('\n')).toHaveLength(2);
        if (state === 'queued') expect(embed.description).not.toContain('readable');
      }
      for (const state of ['complete', 'partial', 'failed', 'cancelled']) {
        const embed = renderArchivePublicStatus(snapshot({ state, activities }), t, {
          currentSource: '#readable',
          nowMs: 6000,
        });
        expect(embed.description?.split('\n')).toHaveLength(1);
        expect(embed.description).not.toContain('readable');
        expect(embed.description).not.toContain(t.t('replies:archive.view_step_writing'));
      }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'uses %s safe maintenance steps and recorded counts without inventing totals',
    async (locale) => {
      const t = await translator(locale);
      const progress = snapshot({
        work: 'audit',
        phase: 'repair',
        substep: 'check-messages',
        phases: { repair: { scanned: 543, unit: 'documents', quality: 'unknown' } },
      });
      const embed = renderArchivePublicStatus(progress, t, { nowMs: 6000 });
      expect(embed.description).toContain(t.t('replies:archive.view_substep_check-messages'));
      expect(embed.description).toContain(
        t.t('replies:archive.public_activity_scanned', {
          count: 543,
          unit: t.t('replies:archive.view_unit_documents'),
        }),
      );
      expect(embed.description).not.toMatch(/\/|%|check-messages/);
      const unknown = renderArchivePublicStatus(
        snapshot({ activities: [{ sourceId: 'private', step: 'processing', pageTotal: 0 }] }),
        t,
        { nowMs: 6000 },
      );
      expect(unknown.description).toContain(t.t('replies:archive.view_step_processing'));
      expect(unknown.description).not.toMatch(/0 \/ 0|%|NaN|Infinity/);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'renders identifiable %s source names only after explicit audience-safe resolution',
    async (locale) => {
      const t = await translator(locale);
      const progress = snapshot({
        jobId: 'private-job-id',
        runId: 'private-run-id',
        scanId: 'private-scan-id',
        activities: [
          {
            sourceId: 'private-source-id',
            name: 'confidential-name',
            step: 'writing',
            cursor: 'private-cursor',
          },
        ],
        gaps: [{ sourceId: 'private-source-id', name: 'confidential-name', reason: 'permission' }],
      });
      expect(text(renderArchivePublicStatus(progress, t, { nowMs: 6000 }))).not.toMatch(
        /private-|confidential/,
      );
      const embed = renderArchivePublicStatus(progress, t, {
        currentSource: '#engineering / release-discussion',
        nowMs: 6000,
      });
      expect(text(embed)).toContain('engineering / release\\-discussion');
      expect(text(embed)).not.toMatch(/private-|confidential/);
      const long = renderArchivePublicStatus(progress, t, {
        currentSource: '@everyone [discussion]*'.repeat(100),
        nowMs: 6000,
      });
      expect(text(long)).not.toContain('@everyone');
      expect(text(long)).toContain('…');
      expect(text(long)).toContain('discussion');
      assertBudget(long);
      const malicious = renderArchivePublicStatus(progress, t, {
        currentSource: '#readable\nInjected\u2028line\u2029break\u202ehidden\u2066@everyone',
        nowMs: 6000,
      });
      expect(malicious.description?.split('\n')).toHaveLength(2);
      expect(malicious.description).not.toMatch(/[\u2028-\u202e\u2066-\u2069]|@everyone/);
      expect(malicious.description).toContain('readable Injected line break hidden');
      assertBudget(malicious);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows %s discovery without invented totals or overall percentages',
    async (locale) => {
      const t = await translator(locale);
      const embed = renderArchivePublicStatus(
        snapshot({ sources: { completed: 2, total: 0, quality: 'unknown' } }),
        t,
        { nowMs: 6000 },
      );
      expect(text(embed)).toContain(
        t.t('replies:archive.public_sources_discovering', { count: 2 }),
      );
      expect(text(embed)).not.toMatch(/%|2 \/ 0/);
      const bullets = embed.fields![0]!.value.split('\n');
      expect(bullets.length).toBeGreaterThanOrEqual(3);
      expect(bullets.length).toBeLessThanOrEqual(5);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'keeps %s queued and initial waiting states free of zero progress rows',
    async (locale) => {
      const t = await translator(locale);
      for (const state of ['queued', 'waiting', 'paused']) {
        const embed = renderArchivePublicStatus(
          snapshot({ state, sources: {}, messages: {}, reactions: {}, pausedMs: 2000 }),
          t,
          { nowMs: 6000 },
        );
        expect(embed.fields).not.toContainEqual(
          expect.objectContaining({ name: t.t('replies:archive.public_progress') }),
        );
        expect(text(embed)).not.toMatch(/%|0 \/ 0/);
        expect(embed.footer?.text).toContain('5');
        if (state === 'queued')
          expect(text(embed)).toContain(t.t('replies:archive.public_not_started'));
        else
          expect(text(embed)).toContain(
            t.t('replies:archive.public_wait_duration', {
              elapsed: t.t('replies:archive.public_duration_seconds', { seconds: 2 }),
            }),
          );
      }
    },
  );

  it('distinguishes global waiting from one waiting source and measures its real wait', async () => {
    const t = await translator('en');
    const waiting = {
      sourceId: 'safe-source',
      step: 'waiting',
      waitSince: 3000,
    };
    const embed = renderArchivePublicStatus(snapshot({ activities: [waiting] }), t, {
      nowMs: 6000,
    });
    expect(embed.title).toContain(t.t('replies:archive.view_state_waiting'));
    expect(text(embed)).toContain(
      t.t('replies:archive.public_wait_duration', {
        elapsed: t.t('replies:archive.public_duration_seconds', { seconds: 3 }),
      }),
    );
    const mixed = renderArchivePublicStatus(
      snapshot({ activities: [waiting, { sourceId: 'other', step: 'writing' }] }),
      t,
      { nowMs: 6000 },
    );
    expect(mixed.title).toContain(t.t('replies:archive.view_state_running'));
  });

  it.each(['en', 'zh-TW'] as const)(
    'preserves %s saved repair operations separately from scanned messages after stopping',
    async (locale) => {
      const t = await translator(locale);
      const embed = renderArchivePublicStatus(
        snapshot({
          state: 'partial',
          phase: 'discovery',
          messages: { scanned: 0, inserted: 28, updated: 2 },
          phases: { repair: { unit: 'operations', committed: 1126 } },
          reason: 'invalid-progress-total https://secret.example/token',
          gaps: [{ sourceId: 'private', reason: 'raw exception token' }],
          nextAction: 'resume',
        }),
        t,
        { nowMs: 6000 },
      );
      const content = text(embed);
      expect(content).toContain(t.t('replies:archive.public_messages', { count: 0 }));
      expect(content).toContain(
        t.t('replies:archive.public_operations_confirmed', {
          count: '1,126',
          unit: t.t('replies:archive.view_unit_operations'),
        }),
      );
      expect(content).toContain(t.t('replies:archive.public_writes', { inserted: 28, updated: 2 }));
      expect(content).toContain(t.t('replies:archive.view_public_stopped'));
      expect(content).toContain(t.t('replies:archive.public_reason_other'));
      expect(content).toContain(t.t('replies:archive.view_public_next_resume'));
      expect(content).not.toMatch(/invalid-progress-total|secret\.example|raw exception|private/);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'keeps %s inspected document counts independent from confirmed operations',
    async (locale) => {
      const t = await translator(locale);
      const embed = renderArchivePublicStatus(
        snapshot({
          work: 'audit',
          phase: 'repair',
          sources: {},
          messages: {},
          reactions: {},
          phases: { repair: { scanned: 99, committed: 12, unit: 'documents', quality: 'exact' } },
        }),
        t,
        { nowMs: 6000 },
      );
      expect(text(embed)).toContain(
        t.t('replies:archive.public_records_scanned', {
          count: 99,
          unit: t.t('replies:archive.view_unit_documents'),
        }),
      );
      expect(text(embed)).not.toContain('12');
      expect(text(embed)).not.toContain(
        t.t('replies:archive.public_writes', { inserted: 0, updated: 0 }),
      );
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'preserves %s terminal validation, cutoff and acceptance retention instructions',
    async (locale) => {
      const t = await translator(locale);
      const embed = renderArchivePublicStatus(
        snapshot({ state: 'complete', phase: 'verification', validation }),
        t,
        { nowMs: 6000 },
      );
      const content = text(embed);
      for (const key of ['validation_passed', 'coverage_complete', 'next_review_result'])
        expect(content).toContain(t.t(`replies:archive.view_${key}`));
      expect(content).toContain('<t:1:f>');
      expect(content).toContain('<t:12:f>');
      expect(content).toContain('72');
      const periodic = text(
        renderArchivePublicStatus(snapshot({ work: 'periodic', state: 'complete' }), t, {
          nowMs: 6000,
        }),
      );
      expect(periodic).toContain(t.t('replies:archive.view_periodic_scope'));
      expect(periodic).not.toContain(t.t('replies:archive.view_validation_passed'));
      expect(periodic).not.toContain(t.t('replies:archive.view_next_review_result'));
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'does not invent %s legacy counts, source scope, validation or cutoff',
    async (locale) => {
      const t = await translator(locale);
      const job: ArchiveJob = {
        jobId: 'private-job-id',
        requestId: 'private-request-id',
        guildId: '1',
        command: 'apply',
        options: {},
        status: 'complete',
        cancelRequested: false,
        createdAt: 1000,
      };
      const content = text(
        renderArchivePublicStatus(archiveJobProgress(job, 6000), t, { nowMs: 6000 }),
      );
      expect(content).toContain(t.t('replies:archive.view_counts_unavailable'));
      expect(content).toContain(t.t('replies:archive.view_cutoff_unknown'));
      expect(content).toContain(t.t('replies:archive.view_validation_unavailable'));
      expect(content).toContain(t.t('replies:archive.view_unknown'));
      expect(content).not.toMatch(/%|private-|0 \/ 0|<t:1:f>/);
      const partial = text(
        renderArchivePublicStatus(snapshot({ messageCountQuality: 'lower-bound' }), t, {
          nowMs: 6000,
        }),
      );
      expect(partial).toContain(t.t('replies:archive.public_messages_partial', { count: 12 }));
      expect(partial).toContain(
        t.t('replies:archive.public_writes_partial', { inserted: 8, updated: 1 }),
      );
    },
  );

  it('limits reaction rows to relevant stages and preserves every required row at large counts', async () => {
    const t = await translator('en');
    const repair = renderArchivePublicStatus(snapshot({ phase: 'repair' }), t, { nowMs: 6000 });
    expect(text(repair)).not.toContain(
      t.t('replies:archive.public_reactions', { count: 4, total: 5 }),
    );
    const large = Number.MAX_SAFE_INTEGER;
    const embed = renderArchivePublicStatus(
      snapshot({
        state: 'partial',
        phase: 'verification',
        sources: { completed: large, total: large },
        messages: { scanned: large, inserted: large, updated: large },
        phases: { repair: { committed: large, unit: 'operations' } },
        reactions: { required: large, completed: large },
        validation: { ...validation, coverage: 'timestamps-only' },
      }),
      t,
      { nowMs: 6000 },
    );
    const counters = embed.fields!.find(
      (field) => field.name === t.t('replies:archive.public_progress'),
    )!;
    expect(counters.value.split('\n')).toHaveLength(6);
    expect(text(embed)).toContain('9,007,199,254,740,991');
    expect(text(embed)).toContain(t.t('replies:archive.view_coverage_timestamps-only'));
    assertBudget(embed);
  });

  it('uses the publication timestamp independently from processing activity', async () => {
    const t = await translator('en');
    const embed = renderArchivePublicStatus(
      snapshot({ updatedAt: 1000, lastProgressAt: 1000 }),
      t,
      {
        nowMs: 6000,
        lastSuccessfulUpdateAtMs: 5000,
      },
    );
    expect(embed.timestamp).toBe(new Date(5000).toISOString());
    expect(embed.footer?.text).toBe(
      t.t('replies:archive.public_footer', {
        elapsed: t.t('replies:archive.public_duration_seconds', { seconds: 5 }),
      }),
    );
  });

  it.each(['en', 'zh-TW'] as const)(
    'formats readable %s seconds, minutes and hours while retaining unknown durations',
    async (locale) => {
      const t = await translator(locale);
      for (const [elapsedMs, key, params] of [
        [59000, 'seconds', { seconds: 59 }],
        [61000, 'minutes', { minutes: 1, seconds: 1 }],
        [3661000, 'hours', { hours: 1, minutes: 1 }],
        [100000000, 'hours', { hours: 27, minutes: 46 }],
      ] as const) {
        const embed = renderArchivePublicStatus(snapshot({ elapsedMs }), t, { nowMs: 6000 });
        expect(embed.footer?.text).toBe(
          t.t('replies:archive.public_footer', {
            elapsed: t.t(`replies:archive.public_duration_${key}`, params),
          }),
        );
      }
      const unknown = renderArchivePublicStatus({ ...snapshot(), elapsedMs: Number.NaN }, t, {
        nowMs: 6000,
      });
      expect(unknown.footer?.text).toBe(
        t.t('replies:archive.public_footer', {
          elapsed: t.t('replies:archive.public_duration_unknown'),
        }),
      );
      expect(text(unknown)).not.toContain('NaN');
    },
  );
});
