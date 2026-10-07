import {
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import { ArchiveScheduleStore } from '../../../infra/archive/schedule';
import { ArchiveAccessError, type ArchiveAccess } from './access';
import { sanitizeArchiveProgress } from '../../../core/archive/progress';
import { archiveStatusPage, renderArchiveStatus } from './progress';
import { archiveGuildLabel } from './source-presentation';
import { archivePublicReply } from './public-reply';

export const executeArchiveSchedule = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  access: ArchiveAccess,
): Promise<InteractionReplyOptions> => {
  const t = bindTranslator(bot.translator);
  const action = interaction.options.getSubcommand();
  if (!['status', 'enable', 'disable', 'interval'].includes(action))
    throw new ArchiveAccessError('replies:archive.invalid_action');
  const page = action === 'status' ? archiveStatusPage(interaction) : null;
  const minutes =
    action === 'interval' || action === 'enable'
      ? interaction.options.getInteger('minutes', action === 'interval')
      : null;
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080))
    throw new ArchiveAccessError('replies:archive.invalid_interval');
  const store = new ArchiveScheduleStore(
    access.connection,
    (access.config.backup_interval_minutes ?? 60) * 60_000,
  );
  const schedule = await (action === 'status'
    ? store.read()
    : store.update({
        ...(action === 'interval' ? {} : { enabled: action === 'enable' }),
        ...(minutes === null ? {} : { intervalMs: minutes * 60_000 }),
      }));
  const nextRun = !schedule.enabled
    ? t('replies:archive.no_next_run')
    : schedule.running
      ? t('replies:archive.next_after_pass')
      : schedule.nextRunAt === null
        ? t('replies:archive.no_next_run')
        : `<t:${Math.floor(schedule.nextRunAt / 1000)}:R>`;
  const scheduleStatus = t('replies:archive.status', {
    status: t(schedule.enabled ? 'replies:archive.enabled' : 'replies:archive.disabled'),
    minutes: schedule.intervalMs / 60_000,
    running: t(schedule.running ? 'replies:archive.running' : 'replies:archive.idle'),
    nextRun,
  });
  const scope = t('replies:archive.schedule_scope', {
    server: escapeMarkdown(archiveGuildLabel(interaction.guild, interaction.guildId ?? '')),
  });
  const content = `${scope}\n${scheduleStatus}`;
  if (action === 'status') {
    const periodic = await access.control.periodicStatus();
    const progress = sanitizeArchiveProgress(
      periodic?.['progress'] ??
        (periodic === null
          ? undefined
          : {
              work: 'periodic',
              phase: 'history',
              state: periodic['status'],
              scanId: periodic['runId'],
              ...(typeof periodic['cutoff'] === 'number' && periodic['cutoff'] > 0
                ? { cutoff: new Date(periodic['cutoff']).toISOString() }
                : {}),
              messageCountQuality: 'lower-bound',
            }),
    );
    if (progress !== undefined && typeof periodic?.['runId'] === 'string')
      return archivePublicReply(
        {
          content: await renderArchiveStatus(
            progress,
            bot,
            access.control,
            periodic['runId'],
            page,
            [scheduleStatus],
            {
              guild: interaction.guild,
              guildId: interaction.guildId ?? '',
              contextLines: [t('replies:archive.schedule_sources_compact')],
            },
          ),
        },
        { scanId: periodic['runId'] },
      );
    return { content: `${content}\n${t('replies:archive.schedule_last_unknown')}` };
  }
  return {
    content: [
      t('replies:archive.updated'),
      content,
      t(
        action === 'enable'
          ? 'replies:archive.schedule_enable_effect'
          : action === 'disable'
            ? 'replies:archive.schedule_disable_effect'
            : schedule.enabled
              ? 'replies:archive.schedule_interval_effect'
              : 'replies:archive.schedule_interval_disabled',
      ),
      t('replies:archive.schedule_check_status'),
    ].join('\n'),
  };
};
