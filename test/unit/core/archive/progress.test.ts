import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { archiveJobProgress, sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import type { ArchiveJob } from '../../../../src/core/archive/types';
import { renderArchiveProgress } from '../../../../src/core/archive/progress-renderer';
import {
  ProgressNotifier,
  ProgressTracker,
} from '../../../../src/plugins/message-backup/flow/progress';

const translator = (locale: 'en' | 'zh-TW') =>
  createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: locale,
  });
const tracker = () =>
  new ProgressTracker({
    cutoff: new Date(1000),
    startedAt: 1000,
    work: 'audit',
    jobId: '1:job',
    runId: 'run',
    clock: () => 6000,
  });

describe('truthful bounded archive progress', () => {
  it('selects recent active work without changing stable source pagination', () => {
    let now = 1000;
    const progress = new ProgressTracker({
      cutoff: new Date(1000),
      startedAt: 1000,
      work: 'audit',
      clock: () => now,
    });
    progress.activity('10', { step: 'writing' });
    now = 2000;
    progress.activity('11', { step: 'writing' });
    now = 3000;
    progress.activity('12', { step: 'waiting', waitSince: now, retryAt: 9000 });
    expect(progress.snapshot().activities.map((item) => item.sourceId)).toEqual(['11', '10', '12']);
    now = 4000;
    progress.activity('10', { pageProcessed: 25, pageTotal: 100 });
    expect(progress.snapshot().activities[0]).toMatchObject({
      sourceId: '10',
      startedAt: 1000,
      updatedAt: 4000,
    });
    expect(progress.activityDetails().map((item) => item.sourceId)).toEqual(['10', '11', '12']);
  });

  it('clears stale wait, page and membership details as the source resumes fetching', () => {
    const progress = tracker();
    progress.activity('10', {
      step: 'reactions',
      pageProcessed: 2,
      pageTotal: 100,
      reactionUsers: 100,
      reactionPages: 1,
      provisional: true,
    });
    progress.activity('10', { step: 'waiting', waitSince: 5000, retryAt: 9000 });
    expect(progress.snapshot().activities[0]).toMatchObject({
      reactionUsers: 100,
      reactionPages: 1,
    });
    progress.activity('10', { step: 'reactions', reactionUsers: 101, reactionPages: 2 });
    expect(progress.snapshot().activities[0]?.waitSince).toBeUndefined();
    expect(progress.snapshot().activities[0]?.retryAt).toBeUndefined();
    progress.activity('10', { step: 'fetching' });
    const activity = progress.snapshot().activities[0]!;
    for (const key of [
      'pageProcessed',
      'pageTotal',
      'reactionUsers',
      'reactionPages',
      'provisional',
    ] as const)
      expect(activity[key]).toBeUndefined();
  });

  it('omits invalid optional activity counts instead of displaying invented zeroes', () => {
    const progress = tracker();
    progress.activity('10', { step: 'reactions' });
    const snapshot = progress.snapshot();
    snapshot.activities[0] = {
      ...snapshot.activities[0]!,
      pageProcessed: NaN,
      pageTotal: Infinity,
      reactionUsers: -1,
      reactionPages: NaN,
    };
    const activity = sanitizeArchiveProgress(snapshot)!.activities[0]!;
    for (const key of ['pageProcessed', 'pageTotal', 'reactionUsers', 'reactionPages'] as const)
      expect(activity[key]).toBeUndefined();
  });

  it.each(['en', 'zh-TW'] as const)(
    'keeps %s source pages actionable without routine identities or checkpoints',
    async (locale) => {
      const t = await translator(locale);
      const progress = tracker();
      progress.activity('source-11', {
        name: 'source',
        step: 'writing',
        cursor: 'hidden-checkpoint',
        pageProcessed: 42,
        pageTotal: 100,
        provisional: true,
      });
      progress.gap({ sourceId: 'source-12', reason: 'permission' });
      const snapshot = progress.snapshot();
      snapshot.jobId = 'hidden-job';
      snapshot.runId = 'hidden-run';
      snapshot.scanId = 'hidden-scan';
      const footer = t.t('replies:archive.progress_page_next', { page: 2, nextPage: 3 });
      const content = renderArchiveProgress(snapshot, t, 6000, {
        sourcePage: true,
        footerLines: [footer],
      });
      expect(content.length).toBeLessThanOrEqual(1900);
      expect(content).not.toMatch(/hidden-job|hidden-run|hidden-scan|hidden-checkpoint/);
      expect(content.replace(/\\/g, '')).toContain('source-11');
      expect(content.replace(/\\/g, '')).toContain('source-12');
      expect(content).toContain(t.t('replies:archive.view_detail_gap_permission'));
      expect(content).toContain(
        t.t('replies:archive.view_provisional', { count: '42', total: '100' }),
      );
      expect(content).toContain(footer);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'renders every lifecycle state and exact zero work in %s',
    async (locale) => {
      const t = await translator(locale);
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
      ] as const) {
        const progress = tracker();
        progress.report('repair', 0, 0, 'exact', 'documents', 'check-messages', 'messages');
        const snapshot = { ...progress.snapshot(), state };
        const content = renderArchiveProgress(snapshot, t, 6000);
        expect(content).toContain(t.t(`replies:archive.view_state_${state}`));
        expect(content).toContain('1:job');
        expect(content.length).toBeLessThanOrEqual(1900);
        expect(content).not.toMatch(/archive\.|\{\{|NaN|Infinity/);
        if (['complete', 'partial', 'failed', 'cancelled'].includes(state))
          expect(content).not.toContain(t.t('replies:archive.view_eta_unknown'));
        if (state !== 'queued') expect(content).toContain('100%');
      }
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'renders real %s text and preserves long identity footers',
    async (locale) => {
      const t = await translator(locale);
      const progress = tracker();
      progress.report('repair', 12, 100, 'estimated', 'documents', 'check-messages', 'messages');
      progress.activity('10', {
        name: '@everyone [private]*'.repeat(20),
        step: 'writing',
        pageProcessed: 42,
        pageTotal: 100,
        provisional: true,
      });
      progress.gap({ sourceId: '10', name: '@everyone [source]', reason: 'permission' });
      const snapshot = progress.snapshot();
      snapshot.jobId = 'j'.repeat(160);
      snapshot.runId = 'r'.repeat(160);
      snapshot.scanId = 's'.repeat(160);
      const content = renderArchiveProgress(snapshot, t);
      expect(content.length).toBeLessThanOrEqual(1900);
      for (const id of [snapshot.jobId, snapshot.runId, snapshot.scanId])
        expect(content).toContain(id);
      expect(content).not.toMatch(/archive\.|\{\{|@everyone|12\s*\/\s*100/);
      expect(content).toContain('12');
      expect(content).not.toContain(locale === 'en' ? 'awaiting checkpoint' : '尚未確認完成');
      const details = renderArchiveProgress(snapshot, t, 6000, { details: true });
      expect(details).toContain('100');
      expect(details).toContain(locale === 'en' ? 'awaiting checkpoint' : '尚未確認完成');
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows current checks independently of a completed scan in %s',
    async (locale) => {
      const progress = tracker();
      progress.report('repair', 20, 20, 'exact', 'documents', 'check-messages', 'scan');
      progress.report(
        'verification',
        2,
        undefined,
        'unknown',
        'checks',
        'validate-manifest',
        'verification',
      );
      const content = renderArchiveProgress(progress.snapshot(), await translator(locale), 6000);
      expect(content).toContain('20');
      expect(content).toContain('2');
      expect(content).toContain(locale === 'en' ? 'validate the planned changes' : '驗證計畫變更');
      expect(content).toContain(locale === 'en' ? 'checks' : '檢查');
    },
  );

  it('sanitizes unknown versions, raw errors, untrusted substeps and invalid timestamps', async () => {
    const progress = tracker().snapshot();
    expect(sanitizeArchiveProgress({ ...progress, version: 999 })).toBeUndefined();
    const safe = sanitizeArchiveProgress({
      ...progress,
      updatedAt: 1e300,
      nextRunAt: 1e300,
      substep: 'secret-error',
      reason: 'secret-error',
      gaps: [{ reason: 'https://secret.invalid', name: 'allowed source' }],
    })!;
    expect(safe.updatedAt).toBe(0);
    expect(safe.nextRunAt).toBe(0);
    expect(safe.substep).toBe('discovery');
    expect(JSON.stringify(safe)).not.toContain('secret');
    expect(renderArchiveProgress(safe, await translator('en'))).not.toContain('Invalid Date');
  });

  it('reports only local waits and never hides an active source behind a global waiting state', async () => {
    const progress = tracker();
    progress.activity('10', { name: 'waiting', step: 'waiting', retryAt: 9000, waitSince: 5000 });
    progress.activity('11', { name: 'writing', step: 'writing' });
    const t = await translator('en');
    const content = renderArchiveProgress(progress.snapshot(), t, 6000);
    expect(content).toContain('3');
    expect(content).toContain('writing');
    expect(progress.snapshot().state).toBe('running');
    progress.activity('11', undefined);
    expect(progress.snapshot().state).toBe('waiting');
  });

  it('fails explicitly at bounded metadata limits rather than silently undercounting', () => {
    const progress = tracker();
    for (let i = 0; i < 64; i += 1) progress.activity(String(i), { step: 'processing' });
    expect(() => progress.activity('65', { step: 'processing' })).toThrow('bound exceeded');
    expect(progress.snapshot().activityCount).toBe(64);
  });

  it.each(['en', 'zh-TW'] as const)(
    'keeps queued %s summaries free of zero counters and completion claims',
    async (locale) => {
      const t = await translator(locale);
      const content = renderArchiveProgress({ ...tracker().snapshot(), state: 'queued' }, t, 6000);
      expect(content).toContain(t.t('replies:archive.view_queued', { elapsed: 5 }));
      expect(content).toContain('/archive jobs');
      expect(content).not.toContain(t.t('replies:archive.view_phase', { phase: '' }));
      expect(content).not.toContain('%');
      expect(content).not.toContain(t.t('replies:archive.view_validation_passed'));
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows human %s summaries and reserves low-level counters for details',
    async (locale) => {
      const t = await translator(locale);
      const progress = new ProgressTracker({
        work: 'periodic',
        cutoff: new Date(1000),
        clock: () => 6000,
      });
      progress.setPhase('history');
      progress.setSources(4);
      progress.completeSource('10');
      progress.messageCounts({
        scanned: 12,
        admitted: 10,
        excluded: 2,
        durable: 10,
        inserted: 7,
        updated: 2,
        unchanged: 1,
      });
      progress.setExtras({ live: { pending: 8, oldestAgeMs: 1000, windowMs: 1000 } });
      progress.activity('11', { name: 'source', step: 'processing', cursor: 'secret-cursor' });
      const snapshot = progress.snapshot();
      const content = renderArchiveProgress(snapshot, t, 6000);
      expect(content).toContain('25%');
      expect(content).toContain(locale === 'en' ? 'total not yet known' : '總數尚未確認');
      expect(content).not.toContain(locale === 'en' ? 'estimating percentage' : '百分比估算');
      expect(content).toContain(t.t('replies:archive.view_excluded', { count: 2 }));
      expect(content).not.toContain(locale === 'en' ? 'Live inbox' : '即時收錄佇列');
      expect(content).not.toContain(locale === 'en' ? 'Pending data work' : '等待資料處理');
      expect(content).not.toContain('secret-cursor');
      const details = renderArchiveProgress(snapshot, t, 6000, { details: true });
      expect(details).toContain('secret-cursor');
      expect(details).toContain(locale === 'en' ? 'Live inbox' : '即時收錄佇列');
      expect(details).toContain(locale === 'en' ? 'Pending data work' : '等待資料處理');
      const complete = renderArchiveProgress(
        { ...snapshot, state: 'complete', nextRunAt: 12000 },
        t,
        6000,
      );
      expect(complete).toContain(
        t.t('replies:archive.view_writes', { inserted: 7, updated: 2, unchanged: 1 }),
      );
      expect(complete).toContain(t.t('replies:archive.view_periodic_scope'));
      expect(complete).toContain('<t:12:f>');
      expect(complete).not.toContain(t.t('replies:archive.view_validation_passed'));
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows %s cancellation and restoration impacts before detail truncation',
    async (locale) => {
      const t = await translator(locale);
      const snapshot = tracker().snapshot();
      snapshot.jobId = 'j'.repeat(160);
      snapshot.runId = 'r'.repeat(160);
      snapshot.scanId = 's'.repeat(160);
      snapshot.activities = [1, 2, 3].map((id) => ({
        sourceId: String(id),
        name: 'long-source'.repeat(12),
        step: 'writing',
        scanned: 9,
        updatedAt: 6000,
        startedAt: 1000,
      }));
      const options = {
        details: true,
        footerLines: ['f'.repeat(300), 'g'.repeat(300), 'h'.repeat(300)],
      };
      for (const state of ['cancelling', 'cancelled'] as const) {
        const content = renderArchiveProgress({ ...snapshot, state }, t, 6000, options);
        expect(content).toContain(t.t('replies:archive.view_cancelled_writes'));
        expect(content).toContain('/archive jobs');
        expect(content).not.toContain('/archive status');
        expect(content.length).toBeLessThanOrEqual(1900);
        for (const id of [snapshot.jobId, snapshot.runId, snapshot.scanId])
          expect(content).toContain(id);
      }
      const fallbackOptions = { ...options, contextLines: ['context'.repeat(60)] };
      const legacyJob = renderArchiveProgress(
        { ...snapshot, jobId: undefined },
        t,
        6000,
        fallbackOptions,
      );
      expect(legacyJob).toContain('/archive jobs');
      expect(legacyJob).not.toContain('/archive schedule status');
      const periodic = renderArchiveProgress(
        { ...snapshot, jobId: undefined, work: 'periodic' },
        t,
        6000,
        fallbackOptions,
      );
      expect(periodic).toContain('/archive schedule status page:1');
      expect(periodic).not.toContain('/archive status');
      const restored = renderArchiveProgress(
        {
          ...snapshot,
          work: 'rollback',
          state: 'complete',
          outcomes: { restored: 5, conflicts: 2, skipped: 1 },
        },
        t,
        6000,
      );
      expect(restored).toContain(t.t('replies:archive.view_rollback_impact'));
      expect(restored).toContain(
        t.t('replies:archive.view_rollback', { restored: 5, conflicts: 2, skipped: 1 }),
      );
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'keeps %s failures and actionable next steps ahead of counters',
    async (locale) => {
      const progress = tracker();
      progress.gap({ sourceId: '10', name: 'source', reason: 'permission' });
      progress.report('repair', 3, 9, 'exact', 'operations', 'apply-manifest', 'repair');
      const t = await translator(locale);
      const content = renderArchiveProgress(
        { ...progress.snapshot(), work: 'apply', state: 'partial', nextAction: 'resume' },
        t,
        6000,
      );
      expect(content.indexOf(t.t('replies:archive.view_scope', { count: 1 }))).toBeLessThan(
        content.indexOf(t.t('replies:archive.view_phase', { phase: '' })),
      );
      expect(content).toContain(t.t('replies:archive.view_next_resume'));
      expect(content).toContain(t.t('replies:archive.view_gap_permission'));
      expect(content).toContain(t.t('replies:archive.view_validation_unavailable'));
      expect(content).not.toContain(t.t('replies:archive.view_validation_passed'));
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'describes %s attachment outcomes without metadata or unsupported validation claims',
    async (locale) => {
      const progress = new ProgressTracker({
        work: 'refresh-attachment',
        cutoff: new Date(1000),
        clock: () => 6000,
      });
      progress.report('repair', 3, 3, 'exact', 'checks', 'attachment-write', 'attachment');
      const t = await translator(locale);
      const content = renderArchiveProgress({ ...progress.snapshot(), state: 'complete' }, t, 6000);
      expect(content).toContain(t.t('replies:archive.view_attachment_complete'));
      expect(content).not.toContain('metadata');
      expect(content).not.toContain(t.t('replies:archive.view_validation_passed'));
      expect(content).not.toContain('100%');
    },
  );
});

const validationJob = (
  command: ArchiveJob['command'],
  result: Record<string, unknown>,
): ArchiveJob => ({
  jobId: 'job',
  requestId: 'request',
  guildId: 'guild',
  command,
  options: {},
  status: 'complete',
  cancelRequested: false,
  createdAt: 1000,
  startedAt: 1000,
  finishedAt: 6000,
  runId: 'run',
  result,
});
const verificationResult = () => ({
  status: 'complete',
  counts: {
    pending: 0,
    unresolvedEvidence: 0,
    invalidManifestOperations: 0,
    missingDependencies: 0,
  },
  issues: [],
  details: { coverage: { status: 'complete' } },
});

describe('archive validation evidence', () => {
  it('rejects malformed validation metadata and never treats outstanding checks as passed', () => {
    const snapshot = tracker().snapshot();
    expect(
      sanitizeArchiveProgress({ ...snapshot, validation: { state: 'passed' } })?.validation,
    ).toBeUndefined();
    expect(
      sanitizeArchiveProgress({
        ...snapshot,
        validation: {
          state: 'passed',
          checks: {
            pendingOperations: 1,
            unresolvedEvidence: 0,
            invalidOperations: 0,
            missingDependencies: 0,
          },
        },
      })?.validation?.state,
    ).toBe('incomplete');
    expect(
      archiveJobProgress(
        validationJob('verify', { status: 'complete', counts: verificationResult().counts }),
        6000,
      ).validation,
    ).toBeUndefined();
  });

  it.each(['apply', 'resume', 'verify', 'accept'] as const)(
    'requires explicit verification counts for %s',
    (command) => {
      const snapshot = archiveJobProgress(validationJob(command, verificationResult()), 6000);
      expect(snapshot.validation).toMatchObject({
        state: 'passed',
        coverage: 'complete',
        checks: {
          pendingOperations: 0,
          unresolvedEvidence: 0,
          invalidOperations: 0,
          missingDependencies: 0,
        },
      });
      expect(
        archiveJobProgress(
          validationJob(command, { status: 'complete', counts: {}, issues: [] }),
          6000,
        ).validation,
      ).toBeUndefined();
      expect(
        archiveJobProgress(
          validationJob(command, {
            ...verificationResult(),
            counts: { ...verificationResult().counts, pending: Number.NaN },
          }),
          6000,
        ).validation,
      ).toBeUndefined();
    },
  );

  it('does not infer validation from completed progress phases or unrelated commands', () => {
    const progress = tracker();
    progress.report('verification', 10, 10, 'exact', 'checks', 'validate-manifest', 'verification');
    for (const phase of ['discovery', 'history', 'reactions', 'repair'] as const)
      progress.setTotal(phase, 0);
    progress.finish('complete');
    const snapshot = archiveJobProgress(
      validationJob('apply', { progress: progress.snapshot(), status: 'complete', counts: {} }),
      6000,
    );
    expect(snapshot.validation).toBeUndefined();
    for (const command of ['audit', 'plan', 'rollback', 'refresh-attachment'] as const)
      expect(
        archiveJobProgress(validationJob(command, verificationResult()), 6000).validation,
      ).toBeUndefined();
  });

  it('retains incomplete validation and limited timestamp-only coverage', () => {
    const result = {
      ...verificationResult(),
      status: 'partial',
      counts: { ...verificationResult().counts, pending: 2 },
      issues: ['Unverified repair operations remain'],
      details: { coverage: { status: 'complete', details: { scope: 'timestamps-only' } } },
    };
    const snapshot = archiveJobProgress(
      { ...validationJob('verify', result), status: 'partial' },
      6000,
    );
    expect(snapshot.validation).toMatchObject({
      state: 'incomplete',
      coverage: 'timestamps-only',
      checks: { pendingOperations: 2 },
    });
    const incompleteCoverage = archiveJobProgress(
      {
        ...validationJob('verify', { ...result, details: { coverage: { status: 'partial' } } }),
        status: 'partial',
      },
      6000,
    );
    expect(incompleteCoverage.validation?.coverage).toBe('incomplete');
  });

  it.each(['en', 'zh-TW'] as const)(
    'renders truthful %s legacy and accepted validation results',
    async (locale) => {
      const t = await translator(locale);
      const legacy = archiveJobProgress(
        validationJob('apply', { status: 'complete', counts: {} }),
        6000,
      );
      const content = renderArchiveProgress(legacy, t, 6000);
      expect(content).toContain(t.t('replies:archive.view_validation_unavailable'));
      expect(content).toContain(t.t('replies:archive.view_counts_unavailable'));
      expect(content).not.toContain(t.t('replies:archive.view_none_verified'));
      expect(content).not.toContain('100%');
      const accepted = archiveJobProgress(
        validationJob('accept', {
          status: 'complete',
          counts: {},
          issues: [],
          details: { acceptedAt: 2000, expiresAt: 12000 },
        }),
        6000,
      );
      expect(accepted.validation).toEqual({
        state: 'previously-accepted',
        recoveryExpiresAt: 12000,
      });
      expect(renderArchiveProgress(accepted, t, 6000)).toContain(
        t.t('replies:archive.view_validation_previously-accepted'),
      );
      expect(renderArchiveProgress(accepted, t, 6000)).toContain('<t:12:f>');
      const verified = archiveJobProgress(validationJob('apply', verificationResult()), 6000);
      const rendered = renderArchiveProgress(verified, t, 6000, { details: true });
      expect(rendered).toContain(t.t('replies:archive.view_validation_passed'));
      expect(rendered).toContain(t.t('replies:archive.view_coverage_complete'));
      expect(rendered).toContain(
        t.t('replies:archive.view_validation_checks', {
          pending: 0,
          unresolved: 0,
          invalid: 0,
          dependencies: 0,
        }),
      );
      const audit = renderArchiveProgress(
        archiveJobProgress(
          validationJob('audit', { status: 'complete', counts: { total: 0 } }),
          6000,
        ),
        t,
        6000,
      );
      expect(audit).not.toContain(t.t('replies:archive.view_counts_lower_bound'));
    },
  );
});

describe('decoupled progress publication', () => {
  it('keeps one pending latest value during a slow sender and drains the newest generation', async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: number[] = [];
    const notifier = new ProgressNotifier<number>(async (value) => {
      sent.push(value);
      if (value === 0) await block;
    }, 10000);
    await notifier.update(0, true);
    for (let i = 1; i <= 1000; i += 1) await notifier.update(i, true);
    expect(notifier.snapshot()).toMatchObject({ pending: 1, sending: true });
    release();
    await notifier.drain();
    expect(sent).toEqual([0, 1000]);
    await notifier.stop();
    await notifier.update(1001, true);
    expect(sent).toEqual([0, 1000]);
  });

  it('retries a failed sender after five seconds with the latest snapshot', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (value: number) => {
      if (value === 1) throw new Error('delivery unavailable');
    });
    const notifier = new ProgressNotifier(send, 10000);
    try {
      await notifier.update(1, true);
      await Promise.resolve();
      await Promise.resolve();
      await notifier.update(2, true);
      await vi.advanceTimersByTimeAsync(4999);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await notifier.drain();
      expect(send.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    } finally {
      await notifier.stop();
      vi.useRealTimers();
    }
  });
});
