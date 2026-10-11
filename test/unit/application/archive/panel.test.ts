import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import { archiveJobProgress } from '../../../../src/core/archive/progress';
import type {
  ArchiveFullBackupJob,
  ArchivePeriodicRecord,
} from '../../../../src/core/archive/types';
import {
  archiveBackupState,
  renderArchiveBackupPanel,
  renderArchiveConfirmPanel,
  renderArchiveGapPage,
  renderArchiveRecords,
  renderArchiveScheduleNotice,
  type ArchivePanel,
} from '../../../../src/application/archive/panel';
import { archivePanelId, parseArchivePanelId } from '../../../../src/application/archive/panel-ids';
import {
  renderArchiveSchedule,
  renderArchiveStatus,
} from '../../../../src/application/archive/panel-status';
import type { ArchiveStatus } from '../../../../src/application/archive/control';
import { ProgressTracker } from '../../../../src/plugins/message-backup/flow/progress';

const translator = (locale: 'en' | 'zh-TW'): Promise<Translator> =>
  createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: locale,
  });
const JOB = '1:00000000-0000-4000-8000-000000000000';
const job = (overrides: Partial<ArchiveFullBackupJob> = {}): ArchiveFullBackupJob => ({
  jobId: JOB,
  requestId: 'request',
  guildId: '1',
  command: 'full-backup',
  options: { cutoff: 1_700_000_000_000 },
  status: 'running',
  cancelRequested: false,
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  ...overrides,
});
const periodic = (
  jobId: string,
  status: ArchivePeriodicRecord['status'],
  gaps: string[] = [],
): ArchivePeriodicRecord => ({
  jobId,
  requestId: jobId,
  guildId: '1',
  command: 'periodic',
  options: { cutoff: 1_700_000_000_000, full: false },
  status,
  result: { cutoff: 1_700_000_000_000, gaps, issueCount: 0 },
  cancelRequested: false,
  createdAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
});
const buttons = (panel: ArchivePanel) =>
  panel.components.flatMap((row) => row.components.map((button) => button.custom_id));
const text = (panel: ArchivePanel) => JSON.stringify(panel.embeds);
/** Every rendered string comes from the catalog: no raw key or placeholder leaks. */
const expectLocalized = (panel: ArchivePanel) =>
  expect(text(panel)).not.toMatch(/replies:|archive\.[a-z_]+|\{\{/);

describe('archive panel custom IDs', () => {
  it.each([
    { kind: 'start', token: 'A'.repeat(24) },
    { kind: 'abort', token: 'b'.repeat(24) },
    { kind: 'stop', jobId: JOB },
    { kind: 'resume', jobId: JOB },
    { kind: 'restart', jobId: JOB },
    { kind: 'progress', jobId: JOB },
    { kind: 'gaps', origin: { kind: 'status' }, page: 3 },
    { kind: 'gaps', origin: { kind: 'job', jobId: JOB }, page: 1 },
    { kind: 'status' },
    { kind: 'records' },
  ] as const)('round-trips $kind within the Discord length limit', (action) => {
    const id = archivePanelId(action);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseArchivePanelId(id)).toEqual(action);
  });

  it.each([
    'archive_panel|job',
    'archive|plans',
    'archive|start|short',
    'archive|gaps|status|0',
    'archive|status|extra',
    'archive|stop|bad id',
  ])('treats %s as stale', (id) => {
    expect(parseArchivePanelId(id)).toBeUndefined();
  });
});

describe('archive panels', () => {
  it.each(['en', 'zh-TW'] as const)('renders every full-backup state in %s', async (locale) => {
    const t = await translator(locale);
    const progress = new ProgressTracker({ cutoff: new Date(0), work: 'full-backup' });
    progress.activity('10', { step: 'writing', name: 'general', scanned: 120_000 });
    const states: [Partial<ArchiveFullBackupJob>, string][] = [
      [{ status: 'queued' }, 'queued'],
      [{ status: 'running' }, 'running'],
      [{ status: 'running', cancelRequested: true }, 'stopping'],
      [{ status: 'complete', result: { gaps: [] } }, 'complete'],
      [{ status: 'complete', result: { gaps: ['20: missing-view-channel'] } }, 'gaps'],
      [{ status: 'cancelled' }, 'stopped'],
      [{ status: 'failed', result: { reason: 'capacity' } }, 'failed'],
    ];
    for (const [overrides, state] of states) {
      const target = job(overrides);
      expect(archiveBackupState(target)).toBe(state);
      const panel = renderArchiveBackupPanel(t, target, progress.snapshot(), {
        now: Date.now(),
        latest: true,
      });
      expectLocalized(panel);
      expect(panel.components[0]?.components.length).toBeLessThanOrEqual(5);
    }
  });

  it('shows the current page, stop control and failure reason', async () => {
    const t = await translator('en');
    const progress = new ProgressTracker({ cutoff: new Date(0), work: 'full-backup' });
    progress.activity('10', { step: 'writing', name: 'general', scanned: 119_950 });
    const running = renderArchiveBackupPanel(t, job(), progress.snapshot(), {
      now: Date.now(),
      latest: true,
    });
    expect(text(running)).toContain('#general page 1,200');
    expect(buttons(running)).toEqual([`archive|stop|${JOB}`, `archive|gaps|${JOB}|1`]);
    const failed = renderArchiveBackupPanel(
      t,
      job({ status: 'failed', result: { reason: 'capacity' } }),
      archiveJobProgress(job({ status: 'failed' })),
      { now: Date.now(), latest: true },
    );
    expect(text(failed)).toContain(t.t('replies:archive.reason_capacity'));
  });

  it('offers resume only on the newest unfinished backup and restart only when asked', async () => {
    const t = await translator('en');
    const stopped = job({ status: 'cancelled' });
    const progress = archiveJobProgress(stopped);
    expect(
      buttons(renderArchiveBackupPanel(t, stopped, progress, { now: 0, latest: true })),
    ).toEqual([`archive|resume|${JOB}`, `archive|gaps|${JOB}|1`]);
    expect(
      buttons(
        renderArchiveBackupPanel(t, stopped, progress, {
          now: 0,
          latest: true,
          offerRestart: true,
        }),
      ),
    ).toEqual([`archive|resume|${JOB}`, `archive|restart|${JOB}`, `archive|gaps|${JOB}|1`]);
    expect(
      buttons(renderArchiveBackupPanel(t, stopped, progress, { now: 0, latest: false })),
    ).toEqual([`archive|gaps|${JOB}|1`]);
    const complete = job({ status: 'complete', result: { gaps: [] } });
    expect(
      buttons(renderArchiveBackupPanel(t, complete, progress, { now: 0, latest: true })),
    ).toEqual([`archive|gaps|${JOB}|1`]);
  });

  it.each(['en', 'zh-TW'] as const)(
    'renders confirmation, gaps, records and notices in %s',
    async (locale) => {
      const t = await translator(locale);
      const confirm = renderArchiveConfirmPanel(t, {
        guildName: 'Guild',
        coverage: { readable: 117, gaps: { denied: 2, deleted: 1, unknown: 0 } },
        restart: true,
        token: 'A'.repeat(24),
        expiresAt: 1_700_000_300_000,
        userId: '11',
      });
      expectLocalized(confirm);
      expect(buttons(confirm)).toEqual([
        `archive|start|${'A'.repeat(24)}`,
        `archive|abort|${'A'.repeat(24)}`,
      ]);
      const gaps = renderArchiveGapPage(
        t,
        {
          rows: [
            { channelId: '1', name: 'gone', access: 'deleted' },
            { channelId: '2', name: 'secret*', access: 'denied' },
            { channelId: '3', name: '', access: 'denied' },
          ],
          total: 13,
          page: 1,
          pages: 2,
        },
        { kind: 'status' },
      );
      expectLocalized(gaps);
      expect(text(gaps)).toContain('#secret\\\\*');
      expect(gaps.components[0]?.components.map((button) => button.disabled ?? false)).toEqual([
        true,
        false,
        false,
      ]);
      const records = renderArchiveRecords(
        t,
        [
          job({ status: 'complete', result: { gaps: ['x'] }, finishedAt: 1_700_000_100_000 }),
          periodic('1:p', 'cancelled'),
          periodic('1:q', 'partial'),
          periodic('1:r', 'complete', ['20: missing-view-channel']),
        ],
        1_700_000_200_000,
      );
      expectLocalized(records);
      for (const kind of ['failing', 'recovered'] as const) {
        const notice = renderArchiveScheduleNotice(
          t,
          { kind, failures: 3, reason: 'permission', createdAt: 1 },
          kind === 'failing' ? 1_700_000_000_000 : null,
        );
        expectLocalized(notice);
        expect(notice.components).toEqual([]);
      }
    },
  );

  it.each(['en', 'zh-TW'] as const)('renders status and schedule in %s', async (locale) => {
    const t = await translator(locale);
    const status: ArchiveStatus = {
      fullBackup: job({ status: 'running' }),
      schedule: {
        enabled: true,
        intervalMs: 86_400_000,
        nextRunAt: 1_700_000_100_000,
        running: false,
        revision: 1,
        pauseVersion: 0,
        lastCompletedAt: 1_700_000_000_000,
      },
      coverage: { readable: 117, gaps: { denied: 2, deleted: 1, unknown: 0 } },
      continuity: { continuousSince: 1_700_000_000_000 },
      inbox: { pending: 0, dead: 0 },
      host: { usedBytes: 42_100_000_000, budgetBytes: 100_000_000_000, measuredAt: 1 },
    };
    const panel = renderArchiveStatus(t, status, 1_600_000_000, 1_700_000_200_000);
    expectLocalized(panel);
    expect(text(panel)).toContain('1.6 GB');
    expect(text(panel)).toContain('42.1 / 100 GB');
    expect(text(panel)).toContain(t.t('replies:archive.periodic_paused'));
    expect(buttons(panel)).toEqual(['archive|status', 'archive|gaps|status|1', 'archive|records']);
    const unknown = renderArchiveStatus(
      t,
      { ...status, fullBackup: undefined, host: undefined, continuity: undefined },
      undefined,
      1_700_000_200_000,
    );
    expectLocalized(unknown);
    expect(text(unknown)).not.toContain(t.t('replies:archive.periodic_paused'));
    const schedule = renderArchiveSchedule(t, status.schedule, {
      requested: true,
      changed: { enabled: true, interval: false },
      backupActive: false,
    });
    expectLocalized(schedule);
  });
});
