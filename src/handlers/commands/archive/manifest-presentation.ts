import type { ButtonBuilder, InteractionReplyOptions } from 'discord.js';
import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import type { ArchiveControlService } from '../../../infra/archive/control';
import { browseViews, date, rows } from './presentation-common';
import { manageBack, manageButton } from './manage-common';
import { shortArchiveReference } from './manage-references';
import type { ArchiveBrowsePage } from './navigation';
import { summaryLines } from './plan-summary';
import { archiveConfirmationReply, archivePlanActions } from './confirmation-presentation';
import { manifestDetailsReply } from './manifest-details';
import { archiveGuildLabel } from './source-presentation';

/** Inspect is recoverable from durable run identity, independent of the original interaction. */
export const archiveManifestReply = async (
  runId: string,
  bot: BaseBot,
  control: ArchiveControlService,
  actor: { userId: string; channelId: string; messageId?: string },
  options: ArchiveBrowsePage,
  extraButtons: readonly ButtonBuilder[] = [],
): Promise<InteractionReplyOptions> => {
  const t = bindTranslator(bot.translator);
  if (options.view === 'summary') {
    const report = await control.manifest(runId, { limit: 1 });
    const action = (['apply', 'resume', 'accept'] as const).find((value) =>
      report.run.actions.includes(value),
    );
    if (action !== undefined)
      return archiveConfirmationReply(
        await control.requestConfirmation(action, runId, actor),
        bot,
        actor,
        extraButtons,
      );
    const next =
      report.run.status === 'accepted'
        ? t('replies:archive.plan_next_accepted', {
            expiry:
              report.run.expiresAt === undefined
                ? t('replies:archive.plan_recovery_unknown')
                : date(report.run.expiresAt),
          })
        : report.run.status === 'recovery-expired'
          ? t('replies:archive.plan_next_expired')
          : report.run.status === 'rolled-back'
            ? t('replies:archive.plan_next_rolled_back')
            : report.run.status === 'complete'
              ? t('replies:archive.plan_next_complete_blocked')
              : [
                    'planning',
                    'applying',
                    'enriching',
                    'verifying',
                    'rolling-back',
                    'rollback-conflicts',
                    'partial',
                  ].includes(report.run.status)
                ? t('replies:archive.plan_next_wait')
                : t('replies:archive.plan_next_replan');
    const activeJob = report.run.activeJob;
    const controls = [
      manageButton('plan', runId, t('replies:archive.plan_refresh')),
      ...(activeJob === undefined || activeJob.cancelRequested
        ? []
        : [
            manageButton(
              'ref',
              shortArchiveReference(
                'pause-plan',
                JSON.stringify({ runId, jobId: activeJob.jobId }),
              ),
              t('replies:archive.plan_pause'),
            ),
          ]),
      ...browseViews(runId, { ...actor, guildId: report.run.guildId }, t, 'summary').flatMap(
        (row) => row.components,
      ),
      ...extraButtons,
      ...archivePlanActions(report.run, t, undefined, false),
    ].slice(0, 5);
    if (controls.length < 5) controls.push(manageBack('plans', t));
    return {
      content: [
        ...summaryLines(
          report.run,
          report.summary,
          t,
          archiveGuildLabel(
            bot.client?.guilds?.cache.get(report.run.guildId),
            report.run.guildId,
            40,
          ),
        ),
        activeJob?.cancelRequested ? t('replies:archive.plan_pausing') : next,
      ].join('\n'),
      components: rows(controls),
    };
  }
  return manifestDetailsReply(runId, bot, control, actor, options);
};
