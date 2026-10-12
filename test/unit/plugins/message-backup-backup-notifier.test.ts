import { describe, expect, it, vi } from 'vitest';
import type { Client, SendableChannels } from 'discord.js';
import type { Translator } from '../../../src/core/i18n';
import { archiveJobProgress } from '../../../src/core/archive/progress';
import type { ArchiveFullBackupJob } from '../../../src/core/archive/types';
import {
  archiveBackupNotifiers,
  type ArchiveBackupPanelStore,
  deliverArchiveScheduleNotice,
  isPermanentDiscordFailure,
} from '../../../src/plugins/message-backup/runtime/backup-notifier';
import type { ArchiveScheduleNotice } from '../../../src/core/archive/schedule';
import type { ArchiveScheduleRepo } from '../../../src/persistence/repositories/archive-schedule.repo';

const translator = { t: (key: string) => key } as Translator;
const NOW = 1_000_000;
const failing = (extra: Partial<ArchiveScheduleNotice> = {}): ArchiveScheduleNotice =>
  ({
    kind: 'failing',
    failures: 3,
    reason: 'permission',
    createdAt: 7,
    ...extra,
  }) as ArchiveScheduleNotice;
const store = (notice?: ArchiveScheduleNotice) => {
  const calls = {
    markNoticeDelivered: vi.fn(),
    deferNotice: vi.fn(),
    abandonNotice: vi.fn(),
  };
  return {
    ...calls,
    schedule: {
      read: vi.fn().mockResolvedValue({ nextRunAt: 5000, notice }),
      ...calls,
    } as unknown as ArchiveScheduleRepo,
  };
};
const channel = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as SendableChannels;

describe('periodic health notices', () => {
  it('sends a pending notice once and marks exactly that notice delivered', async () => {
    const target = store(failing());
    const send = vi.fn().mockResolvedValue({});
    expect(
      await deliverArchiveScheduleNotice(target.schedule, channel(send), translator, NOW),
    ).toEqual({ kind: 'sent' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
    expect(target.markNoticeDelivered).toHaveBeenCalledWith(7, 'schedule');
  });

  it('defers a failed send with a capped, growing backoff', async () => {
    const send = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const first = store(failing());
    expect(
      await deliverArchiveScheduleNotice(first.schedule, channel(send), translator, NOW),
    ).toMatchObject({ kind: 'deferred', retryAt: NOW + 60_000 });
    expect(first.deferNotice).toHaveBeenCalledWith(7, 1, NOW + 60_000, 'schedule');
    const late = store(failing({ attempts: 9 }));
    await deliverArchiveScheduleNotice(late.schedule, channel(send), translator, NOW);
    expect(late.deferNotice).toHaveBeenCalledWith(7, 10, NOW + 3_600_000, 'schedule');
    expect(first.markNoticeDelivered).not.toHaveBeenCalled();
  });

  it.each([10003, 50001, 50013])(
    'abandons a notice Discord refuses permanently (%i)',
    async (code) => {
      const target = store(failing());
      const send = vi.fn().mockRejectedValue(Object.assign(new Error('refused'), { code }));
      expect(
        (await deliverArchiveScheduleNotice(target.schedule, channel(send), translator, NOW)).kind,
      ).toBe('abandoned');
      expect(target.abandonNotice).toHaveBeenCalledWith(7, 'schedule');
      expect(target.deferNotice).not.toHaveBeenCalled();
    },
  );

  it('waits for the retry time and skips delivered, abandoned or absent notices', async () => {
    const send = vi.fn();
    for (const notice of [
      undefined,
      failing({ deliveredAt: 8 }),
      failing({ abandonedAt: 8 }),
      failing({ retryAt: NOW + 1 }),
    ])
      expect(
        await deliverArchiveScheduleNotice(store(notice).schedule, channel(send), translator, NOW),
      ).toEqual({ kind: 'none' });
    expect(
      await deliverArchiveScheduleNotice(store(failing()).schedule, undefined, translator, NOW),
    ).toEqual({ kind: 'none' });
    expect(send).not.toHaveBeenCalled();
  });

  it('treats only gone or forbidden targets as permanent', () => {
    for (const code of [10003, 10008, 50001, 50013])
      expect(isPermanentDiscordFailure({ code })).toBe(true);
    for (const error of [{ code: 500 }, { status: 503 }, new Error('x'), undefined])
      expect(isPermanentDiscordFailure(error)).toBe(false);
  });
});

describe('full-backup panel publisher', () => {
  const JOB = '1:job';
  const snapshot = archiveJobProgress({
    jobId: JOB,
    requestId: 'job',
    guildId: '1',
    command: 'full-backup',
    options: { cutoff: 1000 },
    status: 'running',
    cancelRequested: false,
    createdAt: 1000,
  });
  const backup = (overrides: Partial<ArchiveFullBackupJob> = {}): ArchiveFullBackupJob => ({
    jobId: JOB,
    requestId: 'job',
    guildId: '1',
    command: 'full-backup',
    options: { cutoff: 1000 },
    status: 'running',
    cancelRequested: false,
    createdAt: 1000,
    notification: { channelId: '22', messageId: '33', view: 'progress' },
    ...overrides,
  });
  // The publisher reads and writes job records only through the injected store.
  const publisher = (job: ArchiveFullBackupJob | undefined, patch = vi.fn()) => {
    const jobs = {
      findFullBackup: vi.fn(async (): Promise<ArchiveFullBackupJob | undefined> => job),
      releasePanel: vi.fn(async () => undefined),
      markPanelDelivered: vi.fn(async () => undefined),
    } satisfies ArchiveBackupPanelStore;
    const client = { rest: { patch } } as unknown as Client;
    return { jobs, patch, notifiers: archiveBackupNotifiers(client, translator)(jobs) };
  };

  it('skips a job without a panel message', async () => {
    const { notifiers, patch } = publisher(backup({ notification: { channelId: '22' } }));
    expect(await notifiers.publish(JOB, snapshot)).toBe('skipped');
    expect(patch).not.toHaveBeenCalled();
  });

  it('edits the panel and records a terminal status as delivered', async () => {
    const { notifiers, patch, jobs } = publisher(backup({ status: 'complete' }));
    expect(await notifiers.publish(JOB, snapshot)).toBe('delivered');
    expect(patch).toHaveBeenCalledOnce();
    expect(jobs.markPanelDelivered).toHaveBeenCalledWith(JOB, '33', 'complete');
  });

  it('skips a panel the operator moved since the first read', async () => {
    const { notifiers, patch, jobs } = publisher(backup());
    jobs.findFullBackup
      .mockResolvedValueOnce(backup())
      .mockResolvedValueOnce(
        backup({ notification: { channelId: '22', messageId: '77', view: 'progress' } }),
      );
    expect(await notifiers.publish(JOB, snapshot)).toBe('skipped');
    expect(patch).not.toHaveBeenCalled();
    expect(jobs.markPanelDelivered).not.toHaveBeenCalled();
  });

  it('does not mark a running backup delivered', async () => {
    const { notifiers, patch, jobs } = publisher(backup({ status: 'running' }));
    expect(await notifiers.publish(JOB, snapshot)).toBe('delivered');
    expect(patch).toHaveBeenCalledOnce();
    expect(jobs.markPanelDelivered).not.toHaveBeenCalled();
  });

  it('leaves a gap page an operator opened alone', async () => {
    const { notifiers, patch } = publisher(
      backup({ notification: { channelId: '22', messageId: '33', view: 'gaps' } }),
    );
    expect(await notifiers.publish(JOB, snapshot)).toBe('skipped');
    expect(patch).not.toHaveBeenCalled();
  });

  it('releases a panel Discord refused permanently and rethrows other failures', async () => {
    const refused = publisher(backup(), vi.fn().mockRejectedValue({ code: 10008 }));
    expect(await refused.notifiers.publish(JOB, snapshot)).toBe('released');
    expect(refused.jobs.releasePanel).toHaveBeenCalledWith(JOB, '33');
    const transient = publisher(backup(), vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(transient.notifiers.publish(JOB, snapshot)).rejects.toThrow('timeout');
    expect(transient.jobs.releasePanel).not.toHaveBeenCalled();
  });
});
