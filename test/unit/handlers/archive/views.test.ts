import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveFullBackupJob } from '../../../../src/core/archive/types';
import type { ArchiveAccess } from '../../../../src/handlers/commands/archive-shared/access';
import type { ArchiveControl } from '../../../../src/application/archive/control';
import {
  archiveBackupEntry,
  archiveRecordsView,
  archiveStatusView,
} from '../../../../src/handlers/commands/archive-shared/views';
import { archiveBot } from './fixtures';

const actor = { userId: '11', channelId: '22', messageId: '33' };
const job = (overrides: Partial<ArchiveFullBackupJob> = {}): ArchiveFullBackupJob => ({
  jobId: '1:job',
  requestId: 'job',
  guildId: '1',
  command: 'full-backup',
  options: { cutoff: 1000 },
  status: 'running',
  cancelRequested: false,
  createdAt: 1000,
  ...overrides,
});
const control = {
  latestFullBackup: vi.fn(),
  setPanel: vi.fn(),
  requestConfirmation: vi.fn(),
  coverage: vi.fn(),
  status: vi.fn(),
  archiveBytes: vi.fn(),
  recentRecords: vi.fn(),
} satisfies Partial<ArchiveControl>;
const access = { guildId: '1', guildName: 'Guild', control } as unknown as ArchiveAccess;
const buttons = (panel: Awaited<ReturnType<typeof archiveBackupEntry>>) =>
  panel.components.flatMap((row) => row.components.map((button) => button.custom_id));
const titleOf = (panel: Awaited<ReturnType<typeof archiveBackupEntry>>) =>
  panel.embeds[0]?.title ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  control.requestConfirmation.mockResolvedValue({ token: 'T'.repeat(24), expiresAt: 5000 });
  control.coverage.mockResolvedValue({ readable: 2, gaps: { denied: 1, deleted: 0, unknown: 0 } });
});

describe('/archive backup entry', () => {
  it.each(['queued', 'running'] as const)(
    'moves a %s backup panel to this message without a confirmation',
    async (status) => {
      control.latestFullBackup.mockResolvedValue(job({ status }));
      const panel = await archiveBackupEntry(archiveBot().bot, access, actor);
      expect(control.setPanel).toHaveBeenCalledWith('1:job', {
        channelId: '22',
        messageId: '33',
        view: 'progress',
      });
      expect(control.requestConfirmation).not.toHaveBeenCalled();
      expect(titleOf(panel)).toContain(`replies:archive.backup_state_${status}`);
      expect(buttons(panel)[0]).toBe('archive|stop|1:job');
    },
  );

  it.each(['cancelled', 'partial', 'failed'] as const)(
    'offers resume and start over for a %s backup without moving its panel',
    async (status) => {
      control.latestFullBackup.mockResolvedValue(job({ status }));
      const panel = await archiveBackupEntry(archiveBot().bot, access, actor);
      expect(control.setPanel).not.toHaveBeenCalled();
      expect(control.requestConfirmation).not.toHaveBeenCalled();
      expect(buttons(panel)).toEqual([
        'archive|resume|1:job',
        'archive|restart|1:job',
        'archive|gaps|1:job|1',
      ]);
    },
  );

  it.each([undefined, job({ status: 'complete', result: { cutoff: 1000, gaps: [] } })])(
    'asks for confirmation when no backup is unfinished (%#)',
    async (latest) => {
      control.latestFullBackup.mockResolvedValue(latest);
      const panel = await archiveBackupEntry(archiveBot().bot, access, actor);
      expect(control.requestConfirmation).toHaveBeenCalledWith(actor);
      expect(control.setPanel).not.toHaveBeenCalled();
      expect(titleOf(panel)).toBe('replies:archive.confirm_title');
      expect(buttons(panel)).toEqual([
        `archive|start|${'T'.repeat(24)}`,
        `archive|abort|${'T'.repeat(24)}`,
      ]);
    },
  );
});

describe('/archive status views', () => {
  const status = {
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
  };

  it('keeps the status useful when the archive size cannot be read', async () => {
    control.status.mockResolvedValue(status);
    control.archiveBytes.mockRejectedValue(new Error('not authorized on collStats'));
    const { bot, logger } = archiveBot();
    const panel = await archiveStatusView(bot, access);
    expect(panel.embeds[0]?.description).toContain('replies:archive.value_unknown');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('lists recent records with a way back', async () => {
    control.recentRecords.mockResolvedValue([]);
    const panel = await archiveRecordsView(archiveBot().bot, access);
    expect(panel.embeds[0]?.description).toBe('replies:archive.records_none');
    expect(buttons(panel)).toEqual(['archive|status']);
  });
});
