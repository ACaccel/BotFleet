import type { BaseBot } from '@bot';
import { bindTranslator } from '../../../core/i18n';
import {
  archivePublicMessageNonce,
  readArchivePublicMessage,
  withArchivePublicMessageLock,
} from '../../../infra/archive/public-message';
import { ArchiveAccessError, type ArchiveAccess } from './access';
import { archivePublicReference } from './public-reference';
import { date, runStates } from './presentation-common';

/** Legacy manifests retain their own public view without inventing a worker job. */
export const ensureArchiveStandaloneReference = async (
  bot: BaseBot,
  access: ArchiveAccess,
  runId: string,
): Promise<{ channelId: string; messageId: string }> => {
  return withArchivePublicMessageLock(access.guildId, `run:${runId}`, async () => {
    const existing = await archivePublicReference(access, { runId });
    if (existing !== undefined) {
      try {
        await readArchivePublicMessage(bot.client, existing.channelId, existing.messageId);
        return existing;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 10008) throw error;
      }
    }
    const report = await access.control.manifest(runId, { limit: 1 });
    const t = bindTranslator(bot.translator);
    const message = await access.channel.send({
      embeds: [
        {
          title: t('replies:archive.plan_title', {
            state: t(
              `replies:archive.run_state_${runStates.has(report.run.status) ? report.run.status : 'unknown'}`,
            ),
          }),
          description: [
            ...(['planning', 'planned', 'partial-plan', 'failed-plan'].includes(report.run.status)
              ? [
                  t('commands:archive_ui.plan_not_applied', {
                    state: t(`replies:archive.run_state_${report.run.status}`),
                  }),
                ]
              : []),
            t('commands:archive_ui.scope', {
              guild: access.guildId,
              cutoff:
                report.run.cutoff > 0
                  ? date(report.run.cutoff)
                  : t('commands:archive_ui.unavailable'),
            }),
            report.summary.status === 'available'
              ? t('commands:archive_ui.existing_scope', {
                  sources:
                    report.summary.targets?.distinctSources ?? t('commands:archive_ui.unavailable'),
                  operations: report.summary.totalOperations,
                })
              : t('replies:archive.plan_summary_unavailable'),
          ].join('\n'),
        },
      ],
      allowedMentions: { parse: [] },
      nonce: archivePublicMessageNonce(access.guildId, `archive-run:${runId}`, existing?.messageId),
      enforceNonce: true,
    });
    const reference = { channelId: access.debugId, messageId: message.id };
    try {
      const saved = await access.connection
        .collection<{ _id: string; guildId: string }>('archive_repair_runs')
        .updateOne({ _id: runId, guildId: access.guildId }, { $set: { publicMessage: reference } });
      if (saved.matchedCount !== 1)
        throw new ArchiveAccessError('replies:archive.navigation_stale');
    } catch (error) {
      await message
        .delete()
        .catch((failure: unknown) =>
          bot.logger?.warn({ err: failure }, 'Archive standalone notice cleanup failed'),
        );
      throw error;
    }
    return reference;
  });
};
