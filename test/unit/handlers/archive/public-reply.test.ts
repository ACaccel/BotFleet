import { archiveBulkPublicReply } from '../../../../src/handlers/commands/archive/bulk-public-reply';
import { archiveQueuedReply } from '../../../../src/handlers/commands/archive/job-presentation';
import { archiveDetailFingerprint } from '../../../../src/infra/archive/public-message';
import { archivePlanProgressEmbed } from '../../../../src/handlers/commands/archive/plan-progress';
import { publishArchiveReply } from '../../../../src/handlers/commands/archive/replies';
import path from 'node:path';
import type { ArchiveJob } from '../../../../src/core/archive/types';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { ArchiveAccess } from '../../../../src/handlers/commands/archive/access';
import type { Manifest } from '../../../../src/handlers/commands/archive/presentation-common';
import {
  archivePublicReply,
  archivePublicReference,
  ensureArchivePublicReference,
} from '../../../../src/handlers/commands/archive/public-reply';
import { archiveConfirmationReference } from '../../../../src/handlers/commands/archive/public-reference';
import {
  archiveNavigationId,
  resolveArchiveNavigation,
} from '../../../../src/handlers/commands/archive/navigation';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type APIEmbed } from 'discord.js';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const runId = 'legacy-run';
let translator: Translator;
beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: 'en',
  });
});
const fixture = () => {
  const state: { publicMessage?: { channelId: string; messageId: string } } = {};
  const report: Manifest = {
    run: {
      deletable: false,
      runId,
      guildId,
      status: 'planned',
      createdAt: 100,
      cutoff: 100,
      operations: 0,
      unresolved: 0,
      journalBytes: 0,
      issueCount: 0,
      issueCategories: [],
      actions: [],
    },
    summary: {
      status: 'available',
      totalOperations: 0,
      categories: [],
      impacts: {
        insertOperations: 0,
        updateOperations: 0,
        deleteOperations: 0,
        unknownImpactOperations: 0,
      },
    },
    operations: [],
    nextSequence: -1,
    hasNext: false,
    hasPrevious: false,
  };
  const manifest = vi.fn().mockResolvedValue(report);
  const message = { id: '323456789012345678', delete: vi.fn().mockResolvedValue(undefined) };
  const send = vi.fn().mockResolvedValue(message);
  const updateOne = vi.fn().mockImplementation(async (_filter, update) => {
    state.publicMessage = update.$set.publicMessage;
    return { matchedCount: 1 };
  });
  const findRun = vi
    .fn()
    .mockImplementation(async (filter) =>
      filter.guildId === guildId ? { _id: runId, guildId, ...state } : null,
    );
  const collection = vi.fn((name: string) =>
    name === 'archive_jobs'
      ? { findOne: vi.fn().mockResolvedValue(null) }
      : { findOne: findRun, updateOne },
  );
  const rest = {
    patch: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ embeds: [{ description: 'saved plan' }], components: [] }),
  };
  const { bot } = buildFakeBot({ translator, client: { rest } });
  const access = {
    guildId,
    debugId: channelId,
    connection: { collection },
    control: { manifest },
    channel: { send },
  } as unknown as ArchiveAccess;
  return {
    state,
    report,
    manifest,
    message,
    send,
    updateOne,
    findRun,
    rest,
    bot,
    access,
    collection,
  };
};

describe('standalone public archive run notices', () => {
  it('durably marks only the queued submission detail before publishing it', async () => {
    const f = fixture();
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const original = f.collection.getMockImplementation()!;
    f.collection.mockImplementation(
      (name: string) =>
        (name === 'archive_jobs'
          ? { findOne: vi.fn().mockResolvedValue(null), updateOne }
          : original(name)) as never,
    );
    const payload = archiveQueuedReply(
      {
        jobId: 'queued-job',
        guildId,
        status: 'queued',
        command: 'backfill',
        cancelRequested: false,
      } as never,
      f.bot,
    );
    await publishArchiveReply(
      { user: { id: 'owner' }, message: { id: 'queued-panel' }, channelId } as never,
      archivePublicReply(payload, { jobId: 'queued-job' }),
      f.bot,
      f.access,
    );
    expect(updateOne).toHaveBeenCalledWith(
      { guildId, jobId: 'queued-job' },
      {
        $set: {
          'notification.transientDetailHash': archiveDetailFingerprint({
            description: String(payload.content),
          }),
        },
      },
    );
    updateOne.mockClear();
    await publishArchiveReply(
      { user: { id: 'owner' }, message: { id: 'queued-panel' }, channelId } as never,
      archivePublicReply({ content: 'Inspection details' }, { jobId: 'queued-job' }),
      f.bot,
      f.access,
    );
    expect(updateOne).not.toHaveBeenCalled();
  });
  it('adds fresh associated progress above a selected plan without exposing retained source names', async () => {
    const f = fixture();
    const job: ArchiveJob = {
      jobId: 'associated-job',
      requestId: 'request',
      guildId,
      runId,
      command: 'apply',
      status: 'running',
      cancelRequested: false,
      options: {},
      createdAt: Date.now() - 60000,
      notification: { channelId, messageId: f.message.id, deliveredAt: Date.now() - 10000 },
      result: {
        progress: sanitizeArchiveProgress({
          work: 'apply',
          state: 'running',
          phase: 'history',
          startedAt: Date.now() - 60000,
          activities: [
            {
              sourceId: '987654321',
              name: 'Private retained source',
              step: 'processing',
              pageProcessed: 42,
              pageTotal: 100,
            },
          ],
          activityCount: 1,
          messages: { fetched: 1234, scanned: 1234, inserted: 10, updated: 20, durable: 30 },
          sources: { total: 100, completed: 2, quality: 'exact' },
        })!,
      },
    };
    const findJob = vi
      .fn()
      .mockImplementation(async (filter) =>
        filter.guildId === guildId && filter.runId === runId ? job : null,
      );
    const original = f.collection.getMockImplementation()!;
    f.collection.mockImplementation(
      (name: string) => (name === 'archive_jobs' ? { findOne: findJob } : original(name)) as never,
    );
    const publish = () =>
      publishArchiveReply(
        { user: { id: 'owner' }, message: { id: 'list-panel' }, channelId } as never,
        archivePublicReply({ content: 'Selected plan summary', components: [] }, { runId }),
        f.bot,
        f.access,
      );
    await publish();
    const first = f.rest.patch.mock.calls.at(-1)![1].body;
    expect(first.embeds).toHaveLength(2);
    expect(first.embeds[0].title).toContain('Running');
    expect(first.embeds[0].description).toContain('42 / 100');
    expect(JSON.stringify(first.embeds[0])).toContain('1,234');
    expect(JSON.stringify(first.embeds[0])).not.toContain('Private retained source');
    expect(first.embeds[0].description).toContain('987654321');
    expect(first.embeds[0].footer.text).toBeTruthy();
    expect(first.embeds[1]).toEqual({ description: 'Selected plan summary' });
    expect(findJob).toHaveBeenCalledWith(
      { guildId, runId, 'notification.supersededAt': { $exists: false } },
      { sort: { createdAt: -1 } },
    );
    job.result = {
      progress: sanitizeArchiveProgress({
        ...(job.result?.['progress'] as object),
        activities: [
          { sourceId: '987654321', step: 'processing', pageProcessed: 99, pageTotal: 100 },
        ],
      })!,
    };
    await publish();
    expect(f.rest.patch.mock.calls.at(-1)![1].body.embeds[0].description).toContain('99 / 100');
    expect(f.rest.patch.mock.calls.every(([route]) => route.endsWith('/list-panel'))).toBe(true);
  });
  it.each(['planning', 'foreign-guild', 'superseded', 'different-run'] as const)(
    'resolves the originating planning job safely (%s)',
    async (scenario) => {
      const f = fixture();
      const job: ArchiveJob = {
        jobId: 'originating-job',
        requestId: 'request',
        guildId,
        command: 'backfill',
        status: 'running',
        cancelRequested: false,
        options: {},
        createdAt: Date.now() - 60000,
        result: {
          progress: sanitizeArchiveProgress({
            work: 'backfill',
            state: 'running',
            phase: 'repair',
            elapsedMs: 60000,
          })!,
        },
      };
      if (scenario === 'foreign-guild') job.guildId = 'other-guild';
      if (scenario === 'superseded') job.notification = { channelId, supersededAt: Date.now() };
      if (scenario === 'different-run') job.runId = 'other-run';
      const findJob = vi.fn().mockImplementation(async (filter) => {
        if (filter.jobId !== job.jobId) return null;
        expect(filter).toEqual({
          guildId,
          jobId: job.jobId,
          'notification.supersededAt': { $exists: false },
          $or: [{ runId: { $exists: false } }, { runId }],
        });
        return scenario === 'planning' ? job : null;
      });
      const findRun = vi.fn().mockResolvedValue({ _id: runId, originatingJobId: job.jobId });
      f.collection.mockImplementation(
        (name: string) => ({ findOne: name === 'archive_jobs' ? findJob : findRun }) as never,
      );
      const embed = await archivePlanProgressEmbed(f.bot, f.access, runId);
      expect(findRun).toHaveBeenCalledWith(
        { _id: runId, guildId },
        { projection: { originatingJobId: 1 } },
      );
      if (scenario === 'planning') {
        expect(embed?.title).toContain('Running');
        expect(embed?.footer?.text).toContain('1m');
      } else expect(embed).toBeUndefined();
    },
  );

  it('keeps two independent list/detail panels on their originating messages', async () => {
    const f = fixture();
    f.state.publicMessage = { channelId, messageId: f.message.id };
    const panels = new Map<string, { embeds: APIEmbed[]; components: unknown[] }>();
    const canonicalRoute = `/channels/${channelId}/messages/${f.message.id}`;
    panels.set(canonicalRoute, {
      embeds: [{ description: 'Original run notice' }],
      components: [],
    });
    f.rest.get.mockImplementation(async (route: string) => panels.get(route));
    f.rest.patch.mockImplementation(async (route: string, options: { body: never }) => {
      panels.set(route, options.body);
    });
    const actor = { userId: 'owner', channelId, guildId };
    const publish = async (messageId: string, description: string) => {
      const customId = archiveNavigationId(runId, { ...actor, messageId }, { view: 'changes' });
      const route = `/channels/${channelId}/messages/${messageId}`;
      panels.set(route, {
        embeds: [
          {
            description: 'Previous unrelated live job',
            timestamp: '2026-10-06T00:00:00.000Z',
            footer: { text: 'Archive status' },
            color: 0x5865f2,
          },
        ],
        components: [],
      });
      const interaction = {
        user: { id: actor.userId },
        message: { id: messageId },
        channelId,
        editReply: vi.fn(),
        deleteReply: vi.fn(),
      };
      await publishArchiveReply(
        interaction as never,
        archivePublicReply(
          {
            content: description,
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(customId)
                  .setLabel('Changes')
                  .setStyle(ButtonStyle.Secondary),
              ),
            ],
          },
          { runId },
        ),
        f.bot,
        f.access,
      );
      expect(resolveArchiveNavigation(customId, { ...actor, messageId }).runId).toBe(runId);
      expect(() =>
        resolveArchiveNavigation(customId, { ...actor, messageId: f.message.id }),
      ).toThrow('navigation_stale');
      expect(interaction.deleteReply).not.toHaveBeenCalled();
      return route;
    };
    const [first, second] = await Promise.all([
      publish('first-panel', 'First panel: detail page 1'),
      publish('second-panel', 'Second panel: detail page 2'),
    ]);
    expect(panels.get(first)?.embeds).toEqual([{ description: 'First panel: detail page 1' }]);
    expect(panels.get(second)?.embeds).toEqual([{ description: 'Second panel: detail page 2' }]);
    expect(panels.get(canonicalRoute)?.embeds).toEqual([{ description: 'Original run notice' }]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('binds a confirmation to its displayed panel and keeps the worker notice separate', async () => {
    const f = fixture();
    f.state.publicMessage = { channelId, messageId: f.message.id };
    const token = 'abcdefghijklmnopqrstuvwx';
    const confirmation: {
      _id: string;
      runId: string;
      publicMessage?: { channelId: string; messageId: string };
    } = { _id: token, runId };
    const updateOne = vi.fn(async (_filter, update) => {
      confirmation.publicMessage = update.$set.publicMessage;
      return { matchedCount: 1 };
    });
    const previous = f.collection.getMockImplementation()!;
    f.collection.mockImplementation(
      (name: string) =>
        (name === 'archive_control_confirmations'
          ? { updateOne, findOne: vi.fn().mockResolvedValue(confirmation) }
          : previous(name)) as never,
    );
    await publishArchiveReply(
      { user: { id: 'owner' }, message: { id: 'list-panel' }, channelId } as never,
      archivePublicReply(
        {
          content: 'Confirm this run',
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`archive_confirm|${token}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Primary),
            ),
          ],
        },
        { runId },
      ),
      f.bot,
      f.access,
    );
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: token,
        userId: 'owner',
        guildId,
        consumedAt: { $exists: false },
      }),
      { $set: { publicMessage: { channelId, messageId: 'list-panel' } } },
    );
    expect(await archiveConfirmationReference(f.access, token, 'owner')).toEqual({
      channelId,
      messageId: 'list-panel',
    });
    expect(await archiveConfirmationReference(f.access, token, 'owner', 'job')).toEqual({
      channelId,
      messageId: f.message.id,
    });
    expect(f.state.publicMessage).toEqual({ channelId, messageId: f.message.id });
  });
  it('routes a bulk result to a full replacement of the same public message', async () => {
    const f = fixture();
    const interaction = {
      message: { id: f.message.id },
      channelId,
      editReply: vi.fn(),
      deleteReply: vi.fn(),
    };
    await publishArchiveReply(
      interaction as never,
      archiveBulkPublicReply({ content: 'bulk progress', components: [] }),
      f.bot,
      f.access,
    );
    expect(f.rest.patch).toHaveBeenCalledWith(`/channels/${channelId}/messages/${f.message.id}`, {
      body: {
        content: 'bulk progress',
        embeds: [],
        attachments: [],
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
    expect(f.rest.get).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });
  it('retains a validated legacy plan without inventing a queued job and reuses its reference', async () => {
    const f = fixture();
    const target = { runId };
    expect(await ensureArchivePublicReference(f.bot, f.access, target)).toEqual({
      channelId,
      messageId: f.message.id,
    });
    expect(f.manifest).toHaveBeenCalledWith(runId, { limit: 1 });
    expect(f.send.mock.calls[0]?.[0].embeds[0].description).toContain('not applied');
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      enforceNonce: true,
      nonce: expect.stringMatching(/^[a-f0-9]{24}$/),
    });
    expect(f.updateOne).toHaveBeenCalledWith(
      { _id: runId, guildId },
      { $set: { publicMessage: { channelId, messageId: f.message.id } } },
    );
    expect(await ensureArchivePublicReference(f.bot, f.access, target)).toEqual({
      channelId,
      messageId: f.message.id,
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(await archivePublicReference(f.access, target)).toEqual(f.state.publicMessage);
  });
  it('does not duplicate a retained notice on permission or network failure', async () => {
    const f = fixture();
    f.state.publicMessage = { channelId, messageId: f.message.id };
    f.rest.get.mockRejectedValue({ code: 50013 });
    await expect(ensureArchivePublicReference(f.bot, f.access, { runId })).rejects.toEqual({
      code: 50013,
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.updateOne).not.toHaveBeenCalled();
  });
  it('rebuilds a genuinely deleted retained notice and saves its replacement', async () => {
    const f = fixture();
    f.state.publicMessage = { channelId, messageId: 'deleted-message' };
    f.rest.get.mockRejectedValue({ code: 10008 });
    expect(await ensureArchivePublicReference(f.bot, f.access, { runId })).toEqual({
      channelId,
      messageId: f.message.id,
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.state.publicMessage?.messageId).toBe(f.message.id);
  });
  it('validates an unknown run before sending a public notice', async () => {
    const f = fixture();
    f.manifest.mockRejectedValue(new Error('Unknown repair manifest for this guild'));
    await expect(ensureArchivePublicReference(f.bot, f.access, { runId })).rejects.toThrow(
      'Unknown repair manifest',
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  it('removes an unsaved new notice when its durable reference cannot be persisted', async () => {
    const f = fixture();
    f.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(ensureArchivePublicReference(f.bot, f.access, { runId })).rejects.toThrow(
      'navigation_stale',
    );
    expect(f.message.delete).toHaveBeenCalledOnce();
  });
});
