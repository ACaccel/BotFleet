import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ArchiveButton from '../../../../src/handlers/buttons/archive';
import type { ArchiveControl } from '../../../../src/application/archive/control';
import { ArchiveControlError, type ArchiveControlErrorCode } from '../../../../src/core/errors';
import { err, ok } from '../../../../src/core/result';
import type { ArchiveFullBackupJob } from '../../../../src/core/archive/types';
import {
  buildButtonInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { ADMIN_ID, DEBUG_ID, archiveBot, archiveGuild } from '../archive/fixtures';

// The control service reaches the handler through the injected factory.
const control = {
  confirm: vi.fn(),
  cancelConfirmation: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
  job: vi.fn(),
  latestFullBackup: vi.fn(),
  setPanel: vi.fn(),
  releasePanel: vi.fn(),
  prepareRestart: vi.fn(),
  requestConfirmation: vi.fn(),
  coverage: vi.fn(),
  gapChannels: vi.fn(),
  recentRecords: vi.fn(),
  status: vi.fn(),
  archiveBytes: vi.fn(),
} satisfies Partial<ArchiveControl>;
const rejected = (code: ArchiveControlErrorCode) =>
  err(new ArchiveControlError(code, { operation: 'test' }));

const JOB = '123456789012345678:00000000-0000-4000-8000-000000000000';
const job = (overrides: Partial<ArchiveFullBackupJob> = {}): ArchiveFullBackupJob => ({
  jobId: JOB,
  requestId: 'request',
  guildId: '123456789012345678',
  command: 'full-backup',
  options: { cutoff: 1000 },
  status: 'running',
  cancelRequested: false,
  createdAt: 1000,
  ...overrides,
});
const press = async (
  customId: string,
  userId = ADMIN_ID,
  options: { channelId?: string; ownerId?: string } = {},
) => {
  const sink = newInteractionSink();
  const interaction = buildButtonInteraction({
    customId,
    userId,
    guild: archiveGuild(options.ownerId),
    sink,
  });
  const followUp = vi.fn();
  Object.assign(interaction, {
    channelId: options.channelId ?? DEBUG_ID,
    message: { id: '700' },
    followUp,
  });
  const { bot, logger, createControl } = archiveBot({ control });
  await new ArchiveButton().execute(interaction as ButtonInteraction, bot);
  return { sink, followUp, logger, createControl };
};
const titleOf = (sink: ReturnType<typeof newInteractionSink>) =>
  JSON.stringify((sink.editReplies.at(-1) as { embeds?: unknown } | undefined)?.embeds);

beforeEach(() => {
  vi.clearAllMocks();
  control.latestFullBackup.mockResolvedValue(job());
  control.job.mockResolvedValue(ok(job()));
  control.stop.mockResolvedValue(ok(job()));
  control.cancelConfirmation.mockResolvedValue(ok(undefined));
  control.prepareRestart.mockResolvedValue(ok(undefined));
  control.coverage.mockResolvedValue({ readable: 1, gaps: { denied: 0, deleted: 0, unknown: 0 } });
  control.requestConfirmation.mockResolvedValue({ token: 'T'.repeat(24), expiresAt: 5000 });
  control.gapChannels.mockResolvedValue({ rows: [], total: 0, page: 1, pages: 1 });
});

describe('archive panel buttons', () => {
  it('answers an unknown or retired custom ID as stale', async () => {
    const { sink } = await press('archive|plans|old');
    expect(sink.replies[0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    expect(sink.replies[0]?.content).toContain('replies:archive.navigation_stale');
    expect(sink.editReplies).toEqual([]);
  });

  it('rechecks the admin list on every press', async () => {
    const { sink } = await press(`archive|stop|${JOB}`, '999');
    expect(sink.replies[0]?.content).toContain('replies:archive.permission_denied');
    expect(control.stop).not.toHaveBeenCalled();
    expect(sink.deferUpdates).toEqual([]);
  });

  it('starts the confirmed backup bound to the operator, channel and panel', async () => {
    control.confirm.mockResolvedValue(ok(job({ status: 'queued' })));
    const { sink } = await press(`archive|start|${'T'.repeat(24)}`);
    expect(control.confirm).toHaveBeenCalledWith('T'.repeat(24), {
      userId: ADMIN_ID,
      channelId: DEBUG_ID,
      messageId: '700',
    });
    expect(titleOf(sink)).toContain('replies:archive.backup_state_queued');
  });

  it('stops and resumes the shown backup', async () => {
    control.stop.mockResolvedValue(ok(job({ cancelRequested: true })));
    expect(titleOf((await press(`archive|stop|${JOB}`)).sink)).toContain('backup_state_stopping');
    control.resume.mockResolvedValue(ok(job({ status: 'queued' })));
    await press(`archive|resume|${JOB}`);
    expect(control.resume).toHaveBeenCalledWith(JOB, { channelId: DEBUG_ID, messageId: '700' });
  });

  it('switches a backup panel to gap details and back without the worker overwriting it', async () => {
    await press(`archive|gaps|${JOB}|1`);
    expect(control.setPanel).toHaveBeenCalledWith(JOB, {
      channelId: DEBUG_ID,
      messageId: '700',
      view: 'gaps',
    });
    await press(`archive|progress|${JOB}`);
    expect(control.setPanel).toHaveBeenLastCalledWith(JOB, {
      channelId: DEBUG_ID,
      messageId: '700',
      view: 'progress',
    });
  });

  it('opens a restart confirmation only after control accepts the restart', async () => {
    const { sink } = await press(`archive|restart|${JOB}`);
    expect(control.prepareRestart).toHaveBeenCalledWith(JOB, {
      channelId: DEBUG_ID,
      messageId: '700',
    });
    expect(titleOf(sink)).toContain('replies:archive.confirm_restart_title');
    control.prepareRestart.mockResolvedValueOnce(rejected('ARCHIVE_JOB_NOT_RESUMABLE'));
    const { followUp, sink: refused } = await press(`archive|restart|${JOB}`);
    expect(refused.editReplies).toEqual([]);
    expect(control.requestConfirmation).toHaveBeenCalledOnce();
    expect(followUp.mock.calls[0]?.[0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    expect(followUp.mock.calls[0]?.[0].content).toContain('replies:archive.backup_not_resumable');
  });

  it('keeps the shared panel when an action fails', async () => {
    control.confirm.mockResolvedValue(rejected('ARCHIVE_CONFIRMATION_ACTOR'));
    const { sink, followUp } = await press(`archive|start|${'T'.repeat(24)}`);
    expect(sink.editReplies).toEqual([]);
    expect(followUp.mock.calls[0]?.[0].content).toContain('replies:archive.confirm_actor');
  });

  it.each([
    ['outside the debug channel', ADMIN_ID, { channelId: '999' }, 'replies:archive.debug_only'],
    [
      'by the server owner outside the admin list',
      '400000000000000000',
      { ownerId: '400000000000000000' },
      'replies:archive.permission_denied',
    ],
  ] as const)(
    'refuses a press %s without touching the panel',
    async (_case, userId, options, key) => {
      const { sink } = await press(`archive|stop|${JOB}`, userId, options);
      expect(sink.replies[0]?.content).toContain(key);
      expect(sink.deferUpdates).toEqual([]);
      expect(sink.editReplies).toEqual([]);
      for (const method of Object.values(control)) expect(method).not.toHaveBeenCalled();
    },
  );

  it('cancels a confirmation and closes its panel', async () => {
    const { sink } = await press(`archive|abort|${'T'.repeat(24)}`);
    expect(control.cancelConfirmation).toHaveBeenCalledWith('T'.repeat(24), {
      userId: ADMIN_ID,
      channelId: DEBUG_ID,
      messageId: '700',
    });
    expect(sink.editReplies.at(-1)).toMatchObject({ components: [] });
    expect(titleOf(sink)).toContain('replies:archive.confirm_cancelled');
  });

  it('refreshes status even when the archive size is unavailable, and opens records', async () => {
    control.status.mockResolvedValue({
      schedule: {
        enabled: false,
        intervalMs: 60_000,
        nextRunAt: null,
        running: false,
        revision: 0,
        pauseVersion: 0,
      },
      coverage: { readable: 0, gaps: { denied: 0, deleted: 0, unknown: 0 } },
      inbox: { pending: 0, dead: 0 },
    });
    control.archiveBytes.mockRejectedValue(new Error('collStats denied'));
    const status = await press('archive|status');
    expect(titleOf(status.sink)).toContain('replies:archive.status_title');
    expect(status.followUp).not.toHaveBeenCalled();
    control.recentRecords.mockResolvedValue([job({ status: 'complete' })]);
    const records = await press('archive|records');
    expect(titleOf(records.sink)).toContain('replies:archive.records_title');
  });
});
