import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIEmbed,
  type Channel,
  type Client,
} from 'discord.js';
import { createDefaultTranslator } from '../../../src/core/i18n';
import { createLogger } from '../../../src/core/logger';
import type { ArchiveJob } from '../../../src/core/archive/types';
import { sanitizeArchiveProgress } from '../../../src/core/archive/progress';
import { renderArchivePublicStatus } from '../../../src/core/archive/public-status-renderer';
import {
  patchArchivePublicDetails,
  archiveDetailFingerprint,
} from '../../../src/infra/archive/public-message';
import { ArchiveJobNotifier } from '../../../src/plugins/message-backup/runtime/job-notification';
import { withFreshConnection } from '../helpers/mongo';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const messageId = '323456789012345678';
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const discord = () => {
  let message: { embeds: APIEmbed[]; components: unknown[]; content?: string } = {
    embeds: [],
    components: [],
  };
  let release: (() => void) | undefined;
  let block = false;
  const send = vi.fn(async (payload: typeof message) => {
    message = json(payload);
    return { id: messageId };
  });
  const get = vi.fn(async () => json(message));
  const patch = vi.fn(async (_route: string, options: { body: Partial<typeof message> }) => {
    if (block) {
      block = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    message = { ...message, ...json(options.body) };
    return json(message);
  });
  const channel = { id: channelId, isSendable: () => true, send } as unknown as Channel;
  return {
    client: { rest: { get, patch } } as unknown as Client,
    registry: {
      getChannel: () => channel,
      getRepos: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => [guildId],
    },
    send,
    patch,
    current: () => message,
    blockNextEdit: () => {
      block = true;
    },
    releaseEdit: () => release?.(),
  };
};

describe('shared archive status card integration', () => {
  it('removes only a durably marked queued receipt when the job starts, including after restart', async () =>
    withFreshConnection(async (connection) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
        fallbackLocale: 'en',
      });
      const transport = discord();
      const options = {
        ...transport,
        connection,
        guildId,
        translator,
        logger: createLogger({ level: 'silent', pretty: false }),
      };
      const job: ArchiveJob = {
        jobId: `${guildId}:queued-receipt`,
        requestId: 'queued-receipt',
        guildId,
        command: 'apply',
        options: {},
        status: 'queued',
        cancelRequested: false,
        createdAt: Date.now(),
      };
      const jobs = connection.collection<ArchiveJob>('archive_jobs');
      await jobs.insertOne({ ...job });
      const notifier = new ArchiveJobNotifier(options);
      await notifier.publish(job, undefined, true);
      const receipt = { description: 'Synthetic queued submission receipt' };
      const inspection = { description: 'Synthetic inspection or approval detail' };
      await jobs.updateOne(
        { jobId: job.jobId },
        { $set: { 'notification.transientDetailHash': archiveDetailFingerprint(receipt) } },
      );
      await patchArchivePublicDetails(transport.client, channelId, messageId, {
        embeds: [receipt, inspection],
      });
      await notifier.publish(job, undefined, true);
      expect(transport.current().embeds.slice(1)).toEqual([receipt, inspection]);
      await jobs.updateOne(
        { jobId: job.jobId },
        { $set: { status: 'running', startedAt: Date.now() } },
      );
      await new ArchiveJobNotifier(options).publish(job, undefined, true);
      expect(transport.current().embeds.slice(1)).toEqual([inspection]);
      expect(transport.current().embeds[0]?.title).toContain('Running');
      const unmarked = { description: 'Unmarked queued text is never guessed at' };
      await patchArchivePublicDetails(transport.client, channelId, messageId, {
        embeds: [unmarked, inspection],
      });
      await notifier.publish(job, undefined, true);
      expect(transport.current().embeds.slice(1)).toEqual([unmarked, inspection]);
    }));
  it.each(['en', 'zh-TW'] as const)(
    'preserves public details across concurrent heartbeats, restart and job handoff in %s',
    async (locale) =>
      withFreshConnection(async (connection) => {
        const translator = await createDefaultTranslator({
          localesDir: path.resolve(__dirname, '../../../src/i18n/locales'),
          fallbackLocale: locale,
        });
        const transport = discord();
        const options = {
          ...transport,
          connection,
          guildId,
          translator,
          logger: createLogger({ level: 'silent', pretty: false }),
        };
        const job: ArchiveJob = {
          jobId: `${guildId}:original`,
          requestId: 'original',
          guildId,
          command: 'apply',
          runId: '12345678-1234-4234-8234-123456789abc',
          options: {},
          status: 'running',
          cancelRequested: false,
          createdAt: 1_700_000_000_000,
        };
        const jobs = connection.collection<ArchiveJob>('archive_jobs');
        await jobs.insertOne({ ...job });
        const progress = sanitizeArchiveProgress({
          work: 'apply',
          phase: 'history',
          state: 'running',
        })!;
        await jobs.updateOne({ jobId: job.jobId }, { $set: { 'result.progress': progress } });
        const notifier = new ArchiveJobNotifier(options);
        await notifier.publish(job, progress, true);
        expect(transport.send).toHaveBeenCalledOnce();
        expect(JSON.stringify(transport.current().components)).toContain(
          translator.t('replies:archive.public_cancel'),
        );
        expect(JSON.stringify(transport.current())).not.toMatch(/replies:|commands:|\{\{/);
        expect((await jobs.findOne({ jobId: job.jobId }))?.notification?.messageId).toBe(messageId);

        const confirmation = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('archive_confirm|synthetic-actor-bound-token')
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Primary),
        );
        transport.blockNextEdit();
        const details = patchArchivePublicDetails(transport.client, channelId, messageId, {
          content: 'Synthetic change details: page 2',
          components: [confirmation],
        });
        await vi.waitFor(() => expect(transport.patch).toHaveBeenCalledOnce());
        progress.messages.scanned = 12;
        await jobs.updateOne({ jobId: job.jobId }, { $set: { 'result.progress': progress } });
        const latest = renderArchivePublicStatus(progress, translator);
        const heartbeat = notifier.publish(job, progress, true);
        transport.releaseEdit();
        await Promise.all([details, heartbeat]);
        expect(transport.current().embeds).toHaveLength(2);
        expect(transport.current().embeds[0]).toMatchObject({
          title: latest.title,
          fields: latest.fields,
        });
        expect(transport.current().embeds[1]).toEqual({
          description: 'Synthetic change details: page 2',
        });
        expect(transport.current().components).toEqual([confirmation.toJSON()]);
        expect(transport.current().content).toBe('');

        const restarted = new ArchiveJobNotifier(options);
        await restarted.publish(job, progress, true);
        expect(transport.current().embeds[1]?.description).toContain('page 2');
        expect(transport.current().components).toEqual([confirmation.toJSON()]);
        expect(transport.send).toHaveBeenCalledOnce();

        const saved = (await jobs.findOne({ jobId: job.jobId }))!;
        const successor: ArchiveJob = {
          ...job,
          jobId: `${guildId}:resume`,
          requestId: 'resume',
          command: 'resume',
          notification: saved.notification,
        };
        await jobs.insertOne(successor);
        await jobs.updateOne(
          { jobId: job.jobId },
          { $set: { 'notification.supersededAt': Date.now() } },
        );
        const edits = transport.patch.mock.calls.length;
        const stale = { ...progress, phase: 'repair' as const };
        await notifier.publish(job, stale, true);
        expect(transport.patch).toHaveBeenCalledTimes(edits);
        await restarted.publish(successor, progress, true);
        expect(transport.send).toHaveBeenCalledOnce();
        expect(transport.current().embeds[0]?.description).toContain(
          translator.t('replies:archive.view_phase_history'),
        );
        expect(JSON.stringify(transport.current())).not.toMatch(/replies:|commands:|\{\{/);
      }),
  );
});
