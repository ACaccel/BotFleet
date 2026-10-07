import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Routes, type Client } from 'discord.js';
import type { Connection } from 'mongoose';
import { archiveJobDeletions } from '../../../infra/archive/lifecycle';
import type { GuildRegistry } from '../../../bot/guild-registry';
import type { ArchiveJob, ArchivePeriodicRun } from '../../../core/archive/types';
import type { ArchiveProgressSnapshot } from '../../../core/archive/progress';
import { archiveJobProgress, sanitizeArchiveProgress } from '../../../core/archive/progress';
import { renderArchivePublicStatus } from '../../../core/archive/public-status-renderer';
import type { Logger } from '../../../core/logger';
import type { Translator } from '../../../core/i18n';
import {
  publicArchiveSourceName,
  archivePublicMessageNonce,
  readArchivePublicMessage,
  withArchivePublicMessageLock,
  isArchivePublicStatusEmbed,
} from '../../../infra/archive/public-message';

interface Options {
  client: Client;
  registry: GuildRegistry;
  logger: Logger;
  connection: Connection;
  guildId: string;
  translator: Translator;
}

interface PublicationOptions {
  /** Restore a status card only when a user explicitly returns to its owning panel. */
  restoreStatus?: boolean;
}

/** Job messages outlive interaction tokens and worker processes. */
export class ArchiveJobNotifier {
  public constructor(private readonly options: Options) {}

  public async publish(
    job: ArchiveJob,
    snapshot: ArchiveProgressSnapshot = archiveJobProgress(job),
    strict = false,
    publication: PublicationOptions = {},
  ): Promise<void> {
    const { guildId, connection } = this.options;
    const jobs = connection.collection<ArchiveJob>('archive_jobs');
    await withArchivePublicMessageLock(guildId, 'job:' + job.jobId, async () => {
      const saved = await jobs.findOne({ jobId: job.jobId, guildId });
      if (saved === null || saved.notification?.supersededAt !== undefined) return;
      const deleted = await archiveJobDeletions(connection).findOne({
        _id: 'job:' + job.jobId,
        guildId,
      });
      if (deleted?.deletedAt !== undefined) return;
      const latest = archiveJobProgress(saved);
      await this.deliver(
        saved,
        sanitizeArchiveProgress(saved.result?.['progress']) === undefined &&
          snapshot.state === latest.state
          ? snapshot
          : latest,
        'archive_panel|' + job.jobId,
        async (update) => {
          await jobs.updateOne({ jobId: job.jobId, guildId }, update);
        },
        async () => {
          const current = await jobs.findOne({ jobId: job.jobId, guildId });
          return current !== null && current.notification?.supersededAt === undefined;
        },
        strict,
        publication,
      );
    });
  }

  private async isBulkControlMessage(
    channelId: string,
    messageId: string,
    components: Awaited<ReturnType<typeof readArchivePublicMessage>>['components'],
  ): Promise<boolean> {
    for (const row of components) {
      for (const component of row.components) {
        if (!('custom_id' in component)) continue;
        const match = /^archive_manage\|bulk-(?:confirm|result)\|([a-f0-9-]{36})$/.exec(
          component.custom_id,
        );
        if (match?.[1] === undefined) continue;
        const batch = await this.options.connection
          .collection<{ _id: string }>('archive_bulk_deletions')
          .findOne(
            {
              _id: match[1],
              guildId: this.options.guildId,
              'actor.channelId': channelId,
              'actor.messageId': messageId,
              state: { $in: ['ready', 'running', 'complete'] },
            },
            { projection: { _id: 1 } },
          );
        if (batch !== null) return true;
      }
    }
    return false;
  }

  public async publishDeleted(jobId: string): Promise<void> {
    const { connection, guildId, client, translator, logger } = this.options;
    await withArchivePublicMessageLock(guildId, 'job:' + jobId, async () => {
      const receipts = archiveJobDeletions(connection);
      const receipt = await receipts.findOne({
        _id: 'job:' + jobId,
        guildId,
        deletedAt: { $exists: true },
      });
      if (receipt === null || receipt.notifiedAt !== undefined) return;
      const notification = receipt.notification;
      if (notification?.messageId !== undefined && notification.supersededAt === undefined) {
        try {
          await withArchivePublicMessageLock(
            notification.channelId,
            notification.messageId,
            async () => {
              const replacement = await connection.collection<ArchiveJob>('archive_jobs').findOne(
                {
                  guildId,
                  'notification.channelId': notification.channelId,
                  'notification.messageId': notification.messageId,
                  'notification.supersededAt': { $exists: false },
                },
                { projection: { jobId: 1 } },
              );
              if (replacement !== null) return;
              const message = await readArchivePublicMessage(
                client,
                notification.channelId,
                notification.messageId!,
              );
              if (
                await this.isBulkControlMessage(
                  notification.channelId,
                  notification.messageId!,
                  message.components,
                )
              )
                return;
              if (message.embeds.length > 0 && !isArchivePublicStatusEmbed(message.embeds[0])) {
                await receipts.updateOne(
                  { _id: receipt._id, guildId },
                  { $set: { 'notification.supersededAt': Date.now() } },
                );
                return;
              }
              await client.rest.patch(
                Routes.channelMessage(notification.channelId, notification.messageId!),
                {
                  body: {
                    content: '',
                    embeds: [{ description: translator.t('replies:archive.deleted_public') }],
                    components: [],
                    attachments: [],
                    allowed_mentions: { parse: [] },
                  },
                },
              );
            },
          );
        } catch (error) {
          if ((error as { code?: unknown })?.code !== 10008) {
            logger.warn({ guildId, jobId, err: error }, 'Archive deleted notification deferred');
            return;
          }
        }
      }
      await receipts.updateOne({ _id: receipt._id, guildId }, { $set: { notifiedAt: Date.now() } });
    });
  }

  /** Periodic scan references use the persisted scan identity, including across restarts. */
  public async publishScan(
    runId: string,
    snapshot?: ArchiveProgressSnapshot,
    strict = false,
    publication: PublicationOptions = {},
  ): Promise<void> {
    const { guildId, connection } = this.options;
    const runs = connection.collection<ArchivePeriodicRun>('archive_periodic_runs');
    await withArchivePublicMessageLock(guildId, 'scan:' + runId, async () => {
      const run = await runs.findOne({ _id: 'current', runId });
      if (run === null) return;
      const progress = sanitizeArchiveProgress(
        run.progress ??
          run.result?.['progress'] ??
          (run.result?.['details'] as Record<string, unknown> | undefined)?.['progress'],
      );
      const observed =
        progress ??
        snapshot ??
        sanitizeArchiveProgress({
          work: 'periodic',
          scanId: runId,
          state: run.status,
          cutoff: new Date(run.cutoff).toISOString(),
          startedAt: run.cutoff,
          phase: 'discovery',
        })!;
      const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(run.status);
      const latest = terminal
        ? sanitizeArchiveProgress({
            ...observed,
            state: run.status,
            estimating: false,
            estimate: undefined,
            phaseEstimate: undefined,
            activities: [],
            activityCount: 0,
          })!
        : run.status === 'running' &&
            ['complete', 'partial', 'failed', 'cancelled'].includes(observed.state)
          ? sanitizeArchiveProgress({ ...observed, state: 'running' })!
          : observed;
      await this.deliver(
        run,
        latest,
        'archive_panel|scan|' + runId,
        async (update) => {
          await runs.updateOne({ _id: 'current', runId }, update);
        },
        async () => (await runs.findOne({ _id: 'current', runId })) !== null,
        strict,
        publication,
      );
    });
  }

  private async deliver(
    scope: {
      status: string;
      deleteRequestedAt?: number;
      notification?: ArchiveJob['notification'];
      runId?: string;
      result?: Record<string, unknown>;
    },
    snapshot: ArchiveProgressSnapshot,
    customId: string,
    persist: (update: {
      $set: Record<string, unknown>;
      $unset?: Record<string, ''>;
      $inc?: Record<string, number>;
    }) => Promise<void>,
    current: () => Promise<boolean>,
    strict: boolean,
    publication: PublicationOptions,
  ): Promise<void> {
    const { registry, guildId, client, logger, translator } = this.options;
    try {
      const channel = registry.getChannel(guildId, 'debug');
      if (channel === undefined || !channel.isSendable())
        throw new Error('Archive debug channel unavailable');
      if (
        scope.notification?.channelId !== undefined &&
        scope.notification.channelId !== channel.id
      )
        throw new Error('Archive debug channel changed');
      const navigation = [
        [customId, 'public_details'],
        ...(!customId.startsWith('archive_panel|scan|') &&
        ['queued', 'running'].includes(scope.status) &&
        scope.deleteRequestedAt === undefined
          ? [[customId + '|cancel', 'public_cancel']]
          : []),
      ].filter(([id]) => id !== undefined && id.length <= 100);
      const components = Array.from({ length: Math.ceil(navigation.length / 5) }, (_, index) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          navigation.slice(index * 5, index * 5 + 5).map(([id, label]) =>
            new ButtonBuilder()
              .setCustomId(id!)
              .setLabel(translator.t('replies:archive.' + label))
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      );
      const activity = snapshot.activities[0];
      const currentSource =
        activity === undefined
          ? undefined
          : (publicArchiveSourceName(client, guildId, activity.sourceId) ??
            (/^\d{1,20}$/.test(activity.sourceId)
              ? translator.t('replies:archive.public_source_id', { id: activity.sourceId })
              : translator.t('replies:archive.public_source_hidden')));
      const embed = renderArchivePublicStatus(snapshot, translator, {
        currentSource,
        nowMs: Date.now(),
        lastSuccessfulUpdateAtMs: Date.now(),
      });
      if (scope.deleteRequestedAt !== undefined) {
        embed.description = [
          embed.description,
          translator.t('replies:archive.deletion_pending_public'),
        ]
          .filter(Boolean)
          .join('\n');
      }
      let messageId = scope.notification?.messageId;
      if (messageId !== undefined) {
        try {
          const published = await withArchivePublicMessageLock(channel.id, messageId, async () => {
            if (!(await current())) return false;
            const message = await readArchivePublicMessage(client, channel.id, messageId!);
            if (await this.isBulkControlMessage(channel.id, messageId!, message.components))
              return false;
            const hasStatus = isArchivePublicStatusEmbed(message.embeds[0]);
            if (message.embeds.length > 0 && !hasStatus && !publication.restoreStatus) return false;
            const legacyControls =
              message.embeds.length <= 1 &&
              message.components.some((row) =>
                row.components.some(
                  (component) =>
                    'custom_id' in component &&
                    [
                      customId + '|changes',
                      customId + '|technical',
                      'archive_manage|job|' + customId.slice('archive_panel|'.length),
                    ].includes(component.custom_id),
                ),
              );
            const retainedControls = legacyControls
              ? components.map((row) => row.toJSON())
              : message.components;
            await client.rest.patch(Routes.channelMessage(channel.id, messageId!), {
              body: {
                content: '',
                embeds: [embed, ...message.embeds.slice(hasStatus ? 1 : 0)],
                allowed_mentions: { parse: [] },
                components:
                  scope.deleteRequestedAt !== undefined
                    ? []
                    : retainedControls.length > 0
                      ? retainedControls
                          .map((row) => ({
                            ...row,
                            components: row.components.filter(
                              (component) =>
                                !(
                                  'custom_id' in component &&
                                  typeof component.custom_id === 'string' &&
                                  !['queued', 'running'].includes(scope.status) &&
                                  (component.custom_id === customId + '|cancel' ||
                                    component.custom_id ===
                                      'archive_manage|stop|' +
                                        customId.slice('archive_panel|'.length))
                                ),
                            ),
                          }))
                          .filter((row) => row.components.length > 0)
                      : components.map((row) => row.toJSON()),
              },
            });
            return true;
          });
          if (!published) return;
        } catch (error) {
          // Only Discord's missing-message response proves that creating a replacement is safe.
          if ((error as { code?: unknown })?.code !== 10008) throw error;
          messageId = undefined;
        }
      }
      if (messageId === undefined) {
        if (scope.deleteRequestedAt !== undefined) return;
        if (!(await current())) return;
        messageId = (
          await channel.send({
            content: '',
            embeds: [embed],
            allowedMentions: { parse: [] },
            components: scope.deleteRequestedAt !== undefined ? [] : components,
            nonce: archivePublicMessageNonce(guildId, customId, scope.notification?.messageId),
            enforceNonce: true,
          })
        ).id;
        // Retain the returned identity even if persisting delivery metadata fails.
        scope.notification = { ...scope.notification, channelId: channel.id, messageId };
      }
      await persist({
        $set: {
          'notification.channelId': channel.id,
          'notification.messageId': messageId,
          'notification.deliveredStatus': scope.status,
          'notification.deliveredAt': Date.now(),
          'notification.attempts': 0,
        },
        $unset: { 'notification.nextAttemptAt': '' },
      });
    } catch (error) {
      logger.warn({ guildId, scope: customId, err: error }, 'Archive notification deferred');
      await persist({
        $set: {
          'notification.nextAttemptAt':
            Date.now() +
            Math.min(30_000, 5000 * 2 ** Math.min(scope.notification?.attempts ?? 0, 3)),
          ...(scope.notification?.messageId === undefined
            ? {}
            : {
                'notification.channelId': scope.notification.channelId,
                'notification.messageId': scope.notification.messageId,
              }),
        },
        $inc: { 'notification.attempts': 1 },
      }).catch((failure: unknown) => {
        logger.warn(
          { guildId, scope: customId, err: failure },
          'Archive notification retry could not be saved',
        );
      });
      if (strict) throw error;
    }
  }
}
