import type { ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { renderArchiveSchedule } from '../../../application/archive/panel-status';
import type { ArchivePanel } from '../../../application/archive/panel';
import { ArchiveInputError } from '../../../core/errors';
import type { ArchiveAccess } from '../archive-shared/access';
import { archiveText } from '../archive-shared/views';

/**
 * `/archive schedule [enabled] [minutes]`: without options it shows the periodic
 * schedule; with options it changes only what was given. Unchanged settings keep
 * the next run time.
 */
export const executeArchiveSchedule = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<ArchivePanel> => {
  const enabled = interaction.options.getBoolean('enabled');
  const minutes = interaction.options.getInteger('minutes');
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080))
    throw new ArchiveInputError('replies:archive.invalid_interval');
  const before = await access.control.readSchedule();
  const requested = enabled !== null || minutes !== null;
  const after = requested
    ? await access.control.updateSchedule({
        ...(enabled === null ? {} : { enabled }),
        ...(minutes === null ? {} : { intervalMs: minutes * 60_000 }),
      })
    : before;
  const latest = await access.control.latestFullBackup();
  return renderArchiveSchedule(archiveText(bot), after, {
    requested,
    changed: {
      enabled: before.enabled !== after.enabled,
      interval: before.intervalMs !== after.intervalMs,
    },
    backupActive: latest?.status === 'queued' || latest?.status === 'running',
  });
};
