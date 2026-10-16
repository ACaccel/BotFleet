import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { ArchiveAccess } from '../../../../src/handlers/commands/archive-shared/access';
import type { ArchiveControl } from '../../../../src/application/archive/control';
import { executeArchiveSchedule } from '../../../../src/handlers/commands/archive/schedule';
import { buildChatInputInteraction } from '../../../fixtures/discord/interaction-builder';
import { archiveBot } from './fixtures';

const saved = {
  enabled: false,
  intervalMs: 3_600_000,
  nextRunAt: null,
  running: false,
  revision: 0,
  pauseVersion: 0,
};
const access = (
  after = saved,
  latest?: { status: string },
): { access: ArchiveAccess; update: ReturnType<typeof vi.fn> } => {
  const update = vi.fn().mockResolvedValue(after);
  return {
    update,
    access: {
      guildId: '1',
      guildName: 'guild',
      control: {
        readSchedule: vi.fn().mockResolvedValue(saved),
        updateSchedule: update,
        latestFullBackup: vi.fn().mockResolvedValue(latest),
      } satisfies Partial<ArchiveControl>,
    } as unknown as ArchiveAccess,
  };
};
const command = (options: { enabled?: boolean; minutes?: number }): ChatInputCommandInteraction => {
  return buildChatInputInteraction({
    commandName: 'archive',
    options: {
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.minutes === undefined ? {} : { minutes: options.minutes }),
    },
  });
};
const describeOf = (panel: Awaited<ReturnType<typeof executeArchiveSchedule>>) =>
  panel.embeds[0]?.description ?? '';

describe('/archive schedule', () => {
  it('shows the schedule without changing it when no option is given', async () => {
    const { access: target, update } = access();
    const panel = await executeArchiveSchedule(command({}), archiveBot().bot, target);
    expect(update).not.toHaveBeenCalled();
    expect(describeOf(panel)).not.toContain('schedule_note');
    expect(describeOf(panel)).toContain('replies:archive.schedule_disabled');
  });

  it('changes only the interval when only minutes are given and marks the change', async () => {
    const { access: target, update } = access({ ...saved, intervalMs: 1_440 * 60_000 });
    const panel = await executeArchiveSchedule(
      command({ minutes: 1_440 }),
      archiveBot().bot,
      target,
    );
    expect(update).toHaveBeenCalledWith({ intervalMs: 86_400_000 });
    expect(describeOf(panel)).toContain(
      '"minutes":"1,440","marker":"replies:archive.schedule_changed_marker"',
    );
    expect(describeOf(panel)).toContain('replies:archive.schedule_note_changed');
  });

  it('explains a disable and notes that a running full backup pauses periodic backup', async () => {
    const { access: target, update } = access({ ...saved, enabled: false }, { status: 'running' });
    const enabled = { ...saved, enabled: true };
    Object.assign(target.control, { readSchedule: vi.fn().mockResolvedValue(enabled) });
    const panel = await executeArchiveSchedule(
      command({ enabled: false }),
      archiveBot().bot,
      target,
    );
    expect(update).toHaveBeenCalledWith({ enabled: false });
    expect(describeOf(panel)).toContain('replies:archive.schedule_note_disabled');
    expect(describeOf(panel)).toContain('replies:archive.periodic_paused');
  });

  it('reports a repeated setting as unchanged', async () => {
    const { access: target } = access(saved);
    const panel = await executeArchiveSchedule(
      command({ enabled: false }),
      archiveBot().bot,
      target,
    );
    expect(describeOf(panel)).toContain('replies:archive.schedule_note_unchanged');
  });

  it('rejects an interval outside 1–10080 minutes', async () => {
    const { access: target, update } = access();
    await expect(
      executeArchiveSchedule(command({ minutes: 10_081 }), archiveBot().bot, target),
    ).rejects.toMatchObject({ messageKey: 'replies:archive.invalid_interval' });
    expect(update).not.toHaveBeenCalled();
  });
});
