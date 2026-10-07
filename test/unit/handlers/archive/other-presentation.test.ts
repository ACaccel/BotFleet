import { resolveArchiveReference } from '../../../../src/handlers/commands/archive/manage-references';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { bindTranslator, createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { archiveSourceLabel } from '../../../../src/handlers/commands/archive/source-presentation';
import {
  archiveQueuedReply,
  archiveJobReply,
} from '../../../../src/handlers/commands/archive/job-presentation';
import { archiveJobsReply } from '../../../../src/handlers/commands/archive/jobs-presentation';
import { renderArchiveStatus } from '../../../../src/handlers/commands/archive/progress';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';

const fixture = async (locale: 'en' | 'zh-TW') => {
  const translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: locale,
  });
  const forum = Object.assign(buildTextChannel({ id: '10', name: 'forum' }), {
    type: ChannelType.GuildForum,
  });
  const source = Object.assign(buildTextChannel({ id: '11', name: 'current' }), {
    type: ChannelType.PublicThread,
    parentId: '10',
  });
  const guild = buildGuild({ id: '1', name: 'server', channels: [forum, source] });
  const { bot } = buildFakeBot({
    translator,
    client: { guilds: { cache: new Map([['1', guild]]) } },
  });
  Object.assign(guild, { client: bot.client });
  for (const channel of guild.channels.cache.values())
    Object.assign(channel, { permissionOverwrites: { cache: new Map() } });
  const progress = sanitizeArchiveProgress({
    work: 'refresh-attachment',
    phase: 'repair',
    state: 'queued',
    cutoff: new Date(1000).toISOString(),
  })!;
  const job: Awaited<ReturnType<ArchiveControlService['status']>> = {
    jobId: '1:request',
    requestId: 'request',
    guildId: '1',
    command: 'refresh-attachment',
    status: 'queued',
    createdAt: 1000,
    cancelRequested: false,
    counts: {},
    issueCount: 0,
    issueCategories: [],
    progress,
    attachment: { channelId: '11', messageId: '22', attachmentId: '33' },
  };
  return { bot, translator, guild, job };
};

describe('archive source and other page information', () => {
  it.each(['en', 'zh-TW'] as const)(
    'uses cache identity, type and parent with truthful %s fallback',
    async (locale) => {
      const { guild, translator } = await fixture(locale);
      const t = bindTranslator(translator);
      const current = archiveSourceLabel({ channelId: '11', historicalName: 'old' }, guild, t);
      expect(current).toContain('forum');
      expect(current).toContain('current');
      expect(current).toContain(t('replies:archive.source_type_forum-post'));
      expect(current).toContain('11');
      expect(current).not.toContain(t('replies:archive.source_historical'));
      const historical = archiveSourceLabel({ channelId: '99', historicalName: 'old' }, guild, t);
      expect(historical).not.toContain('old');
      expect(historical).toContain(t('replies:archive.source_unidentified'));
      expect(historical).toContain('99');
      const unknown = archiveSourceLabel({ channelId: '98' }, guild, t);
      expect(unknown).toContain(t('replies:archive.source_unidentified'));
      expect(unknown).toContain('98');
      expect(unknown).not.toMatch(/deleted|已刪除/);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'makes clear the queued %s plan has not started history backup',
    async (locale) => {
      const { bot, job, translator } = await fixture(locale);
      const queued = archiveQueuedReply({ ...job, command: 'plan', attachment: undefined }, bot);
      expect(queued.content).toContain(translator.t('replies:archive.plan_preparing'));
      expect(queued.content).not.toContain(job.jobId);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'shows queued and attachment %s scope without signed URLs',
    async (locale) => {
      const { bot, job, translator } = await fixture(locale);
      const queued = String(archiveQueuedReply(job, bot).content);
      expect(queued).toContain('server');
      expect(queued).toContain('current');
      for (const id of ['22', '33']) expect(queued).toContain(id);
      expect(queued).not.toContain(job.jobId);
      expect(queued).toContain(translator.t('replies:archive.state_queued'));
      const progress = {
        ...job.progress,
        state: 'failed' as const,
        gapCount: 1,
        gapCountKnown: true,
        gaps: [{ sourceId: '11', reason: 'permission' as const }],
      };
      const reply = await archiveJobReply(
        { ...job, status: 'failed', progress },
        bot,
        {} as ArchiveControlService,
        null,
      );
      expect(String(reply.content)).toContain(
        translator.t('replies:archive.view_attachment_incomplete'),
      );
      expect(String(reply.content)).toContain('https://discord.com/channels/1/11/22');
      expect(String(reply.content)).not.toMatch(/cdn\.discord|token=|signature=/);
    },
  );

  it.each(['en', 'zh-TW'] as const)(
    'keeps long %s identities behind two item buttons without skipping hidden entries',
    async (locale) => {
      const { bot, job } = await fixture(locale);
      const jobs = Array.from({ length: 10 }, (_, index) => ({
        ...job,
        jobId: `${index}-${'j'.repeat(140)}`,
        runId: `flow-${'r'.repeat(140)}`,
      }));
      const reply = archiveJobsReply({ jobs, nextCursor: jobs.at(-1)!.jobId }, bot, true);
      const buttons = JSON.parse(JSON.stringify(reply.components))[0].components;
      expect(buttons).toHaveLength(5);
      expect(
        buttons.every(
          (button: { type: number; custom_id: string }) =>
            button.type === 2 && button.custom_id.length <= 100,
        ),
      ).toBe(true);
      for (let index = 0; index < 2; index++) {
        expect(resolveArchiveReference(buttons[index].custom_id.split('|')[2])).toMatchObject({
          action: 'job',
          id: jobs[index]!.jobId,
        });
      }
      expect(resolveArchiveReference(buttons.at(-1).custom_id.split('|')[2])).toMatchObject({
        action: 'jobs',
        id: jobs[1]!.jobId,
      });
      expect(buttons[3]).toMatchObject({
        type: 2,
        style: 4,
        custom_id: 'archive_manage|delete-all-jobs|guild',
      });
      expect(String(reply.content).length).toBeLessThanOrEqual(1900);
      expect(JSON.stringify(reply.components)).not.toContain('archive_panel|');
    },
  );

  it('resolves private progress source identity and reuses loaded detail pages', async () => {
    const { bot, job, translator } = await fixture('en');
    const progressDetails = vi.fn();
    const details = {
      activities: [],
      gaps: [{ sourceId: '11', name: 'old', reason: 'permission' as const }],
      page: 2,
      hasNext: false,
    };
    const content = await renderArchiveStatus(
      { ...job.progress, state: 'partial', gapCount: 1 },
      bot,
      { progressDetails } as unknown as ArchiveControlService,
      job.jobId,
      2,
      [],
      { guildId: '1', loadedDetails: details },
    );
    expect(content).toContain('current');
    expect(content).toContain('forum post');
    expect(content).toContain(translator.t('replies:archive.view_detail_gap_permission'));
    expect(progressDetails).not.toHaveBeenCalled();
  });

  it.each([
    ['complete', 'accept'],
    ['partial', 'resume'],
    ['partial', undefined],
    ['failed', undefined],
  ] as const)(
    'offers only the backend-eligible action for a %s result (%s) without executing it',
    async (status, action) => {
      const { bot, job, translator } = await fixture('en');
      const actor = { userId: '2', channelId: '3' };
      const report: Awaited<ReturnType<ArchiveControlService['manifest']>> = {
        run: {
          runId: 'run',
          guildId: job.guildId,
          status,
          createdAt: 1000,
          cutoff: 1000,
          operations: 1,
          unresolved: 0,
          issueCount: 0,
          issueCategories: [],
          journalBytes: 100,
          deletable: false,
          actions: action === undefined ? [] : [action],
        },
        summary: {
          status: 'available',
          totalOperations: 1,
          categories: [],
          impacts: {
            insertOperations: 0,
            updateOperations: 1,
            deleteOperations: 0,
            unknownImpactOperations: 0,
          },
          recordTypes: [
            {
              collection: 'fetches',
              operations: 1,
              insertOperations: 0,
              updateOperations: 1,
              deleteOperations: 0,
              unknownImpactOperations: 0,
            },
          ],
        },
        operations: [],
        nextSequence: -1,
        hasNext: false,
        hasPrevious: false,
      };
      const manifest = vi.fn().mockResolvedValue(report);
      const requestConfirmation = vi.fn().mockResolvedValue({
        token: 'abcdefghijklmnopqrstuvwx',
        action,
        run: report.run,
        summary: report.summary,
        expiresAt: 1700000500000,
      });
      const confirm = vi.fn();
      const submit = vi.fn();
      const reply = await archiveJobReply(
        {
          ...job,
          command: 'apply',
          status,
          runId: 'run',
          progress: { ...job.progress, work: 'apply', state: status },
        },
        bot,
        { manifest, requestConfirmation, confirm, submit } as unknown as ArchiveControlService,
        null,
        actor,
      );
      const components = JSON.stringify(reply.components);
      expect(manifest).toHaveBeenCalledExactlyOnceWith('run', { limit: 1 });
      expect(components).toContain('archive_browse|');
      expect(String(reply.content)).not.toContain(job.jobId);
      expect(String(reply.content)).not.toMatch(/Workflow ID|Journal|beforeHash/);
      if (action === undefined) {
        expect(components).not.toContain('archive_confirm|');
        expect(requestConfirmation).not.toHaveBeenCalled();
      } else {
        expect(components).toContain('archive_confirm|abcdefghijklmnopqrstuvwx');
        expect(components).toContain(translator.t(`replies:archive.confirm_action_${action}`));
        expect(String(reply.content)).toContain('<@2>');
        expect(String(reply.content)).toContain('<t:1700000500:R>');
        expect(requestConfirmation).toHaveBeenCalledExactlyOnceWith(action, 'run', actor);
      }
      if (status !== 'complete')
        expect(components).not.toContain(translator.t('replies:archive.confirm_action_accept'));
      expect(confirm).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    },
  );
});
