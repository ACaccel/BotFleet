import path from 'node:path';
import type * as AccessModule from '../../../../src/handlers/commands/archive/access';
import type { ArchiveAccess } from '../../../../src/handlers/commands/archive/access';
import type { ArchiveBulkDeletionService } from '../../../../src/infra/archive/bulk-deletion';
import Manage from '../../../../src/handlers/buttons/archive_manage';
import Actions from '../../../../src/handlers/select-menus/archive_actions';
import { archiveJobsReply } from '../../../../src/handlers/commands/archive/jobs-presentation';
import { archivePlansReply } from '../../../../src/handlers/commands/archive/plans-presentation';
import {
  archiveBulkReviewReply,
  archiveBulkProgressReply,
} from '../../../../src/handlers/commands/archive/bulk-presentation';
import {
  archiveBulkPublicReply,
  publishArchiveBulkReply,
} from '../../../../src/handlers/commands/archive/bulk-public-reply';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  publish: vi.fn(),
  failure: vi.fn(),
  review: vi.fn(),
  execute: vi.fn(),
  progress: vi.fn(),
  deletedJob: vi.fn(),
  deletedPlan: vi.fn(),
}));
vi.mock('../../../../src/handlers/commands/archive/access', async (original) => ({
  ...(await original<typeof AccessModule>()),
  requireArchiveAccess: mocks.access,
}));
vi.mock('../../../../src/infra/archive/bulk-deletion', () => ({
  ArchiveBulkDeletionService: class {
    review = mocks.review;
    execute = mocks.execute;
    progress = mocks.progress;
  },
}));
vi.mock('../../../../src/handlers/commands/archive/replies', () => ({
  publishArchiveReply: mocks.publish,
  archiveFailure: mocks.failure,
}));
vi.mock('../../../../src/handlers/commands/archive/deleted-job-message', () => ({
  publishArchiveJobDeletion: mocks.deletedJob,
}));
vi.mock('../../../../src/handlers/commands/archive/deleted-plan-message', () => ({
  publishDeletedArchivePlan: mocks.deletedPlan,
}));
type Review = Awaited<ReturnType<ArchiveBulkDeletionService['review']>>;
type Progress = Awaited<ReturnType<ArchiveBulkDeletionService['execute']>>;
const review: Review = {
  reviewId: 'b8256b3c-77b5-449a-a390-f9b9d349924b',
  kind: 'jobs',
  total: 24,
  eligible: 24,
  protected: 0,
  active: 2,
  expiresAt: 1_900_000_000_000,
};
const result: Progress = {
  reviewId: review.reviewId,
  kind: 'jobs',
  total: 24,
  deleted: 20,
  pending: 2,
  protected: 1,
  failed: 1,
  remaining: 0,
  complete: true,
};
const access = { guildId: '123', debugId: '456', connection: {} } as ArchiveAccess;
const fixture = (customId: string) => ({
  customId,
  user: { id: '789' },
  guildId: '123',
  channelId: '456',
  message: { id: '987', author: { id: 'bot' } },
  deferUpdate: vi.fn(),
  deferred: true,
});
const actor = { userId: '789', channelId: '456', messageId: '987' };
const host = (translator?: Translator) =>
  buildFakeBot({ translator, client: { user: { id: 'bot' } } }).bot;
const customIds = (payload: unknown): string[] =>
  JSON.parse(JSON.stringify(payload)).components.flatMap(
    (row: { components: { custom_id: string }[] }) =>
      row.components.map((component) => component.custom_id),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(access);
  mocks.publish.mockResolvedValue(undefined);
  mocks.review.mockResolvedValue(review);
  mocks.execute.mockResolvedValue(result);
  mocks.progress.mockResolvedValue(result);
});
afterEach(() => vi.useRealTimers());

describe('archive bulk delete controls', () => {
  it('shows only refresh on empty lists without bulk cleanup or filter controls', () => {
    const bot = host();
    for (const [reply, kind] of [
      [archiveJobsReply({ jobs: [] }, bot, true), 'jobs'],
      [archivePlansReply({ plans: [] }, bot), 'plans'],
    ] as const) {
      expect(customIds(reply)).toEqual([`archive_manage|${kind}|first`]);
      expect(JSON.stringify(reply)).not.toMatch(/archive_actions|delete-all|jobs-active/);
    }
  });
  it.each(['jobs', 'plans'] as const)(
    'reviews all %s without deleting before confirmation',
    async (kind) => {
      mocks.review.mockResolvedValue({ ...review, kind });
      await new Manage().execute(
        fixture(`archive_manage|delete-all-${kind}|guild`) as never,
        host(),
      );
      expect(mocks.review).toHaveBeenCalledExactlyOnceWith(kind, actor);
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(customIds(mocks.publish.mock.calls.at(-1)![1])).toContain(
        `archive_manage|bulk-confirm|${review.reviewId}`,
      );
      expect(mocks.publish).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['jobs', 'plans'] as const)(
    'reviews all %s through the dropdown before confirmation',
    async (kind) => {
      const value = `delete-all-${kind}|guild`;
      mocks.review.mockResolvedValue({ ...review, kind });
      const interaction = {
        ...fixture('archive_actions'),
        values: [value],
        message: {
          id: '987',
          author: { id: 'bot' },
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  customId: 'archive_actions',
                  options: [{ value }],
                },
              ],
            },
          ],
        },
      };
      await new Actions().execute(interaction as never, host());
      expect(mocks.review).toHaveBeenCalledExactlyOnceWith(kind, actor);
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(customIds(mocks.publish.mock.calls.at(-1)![1])).toContain(
        `archive_manage|bulk-confirm|${review.reviewId}`,
      );
      expect(mocks.failure).not.toHaveBeenCalled();
    },
  );
  it('passes the exact durable snapshot and actor binding when confirming', async () => {
    await new Manage().execute(
      fixture(`archive_manage|bulk-confirm|${review.reviewId}`) as never,
      host(),
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      review.reviewId,
      actor,
      expect.any(Function),
      expect.any(Function),
    );
    expect(customIds(mocks.publish.mock.calls.at(-1)![1])).toContain(
      `archive_manage|bulk-result|${review.reviewId}`,
    );
  });
  it('refreshes results without repeating a destructive operation', async () => {
    await new Manage().execute(
      fixture(`archive_manage|bulk-result|${review.reviewId}`) as never,
      host(),
    );
    expect(mocks.progress).toHaveBeenCalledWith(review.reviewId, actor);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not offer confirmation when every plan is protected', () => {
    const reply = archiveBulkReviewReply(
      { ...review, kind: 'plans', eligible: 0, protected: 24 },
      host(),
    );
    expect(customIds(reply)).toEqual(['archive_manage|plans|first']);
  });
  it.each(['en', 'zh-TW'] as const)(
    'keeps %s review/result text bounded and fully translated',
    async (locale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      const bot = host(translator);
      for (const kind of ['jobs', 'plans'] as const) {
        for (const reply of [
          archiveBulkReviewReply({ ...review, kind }, bot),
          archiveBulkProgressReply({ ...result, kind }, bot, true),
        ]) {
          expect(String(reply.content).length).toBeLessThanOrEqual(1900);
          expect(JSON.stringify(reply)).not.toMatch(/replies:|commands:|\{\{/);
        }
      }
    },
  );
  it('refreshes unchanged progress every ten seconds and drains timers before the final result', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.execute.mockImplementation(async (_id, _actor, onProgress) => {
      await onProgress({ ...result, complete: false, remaining: 10 });
      await gate;
      return result;
    });
    const task = new Manage().execute(
      fixture(`archive_manage|bulk-confirm|${review.reviewId}`) as never,
      host(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.publish).toHaveBeenCalledTimes(3);
    finish();
    await task;
    expect(mocks.publish).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.publish).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the bulk card intact when its source item is also deleted', async () => {
    mocks.execute.mockImplementation(async (_id, _actor, _progress, onItem) => {
      for (const kind of ['jobs', 'plans'])
        await onItem({
          kind,
          id: 'source',
          outcome: 'deleted',
          notification: { channelId: '456', messageId: '987' },
        });
      await onItem({
        kind: 'jobs',
        id: 'another-job',
        outcome: 'pending',
        notification: { channelId: '456', messageId: 'other' },
      });
      return result;
    });
    await new Manage().execute(
      fixture(`archive_manage|bulk-confirm|${review.reviewId}`) as never,
      host(),
    );
    expect(mocks.deletedPlan).not.toHaveBeenCalled();
    expect(mocks.deletedJob).toHaveBeenCalledExactlyOnceWith(
      'another-job',
      true,
      expect.anything(),
      access,
    );
  });
  it('rejects a stale or wrong-actor approval without publishing a success', async () => {
    mocks.execute.mockRejectedValueOnce(
      new Error('Archive deletion review belongs to another actor'),
    );
    await new Manage().execute(
      fixture(`archive_manage|bulk-confirm|${review.reviewId}`) as never,
      host(),
    );
    expect(mocks.failure).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('replaces the bulk card rather than retaining stale source-job status', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const { bot } = buildFakeBot({ client: { rest: { patch } } });
    const payload = archiveBulkPublicReply({ content: 'review', components: [] });
    await publishArchiveBulkReply(bot, '456', '987', payload);
    expect(patch).toHaveBeenCalledWith('/channels/456/messages/987', {
      body: {
        content: 'review',
        embeds: [],
        attachments: [],
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  });
});
