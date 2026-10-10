import {
  archiveQueuedReply,
  archiveJobReply,
} from '../../../../src/handlers/commands/archive/job-presentation';
import type * as PublicReplyModule from '../../../../src/handlers/commands/archive/public-reply';
import type * as AccessModule from '../../../../src/handlers/commands/archive/access';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Manage from '../../../../src/handlers/buttons/archive_manage';
import Pick from '../../../../src/handlers/select-menus/archive_pick';
import Actions from '../../../../src/handlers/select-menus/archive_actions';
import Attachment from '../../../../src/handlers/modals/archive_attachment';
import { archivePlansReply } from '../../../../src/handlers/commands/archive/plans-presentation';
import { archiveManagePlan } from '../../../../src/handlers/commands/archive/manage-presentation';
import {
  requestArchiveDeletion,
  consumeArchiveDeletion,
} from '../../../../src/handlers/commands/archive/delete-confirmation';
import {
  shortArchiveReference,
  resolveArchiveReference,
} from '../../../../src/handlers/commands/archive/manage-references';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import type { ArchiveAccess } from '../../../../src/handlers/commands/archive/access';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  publish: vi.fn(),
  failure: vi.fn(),
  status: vi.fn(),
  stop: vi.fn(),
  pauseRun: vi.fn(),
  deleteJob: vi.fn(),
  deletePlan: vi.fn(),
  manifest: vi.fn(),
  plans: vi.fn(),
  jobs: vi.fn(),
  submit: vi.fn(),
  requestConfirmation: vi.fn(),
}));
vi.mock('../../../../src/handlers/commands/archive/access', async (original) => ({
  ...(await original<typeof AccessModule>()),
  requireArchiveAccess: mocks.access,
}));
vi.mock('../../../../src/handlers/commands/archive/replies', () => ({
  publishArchiveReply: mocks.publish,
  archiveFailure: mocks.failure,
}));
vi.mock('../../../../src/handlers/commands/archive/deleted-job-message', () => ({
  publishArchiveJobDeletion: vi.fn(),
}));
vi.mock('../../../../src/handlers/commands/archive/public-reply', async (original) => ({
  ...(await original<typeof PublicReplyModule>()),
  archivePublicReference: vi.fn().mockResolvedValue(undefined),
  ensureArchivePublicReference: vi.fn().mockResolvedValue(undefined),
}));
let translator: Translator;
const plan = {
  runId: 'run',
  guildId: 'guild',
  status: 'planned',
  createdAt: 1000,
  cutoff: 1000,
  operations: 12,
  unresolved: 0,
  journalBytes: 0,
  issueCount: 0,
  issueCategories: [],
  actions: [],
  deletable: true,
};
const summary = {
  status: 'available',
  totalOperations: 12,
  categories: [],
  impacts: {
    insertOperations: 0,
    updateOperations: 12,
    deleteOperations: 0,
    unknownImpactOperations: 0,
  },
};
const job = {
  jobId: 'guild:job',
  requestId: 'request',
  guildId: 'guild',
  command: 'audit',
  status: 'running',
  createdAt: 1000,
  cancelRequested: false,
  counts: {},
  issueCount: 0,
  issueCategories: [],
  progress: sanitizeArchiveProgress({ work: 'audit', state: 'running', phase: 'repair' })!,
};
const access = { control: mocks, guildId: 'guild', debugId: 'debug' } as unknown as ArchiveAccess;
const actor = { userId: 'owner', guildId: 'guild', channelId: 'debug', messageId: 'card' };
const fixture = (customId: string) => ({
  customId,
  user: { id: 'owner' },
  guildId: 'guild',
  channelId: 'debug',
  values: ['guild:job'],
  message: { id: 'card', author: { id: 'bot' } },
  deferUpdate: vi.fn(),
  deferReply: vi.fn(),
  showModal: vi.fn(),
  fields: { getTextInputValue: vi.fn().mockReturnValue('123456789012345678') },
});
const host = () => buildFakeBot({ translator, client: { user: { id: 'bot' } } }).bot;
const buttons = (payload: unknown): { custom_id: string; label: string; type: number }[] =>
  JSON.parse(JSON.stringify(payload)).components.flatMap(
    (row: { components: unknown[] }) => row.components,
  );
beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: 'zh-TW',
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(access);
  mocks.status.mockResolvedValue(job);
  mocks.stop.mockResolvedValue({ ...job, cancelRequested: true });
  mocks.deleteJob.mockResolvedValue({ jobId: job.jobId, pending: true, deleted: false });
  mocks.deletePlan.mockResolvedValue({ runId: plan.runId, deleted: true });
  mocks.manifest.mockResolvedValue({ run: plan, summary });
  mocks.jobs.mockResolvedValue({ jobs: [job] });
  mocks.plans.mockResolvedValue({ plans: [plan] });
  mocks.submit.mockResolvedValue(job);
  mocks.requestConfirmation.mockImplementation(async (action, id) => ({
    token: 'confirmation-token',
    action,
    run: { ...plan, runId: id, actions: [action, 'rollback'] },
    summary: {
      status: 'available',
      totalOperations: 12,
      categories: [],
      impacts: {
        insertOperations: 0,
        updateOperations: 12,
        deleteOperations: 0,
        unknownImpactOperations: 0,
      },
    },
    expiresAt: Date.now() + 300_000,
  }));
});

describe('archive public management', () => {
  it('offers stop without combined deletion on queued and running replies', async () => {
    const bot = host();
    const queued = archiveQueuedReply(
      { ...job, status: 'queued' } as Parameters<typeof archiveQueuedReply>[0],
      bot,
    );
    const running = await archiveJobReply(
      job as Parameters<typeof archiveJobReply>[0],
      bot,
      access.control,
      null,
    );
    for (const reply of [queued, running]) {
      expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
        'archive_manage|stop|guild:job',
      );
      expect(
        buttons(reply).filter(
          (entry) =>
            entry.custom_id.startsWith('archive_manage|') ||
            entry.custom_id.startsWith('archive_panel|'),
        ).length,
      ).toBeLessThanOrEqual(3);
      expect(buttons(reply).every((entry) => entry.type === 2)).toBe(true);
      expect(JSON.stringify(reply)).not.toContain('delete-job|guild:job');
    }
  });
  it.each(['complete', 'partial', 'cancelled', 'failed'])(
    'offers direct deletion only after a job becomes %s',
    async (status) => {
      const reply = await archiveJobReply(
        { ...job, status } as Parameters<typeof archiveJobReply>[0],
        host(),
        access.control,
        null,
      );
      expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
        'archive_manage|delete-job|guild:job',
      );
      expect(JSON.stringify(reply)).not.toContain('archive_manage|stop|');
      expect(buttons(reply).every((entry) => entry.type === 2)).toBe(true);
      expect(buttons(reply).length).toBeLessThanOrEqual(5);
    },
  );
  it('keeps a long terminal job identity intact in its direct deletion button', async () => {
    const id = 'j'.repeat(160);
    const reply = await archiveJobReply(
      { ...job, jobId: id, status: 'complete' } as Parameters<typeof archiveJobReply>[0],
      host(),
      access.control,
      null,
    );
    const control = buttons(reply).find((entry) =>
      entry.custom_id.startsWith('archive_manage|ref|'),
    )!;
    expect(control.custom_id.length).toBeLessThanOrEqual(100);
    expect(
      resolveArchiveReference(control.custom_id.slice('archive_manage|ref|'.length)),
    ).toMatchObject({
      action: 'delete-job',
      id,
    });
    await new Manage().execute(fixture(control.custom_id) as never, host());
    expect(mocks.status).toHaveBeenCalledWith(id);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.publish.mock.calls[0]![1])).toContain(
      'archive_manage|delete-confirm|',
    );
  });
  it.each([
    { status: 'running', cancelRequested: true },
    { status: 'complete', deleteRequestedAt: 1000 },
  ])('omits repeated stop or deletion while the request is pending (%s)', async (state) => {
    const reply = await archiveJobReply(
      { ...job, ...state } as Parameters<typeof archiveJobReply>[0],
      host(),
      access.control,
      null,
    );
    expect(JSON.stringify(reply)).not.toMatch(/archive_manage\|(?:stop|delete-job)\|/);
    expect(buttons(reply).every((entry) => entry.type === 2)).toBe(true);
  });
  it('renders a legacy selected job with stop and direct navigation', async () => {
    const interaction = fixture('archive_pick|jobs');
    await new Pick().execute(interaction as never, host());
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.access).toHaveBeenCalledOnce();
    const payload = mocks.publish.mock.calls[0]![1];
    expect(buttons(payload).map((entry) => entry.custom_id)).toContain(
      'archive_manage|stop|guild:job',
    );
    expect(JSON.stringify(payload)).not.toContain('delete-job|guild:job');
    expect(buttons(payload).every((entry) => entry.type === 2)).toBe(true);
    expect(
      buttons(payload).filter((entry) => entry.custom_id.startsWith('archive_manage|')).length,
    ).toBeLessThanOrEqual(3);
    expect(JSON.stringify(payload)).not.toMatch(/archive_manage\|(?:details|inspect)/);
    expect(String(payload.content)).toContain('目前階段');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('pauses the exact selected plan job even when its aggregate summary is unavailable', async () => {
    const activeJob = { jobId: 'guild:active-job', status: 'running', cancelRequested: false };
    mocks.manifest.mockResolvedValue({
      run: { ...plan, status: 'enriching', activeJob },
      summary: { status: 'unavailable', reason: 'timeout' },
    });
    const reply = await archiveManagePlan(plan.runId, host(), access, actor);
    const controls = buttons(reply);
    const pause = controls.find(
      (control) => control.label === translator.t('replies:archive.plan_pause'),
    )!;
    expect(pause).toBeDefined();
    expect(controls.map((control) => control.label)).toContain(
      translator.t('replies:archive.plan_refresh'),
    );
    expect(controls.map((control) => control.label)).toContain(
      translator.t('replies:archive.manage_back_plans'),
    );
    const reference = resolveArchiveReference(pause.custom_id.slice('archive_manage|ref|'.length));
    expect(JSON.parse(reference.id)).toEqual({ runId: plan.runId, jobId: activeJob.jobId });
    mocks.pauseRun.mockImplementation(async () => {
      activeJob.cancelRequested = true;
      return { ...job, runId: plan.runId, cancelRequested: true };
    });
    await new Manage().execute(fixture(pause.custom_id) as never, host());
    expect(mocks.pauseRun).toHaveBeenCalledWith(plan.runId, activeJob.jobId);
    expect(mocks.failure).not.toHaveBeenCalled();
    const result = mocks.publish.mock.calls.at(-1)![1];
    expect(result.content).toContain(translator.t('replies:archive.plan_pausing'));
    expect(buttons(result).map((control) => control.label)).not.toContain(
      translator.t('replies:archive.plan_pause'),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('requests cooperative stop and displays stopping before deletion', async () => {
    mocks.status.mockResolvedValue({ ...job, cancelRequested: true });
    await new Manage().execute(fixture('archive_manage|stop|guild:job') as never, host());
    expect(mocks.stop).toHaveBeenCalledWith(job.jobId);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls[0]![1].content).toContain('正在停止');
  });
  it('keeps legacy running-job deletion behind a second actor-bound click', async () => {
    const interaction = fixture('archive_manage|delete-job|guild:job');
    const bot = host();
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    const confirm = buttons(mocks.publish.mock.calls[0]![1]).find((entry) =>
      entry.custom_id.startsWith('archive_manage|delete-confirm|'),
    )!;
    interaction.customId = confirm.custom_id;
    interaction.user.id = 'other';
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.failure).toHaveBeenCalledOnce();
    interaction.user.id = 'owner';
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deleteJob).toHaveBeenCalledExactlyOnceWith(job.jobId);
    expect(mocks.publish.mock.calls.at(-1)![1].content).toContain('工作結束後');
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deleteJob).toHaveBeenCalledOnce();
  });
  it('opens the same deletion confirmation from the more-actions menu', async () => {
    const value = 'delete-job|guild:job';
    const interaction = {
      ...fixture('archive_actions'),
      values: [value],
      message: {
        id: 'card',
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
    const bot = host();
    await new Actions().execute(interaction as never, bot);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.failure).not.toHaveBeenCalled();
    const confirm = buttons(mocks.publish.mock.calls[0]![1]).find((entry) =>
      entry.custom_id.startsWith('archive_manage|delete-confirm|'),
    )!;
    await new Manage().execute(
      { ...fixture(confirm.custom_id), user: { id: 'other' } } as never,
      bot,
    );
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    await new Manage().execute(fixture(confirm.custom_id) as never, bot);
    expect(mocks.deleteJob).toHaveBeenCalledExactlyOnceWith(job.jobId);
  });
  it('only offers deletion for backend-approved unapplied plans', async () => {
    const bot = host();
    const eligible = await archiveManagePlan('run', bot, access, actor);
    expect(JSON.stringify(eligible).includes('delete-plan|run')).toBe(true);
    mocks.manifest.mockResolvedValue({
      run: { ...plan, status: 'complete', deletable: false },
      summary,
    });
    const applied = await archiveManagePlan('run', bot, access, actor);
    expect(JSON.stringify(applied).includes('delete-plan')).toBe(false);
    await new Manage().execute(fixture('archive_manage|delete-plan|run') as never, bot);
    expect(mocks.deletePlan).not.toHaveBeenCalled();
    expect(mocks.failure).toHaveBeenCalledOnce();
  });
  it.each(['apply', 'resume', 'accept'])(
    'opens the exact %s confirmation directly when a plan is selected',
    async (action) => {
      mocks.manifest.mockResolvedValue({ run: { ...plan, actions: [action, 'rollback'] } });
      const interaction = fixture('archive_pick|plans');
      interaction.values = ['run'];
      await new Pick().execute(interaction as never, host());
      const reply = mocks.publish.mock.calls[0]![1];
      expect(mocks.requestConfirmation).toHaveBeenCalledExactlyOnceWith(action, 'run', {
        userId: actor.userId,
        channelId: actor.channelId,
        messageId: actor.messageId,
      });
      expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
        'archive_confirm|confirmation-token',
      );
      expect(buttons(reply).every((entry) => entry.type === 2)).toBe(true);
      expect(buttons(reply)).toHaveLength(5);
      expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
        'archive_manage|rollback|run',
      );
      expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
        'archive_manage|delete-plan|run',
      );
      expect(String(reply.content)).toContain('<@owner>');
      expect(JSON.stringify(reply)).toContain('rollback|run');
      expect(JSON.stringify(reply)).not.toMatch(
        /archive_manage\|(?:inspect|plan-advanced)|technical|verify/,
      );
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.deletePlan).not.toHaveBeenCalled();
    },
  );
  it('opens eligible rollback through a direct button without executing it', async () => {
    mocks.manifest.mockResolvedValue({ run: { ...plan, actions: ['rollback'] }, summary });
    const bot = host();
    const reply = await archiveManagePlan('run', bot, access, actor);
    const rollback = buttons(reply).find(
      (entry) => entry.custom_id === 'archive_manage|rollback|run',
    )!;
    expect(rollback).toBeDefined();
    await new Manage().execute(fixture(rollback.custom_id) as never, bot);
    expect(mocks.requestConfirmation).toHaveBeenCalledExactlyOnceWith('rollback', 'run', {
      userId: actor.userId,
      channelId: actor.channelId,
    });
    const confirmation = mocks.publish.mock.calls[0]![1];
    expect(JSON.stringify(confirmation)).toContain('archive_confirm|confirmation-token');
    expect(JSON.stringify(confirmation)).not.toContain('archive_manage|rollback|run');
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.deletePlan).not.toHaveBeenCalled();
  });
  it('opens a terminal job confirmation with direct job deletion', async () => {
    mocks.status.mockResolvedValue({ ...job, command: 'apply', status: 'complete', runId: 'run' });
    mocks.manifest.mockResolvedValue({ run: { ...plan, status: 'complete', actions: ['accept'] } });
    await new Pick().execute(fixture('archive_pick|jobs') as never, host());
    const reply = mocks.publish.mock.calls[0]![1];
    expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
      'archive_confirm|confirmation-token',
    );
    expect(mocks.requestConfirmation).toHaveBeenCalledExactlyOnceWith('accept', 'run', {
      userId: actor.userId,
      channelId: actor.channelId,
      messageId: actor.messageId,
    });
    expect(buttons(reply).every((entry) => entry.type === 2)).toBe(true);
    expect(buttons(reply)).toHaveLength(5);
    expect(buttons(reply).map((entry) => entry.custom_id)).toContain(
      'archive_manage|delete-job|guild:job',
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('routes legacy advanced entry points back to the compact cards', async () => {
    await new Manage().execute(fixture('archive_manage|advanced|jobs') as never, host());
    const jobsReply = mocks.publish.mock.calls[0]![1];
    expect(JSON.stringify(jobsReply)).not.toMatch(/archive_manage\|(?:audit|attachment|advanced)/);
    await new Manage().execute(fixture('archive_manage|plan-advanced|run') as never, host());
    const planReply = mocks.publish.mock.calls[1]![1];
    expect(JSON.stringify(planReply)).not.toMatch(
      /archive_manage\|(?:technical|verify|plan-advanced)/,
    );
  });
  it('deletes only the selected plan after confirmation and reports the result publicly', async () => {
    const interaction = fixture('archive_manage|delete-plan|run');
    const bot = host();
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deletePlan).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls[0]![1].content).toContain('run');
    interaction.customId = buttons(mocks.publish.mock.calls[0]![1]).find((entry) =>
      entry.custom_id.includes('delete-confirm'),
    )!.custom_id;
    await new Manage().execute(interaction as never, bot);
    expect(mocks.deletePlan).toHaveBeenCalledExactlyOnceWith('run');
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls.at(-1)![1].content).toContain('已刪除');
  });
  it('honors backend eligibility changes between review and confirmation', async () => {
    const interaction = fixture('archive_manage|delete-plan|run');
    const bot = host();
    await new Manage().execute(interaction as never, bot);
    interaction.customId = buttons(mocks.publish.mock.calls[0]![1]).find((entry) =>
      entry.custom_id.includes('delete-confirm'),
    )!.custom_id;
    mocks.deletePlan.mockRejectedValueOnce(
      new Error('Repair plan cannot be deleted while work is active'),
    );
    await new Manage().execute(interaction as never, bot);
    expect(mocks.failure).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it.each(['audit', 'verify'])(
    'retains the %s advanced operation behind buttons',
    async (action) => {
      await new Manage().execute(fixture(`archive_manage|${action}|run`) as never, host());
      expect(mocks.submit).toHaveBeenCalledWith(action, {
        ...(action === 'verify' ? { runId: 'run' } : {}),
        notification: { channelId: 'debug' },
      });
      expect(mocks.failure).not.toHaveBeenCalled();
    },
  );
  it('uses first and next-page buttons without exposing cursor options', async () => {
    const bot = host();
    await new Manage().execute(fixture('archive_manage|plans|cursor') as never, bot);
    expect(mocks.plans).toHaveBeenCalledWith({ before: 'cursor', limit: 2 });
    await new Manage().execute(fixture('archive_manage|jobs|first') as never, bot);
    expect(mocks.jobs).toHaveBeenCalledWith({ all: true, before: undefined, limit: 2 });
  });
  it.each(['archive_pick|jobs', 'archive_pick|plans'])(
    'rejects %s on a non-bot message',
    async (customId) => {
      const interaction = fixture(customId);
      interaction.message.author.id = 'someone';
      await new Pick().execute(interaction as never, host());
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.failure).toHaveBeenCalledOnce();
    },
  );
  it.each(['stop|guild:job', 'delete-job|guild:job', 'delete-plan|run', 'rollback|run'])(
    'rechecks authorization before the destructive %s button',
    async (action) => {
      mocks.access.mockRejectedValue(new Error('denied'));
      await new Manage().execute(fixture(`archive_manage|${action}`) as never, host());
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.deleteJob).not.toHaveBeenCalled();
      expect(mocks.deletePlan).not.toHaveBeenCalled();
      expect(mocks.requestConfirmation).not.toHaveBeenCalled();
      expect(mocks.failure).toHaveBeenCalledOnce();
    },
  );
  it('resolves long legacy IDs without truncating the target', async () => {
    const id = 'j'.repeat(160);
    const token = shortArchiveReference('job', id);
    const interaction = fixture('archive_pick|jobs');
    interaction.values = ['ref:' + token];
    await new Pick().execute(interaction as never, host());
    expect(mocks.status).toHaveBeenCalledWith(id);
    expect(resolveArchiveReference(token).id).toBe(id);
  });
  it('offers reviewed deletion alongside two plans without skipping hidden entries', () => {
    const plans = Array.from({ length: 10 }, (_, index) => ({ ...plan, runId: `run-${index}` }));
    const reply = archivePlansReply({ plans, nextCursor: 'run-9' }, host());
    const components = JSON.parse(JSON.stringify(reply.components))[0].components;
    expect(components).toHaveLength(5);
    expect(components.every((entry: { type: number }) => entry.type === 2)).toBe(true);
    expect(components.map((entry: { custom_id: string }) => entry.custom_id)).toEqual([
      'archive_manage|plan|run-0',
      'archive_manage|plan|run-1',
      'archive_manage|plans|first',
      'archive_manage|delete-all-plans|guild',
      'archive_manage|plans|run-1',
    ]);
    expect(components[3]).toMatchObject({ type: 2, style: 4 });
    expect(String(reply.content).length).toBeLessThanOrEqual(1900);
    expect(JSON.stringify(reply)).not.toMatch(/replies:|commands:/);
  });
  it('opens attachment fields without acknowledging the button first', async () => {
    const interaction = fixture('archive_manage|attachment|guild');
    await new Manage().execute(interaction as never, host());
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.showModal).toHaveBeenCalledOnce();
    expect(JSON.stringify(interaction.showModal.mock.calls[0])).not.toMatch(/replies:|commands:/);
  });
  it('submits validated attachment scope through the retained backend', async () => {
    const interaction = fixture('archive_attachment');
    await new Attachment().execute(interaction as never, host());
    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(mocks.submit).toHaveBeenCalledWith(
      'refresh-attachment',
      expect.objectContaining({
        channelId: '123456789012345678',
        messageId: '123456789012345678',
        attachmentId: '123456789012345678',
        userId: 'owner',
      }),
    );
  });
  it('rejects malformed attachment IDs without submitting work', async () => {
    const interaction = fixture('archive_attachment');
    interaction.fields.getTextInputValue.mockReturnValue('not-an-id');
    await new Attachment().execute(interaction as never, host());
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.failure).toHaveBeenCalledOnce();
  });
  it.each(['userId', 'guildId', 'channelId', 'messageId'] as const)(
    'binds deletion confirmation to %s',
    (field) => {
      const token = requestArchiveDeletion('plan', 'run', actor);
      expect(() => consumeArchiveDeletion(token, { ...actor, [field]: 'other' })).toThrow();
      expect(consumeArchiveDeletion(token, actor).id).toBe('run');
      expect(() => consumeArchiveDeletion(token, actor)).toThrow();
    },
  );
  it('expires destructive approvals instead of treating elapsed time as approval', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const token = requestArchiveDeletion('job', 'job', actor);
    now.mockReturnValue(302000);
    expect(() => consumeArchiveDeletion(token, actor)).toThrow();
    now.mockRestore();
  });
});
