import { resolveArchiveReference } from '../../../../src/handlers/commands/archive/manage-references';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import Archive from '../../../../src/handlers/commands/archive';
import ArchiveConfirm from '../../../../src/handlers/buttons/archive_confirm';
import ArchivePanel from '../../../../src/handlers/buttons/archive_panel';
import ArchiveView from '../../../../src/handlers/buttons/archive_view';
import ArchiveJobs from '../../../../src/handlers/buttons/archive_jobs';
import { resolveArchiveNavigation } from '../../../../src/handlers/commands/archive/navigation';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const controls = vi.hoisted(() => ({
  construct: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  purgeJobs: vi.fn(),
  jobs: vi.fn(),
  plans: vi.fn(),
  manifest: vi.fn(),
  requestConfirmation: vi.fn(),
  validateConfirmation: vi.fn(),
  confirm: vi.fn(),
  autocomplete: vi.fn(),
  progressDetails: vi.fn(),
}));
vi.mock('../../../../src/infra/archive/control', () => ({
  ArchiveControlService: class {
    constructor(...args: unknown[]) {
      controls.construct(...args);
    }
    submit = controls.submit;
    status = controls.status;
    cancel = controls.cancel;
    purgeJobs = controls.purgeJobs;
    jobs = controls.jobs;
    plans = controls.plans;
    manifest = controls.manifest;
    requestConfirmation = controls.requestConfirmation;
    validateConfirmation = controls.validateConfirmation;
    confirm = controls.confirm;
    autocomplete = controls.autocomplete;
    progressDetails = controls.progressDetails;
  },
}));
vi.mock('../../../../src/plugins/message-backup/runtime/job-notification', () => ({
  ArchiveJobNotifier: class {
    publish = vi.fn().mockResolvedValue(undefined);
    publishScan = vi.fn().mockResolvedValue(undefined);
  },
}));
const GUILD = '123456789012345678';
const DEBUG = '223456789012345678';
const USER = '323456789012345678';
const BOT = '423456789012345678';
const token = 'abcdefghijklmnopqrstuvwx';
let translator: Translator;
const manifestSummary = {
  status: 'available',
  totalOperations: 4,
  categories: [
    {
      category: 'remove-duplicate-progress',
      operations: 4,
      insertOperations: 0,
      updateOperations: 0,
      deleteOperations: 4,
      unknownImpactOperations: 0,
    },
  ],
  impacts: {
    insertOperations: 0,
    updateOperations: 0,
    deleteOperations: 4,
    unknownImpactOperations: 0,
  },
};
const run = {
  guildId: GUILD,
  runId: 'run',
  status: 'planned',
  operations: 4,
  unresolved: 0,
  issueCount: 0,
  journalBytes: 600,
  createdAt: 100,
  cutoff: 100,
  actions: ['apply'],
  validUntil: Date.now() + 60_000,
};
const manifest = {
  run,
  summary: manifestSummary,
  operations: [],
  nextSequence: -1,
  hasNext: false,
  hasPrevious: false,
};
const job = {
  guildId: GUILD,
  jobId: `${GUILD}:job`,
  command: 'audit',
  status: 'queued',
  createdAt: 100,
  counts: { total: 3 },
  issueCount: 0,
  progress: sanitizeArchiveProgress({
    phase: 'repair',
    state: 'queued',
    work: 'audit',
    jobId: `${GUILD}:job`,
  }),
};
beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: 'zh-TW',
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  controls.submit.mockResolvedValue(job);
  controls.status.mockResolvedValue(job);
  controls.cancel.mockResolvedValue({ ...job, cancelRequested: true });
  controls.jobs.mockResolvedValue({ jobs: [job], nextCursor: 'cursor' });
  controls.manifest.mockResolvedValue(manifest);
  controls.requestConfirmation.mockImplementation(async (action, runId) => ({
    token,
    action,
    run: { ...run, runId },
    summary: manifestSummary,
    expiresAt: Date.now() + 300000,
  }));
  controls.validateConfirmation.mockResolvedValue(undefined);
  controls.confirm.mockResolvedValue({ ...job, command: 'apply' });
  controls.autocomplete.mockResolvedValue([{ name: 'run', value: 'run' }]);
  controls.progressDetails.mockResolvedValue({ activities: [], gaps: [], page: 1, hasNext: false });
});
const fixture = (action = 'audit', options: Record<string, string | number> = {}) => {
  const report = {
    id: '523456789012345678',
    author: { id: BOT },
    content: 'original confirmation',
    components: [],
    flags: { has: () => false },
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const send = vi.fn().mockResolvedValue(report);
  const channel = Object.assign(buildTextChannel({ id: DEBUG }), { send });
  const guild = Object.assign(buildGuild({ id: GUILD, channels: [channel], me: { id: BOT } }), {
    ownerId: USER,
  });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'archive',
    guild,
    userId: USER,
    channel,
    options,
    channels: { channel: { id: '623456789012345678' } },
    sink,
  });
  const deleteReply = vi.fn();
  Object.assign(interaction, {
    deleteReply,
    deferUpdate: vi.fn().mockImplementation(async () => {
      sink.acknowledged.deferred = true;
    }),
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    id: 'interaction',
  });
  Object.assign(interaction.options, {
    getSubcommandGroup: () => null,
    getSubcommand: () => action,
  });
  const collection = vi.fn((name: string) => ({
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    findOne: vi.fn(async () =>
      name === 'archive_control_confirmations'
        ? { _id: token, runId: 'run' }
        : { ...job, runId: 'run', notification: { channelId: DEBUG, messageId: report.id } },
    ),
  }));
  const connection = { collection };
  const getConnection = vi.fn().mockResolvedValue({ archiveOwner: 'msg-archive', connection });
  const rest = {
    get: vi.fn().mockResolvedValue({
      embeds: [
        {
          description: 'CURRENT_PUBLIC_STATUS',
          timestamp: '2026-10-06T00:00:00.000Z',
          footer: { text: 'Archive status' },
          color: 0x5865f2,
        },
      ],
      components: [],
    }),
    patch: vi.fn().mockImplementation(async (_route, { body }) => {
      sink.editReplies.push({
        content: body.embeds?.at(-1)?.description ?? '',
        components: body.components.map((row: unknown) => ({ toJSON: () => row })),
      } as never);
    }),
  };
  const { bot } = buildFakeBot({
    translator,
    client: { rest, user: { id: BOT } },
    config: { backup_server: [GUILD], guilds: { [GUILD]: { channels: { debug: DEBUG } } } },
    connectionManager: { getConnection },
  });
  return {
    interaction,
    bot,
    sink,
    channel,
    send,
    report,
    deleteReply,
    getConnection,
    rest,
    collection,
  };
};
describe('Archive Discord control', () => {
  const buttonIds = (f: ReturnType<typeof fixture>): string[] =>
    f.sink.editReplies.flatMap((payload) =>
      (payload.components ?? []).flatMap((row) =>
        (row as { toJSON(): { components: { custom_id: string }[] } })
          .toJSON()
          .components.map((component) => component.custom_id),
      ),
    );
  it('completes the guided backup using plan, explicit apply and explicit accept without another verify job', async () => {
    controls.submit.mockResolvedValue({ ...job, command: 'plan' });
    const start = fixture('backup');
    await new Archive().execute(start.interaction, start.bot);
    expect(controls.submit).toHaveBeenCalledWith('plan', { notification: { channelId: DEBUG } });
    expect(start.sink.editReplies[0]?.content).toContain('尚未開始');
    expect(start.sink.editReplies[0]?.content).not.toContain('```');
    const prepared = fixture();
    controls.status.mockResolvedValue({
      ...job,
      command: 'plan',
      status: 'complete',
      runId: 'run',
    });
    Object.assign(prepared.interaction, {
      customId: `archive_panel|${job.jobId}`,
      message: { ...prepared.report, flags: { has: () => false } },
    });
    await new ArchivePanel().execute(prepared.interaction as never, prepared.bot);
    expect(prepared.sink.defers).toEqual([]);
    expect(buttonIds(prepared)).toContain(`archive_confirm|${token}`);
    expect(prepared.sink.editReplies[0]?.content).toContain('移除重複進度');
    const apply = fixture();
    Object.assign(apply.interaction, {
      customId: `archive_confirm|${token}`,
      message: apply.report,
    });
    await new ArchiveConfirm().execute(apply.interaction as never, apply.bot);
    controls.status.mockResolvedValue({
      ...job,
      command: 'apply',
      status: 'complete',
      runId: 'run',
      progress: sanitizeArchiveProgress({
        phase: 'verification',
        work: 'apply',
        state: 'complete',
        messages: { inserted: 12, updated: 4, unchanged: 8 },
        reactions: { required: 5, completed: 5 },
        validation: { state: 'passed', coverage: 'complete' },
      }),
    });
    controls.manifest.mockResolvedValue({
      ...manifest,
      run: { ...run, status: 'complete', actions: ['accept'] },
    });
    controls.requestConfirmation.mockImplementation(async (action) => ({
      token,
      action,
      run: { ...run, status: 'complete' },
      summary: manifestSummary,
      expiresAt: Date.now() + 300000,
    }));
    const completed = fixture();
    Object.assign(completed.interaction, {
      customId: `archive_panel|${job.jobId}`,
      message: completed.report,
    });
    await new ArchivePanel().execute(completed.interaction as never, completed.bot);
    expect(completed.sink.editReplies[0]?.content).toContain('72 小時');
    expect(completed.sink.editReplies[0]?.content).toContain('12');
    expect(completed.sink.editReplies[0]?.content).not.toContain('```');
    expect(buttonIds(completed)).toContain(`archive_confirm|${token}`);
    expect(controls.requestConfirmation).toHaveBeenLastCalledWith('accept', 'run', {
      userId: USER,
      channelId: DEBUG,
      messageId: completed.report.id,
    });
    expect(controls.confirm).toHaveBeenCalledTimes(1);
    expect(controls.submit).toHaveBeenCalledTimes(1);
    controls.confirm.mockResolvedValue({ ...job, command: 'accept' });
    const accept = fixture();
    Object.assign(accept.interaction, {
      customId: `archive_confirm|${token}`,
      message: accept.report,
    });
    await new ArchiveConfirm().execute(accept.interaction as never, accept.bot);
    expect(controls.requestConfirmation.mock.calls.map(([action]) => action)).toEqual([
      'apply',
      'accept',
    ]);
    expect(controls.confirm).toHaveBeenCalledTimes(2);
    expect(controls.submit).toHaveBeenCalledTimes(1);
    expect(controls.submit.mock.calls.some(([action]) => action === 'verify')).toBe(false);
    expect(prepared.send).not.toHaveBeenCalled();
    expect(completed.send).not.toHaveBeenCalled();
  });
  it('renders the fresh confirmation summary instead of the earlier run snapshot', async () => {
    const f = fixture('inspect', { run_id: 'run' });
    controls.requestConfirmation.mockResolvedValue({
      token,
      action: 'apply',
      run: { ...run, operations: 99 },
      summary: {
        ...manifestSummary,
        totalOperations: 99,
        categories: [{ ...manifestSummary.categories[0], operations: 99 }],
      },
      expiresAt: Date.now() + 300000,
    });
    await new Archive().execute(f.interaction, f.bot);
    expect(f.sink.editReplies[0]?.content).toContain('99');
    expect(f.sink.editReplies[0]?.content).not.toContain('預計調整：4');
  });
  it('keeps legacy sequence options compatible but renders human change rows by default', async () => {
    const f = fixture('inspect', { run_id: 'run', after_sequence: 4, limit: 25 });
    controls.manifest.mockResolvedValue({
      ...manifest,
      operations: [
        {
          category: 'repair-message-time',
          state: 'planned',
          sequence: 5,
          beforeHash: 'sensitive-hash',
        },
      ],
      nextSequence: 5,
    });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.manifest).toHaveBeenCalledWith('run', { afterSequence: 4, limit: 5 });
    expect(f.sink.editReplies[0]?.content).toContain('修正訊息時間');
    expect(f.sink.editReplies[0]?.content).not.toContain('sensitive-hash');
    expect(f.sink.editReplies[0]?.content).not.toContain('```');
  });
  it('navigates a filtered manifest backward and forward in the shared detail section', async () => {
    controls.manifest.mockResolvedValue({
      ...manifest,
      operations: [
        {
          category: 'merge-duplicate-messages',
          state: 'planned',
          sequence: 5,
          target: { identity: 'unknown' },
          reason: 'merge-compatible-duplicate',
          collection: 'messages',
          impact: 'update',
        },
      ],
      hasNext: true,
      hasPrevious: true,
      nextCursor: 9,
      previousCursor: 5,
    });
    const f = fixture();
    Object.assign(f.interaction, { customId: 'archive_view|run|c|n|4|3', message: f.report });
    await new ArchiveView().execute(f.interaction as never, f.bot);
    expect(controls.manifest).toHaveBeenCalledWith('run', {
      afterSequence: 4,
      category: 'merge-duplicate-messages',
      limit: 5,
    });
    const pages = buttonIds(f)
      .filter((id) => id.startsWith('archive_browse|'))
      .map(
        (id) =>
          resolveArchiveNavigation(id, {
            userId: USER,
            channelId: DEBUG,
            guildId: GUILD,
            messageId: '523456789012345678',
          }).page,
      );
    expect(pages).toContainEqual(
      expect.objectContaining({ beforeSequence: 5, category: 'merge-duplicate-messages' }),
    );
    expect(pages).toContainEqual(
      expect.objectContaining({ afterSequence: 5, category: 'merge-duplicate-messages' }),
    );
    expect(controls.confirm).not.toHaveBeenCalled();
  });
  it('reopens legacy technical links as safe changes in the durable public message', async () => {
    const f = fixture();
    controls.manifest.mockResolvedValue({
      ...manifest,
      operations: [{ beforeHash: 'private-hash' }],
    });
    Object.assign(f.interaction, {
      customId: 'archive_view|run|t|a|-1|a',
      message: { ...f.report, flags: { has: () => false } },
    });
    await new ArchiveView().execute(f.interaction as never, f.bot);
    expect(f.sink.defers).toEqual([]);
    expect(f.sink.editReplies[0]?.content).not.toContain('private-hash');
    expect(f.rest.patch.mock.calls[0]?.[1].body.embeds[0].description).toBe(
      'CURRENT_PUBLIC_STATUS',
    );
    expect(f.sink.editReplies[0]?.content).not.toContain('下載');
    expect(f.sink.followUps).toEqual([]);
    expect(f.report.edit).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['changes', 'technical'])(
    'opens the direct public %s page from the durable job button',
    async (view) => {
      const f = fixture();
      controls.status.mockResolvedValue({ ...job, runId: 'run' });
      Object.assign(f.interaction, {
        customId: `archive_panel|${job.jobId}|${view}`,
        message: f.report,
      });
      await new ArchivePanel().execute(f.interaction as never, f.bot);
      expect(controls.status).toHaveBeenCalledWith(job.jobId);
      expect(controls.manifest).toHaveBeenCalledWith('run', { limit: 5 });
      expect(f.rest.patch.mock.calls[0]?.[1].body.embeds[0].description).toBe(
        'CURRENT_PUBLIC_STATUS',
      );
      expect(f.sink.followUps).toEqual([]);
    },
  );
  it('cancels only the live job in its public message and explains that saved writes remain', async () => {
    const f = fixture();
    controls.cancel.mockResolvedValue({
      ...job,
      status: 'cancelled',
      progress: { ...job.progress, state: 'cancelled' },
    });
    Object.assign(f.interaction, {
      customId: `archive_panel|${job.jobId}|cancel`,
      message: f.report,
    });
    await new ArchivePanel().execute(f.interaction as never, f.bot);
    expect(controls.cancel).toHaveBeenCalledWith(job.jobId);
    expect(f.sink.editReplies[0]?.content).toContain(
      translator.t('replies:archive.view_cancelled_writes'),
    );
    expect(f.rest.patch.mock.calls[0]?.[1].body.embeds[0].description).toBe(
      'CURRENT_PUBLIC_STATUS',
    );
    expect(f.sink.followUps).toEqual([]);
  });
  it.each(['terminal', 'superseded', 'copied-message', 'different-author'] as const)(
    'rejects a %s cancel button without cancelling or overwriting a successor',
    async (reason) => {
      const f = fixture();
      f.collection.mockReturnValue({
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
        findOne: vi.fn().mockResolvedValue({
          ...job,
          status: reason === 'terminal' ? 'complete' : 'running',
          notification: {
            channelId: DEBUG,
            messageId: f.report.id,
            ...(reason === 'superseded' ? { supersededAt: Date.now() } : {}),
          },
        }),
      });
      Object.assign(f.interaction, {
        customId: `archive_panel|${job.jobId}|cancel`,
        message: {
          ...f.report,
          ...(reason === 'copied-message' ? { id: '623456789012345678' } : {}),
          ...(reason === 'different-author' ? { author: { id: USER } } : {}),
        },
      });
      await new ArchivePanel().execute(f.interaction as never, f.bot);
      expect(controls.cancel).not.toHaveBeenCalled();
      expect(f.rest.patch).not.toHaveBeenCalled();
      expect(f.sink.editReplies).toEqual([]);
      expect(f.sink.followUps).toHaveLength(1);
    },
  );
  it.each([
    ['archive_panel|job', ArchivePanel],
    ['archive_view|run|c|a|-1|a', ArchiveView],
    ['archive_jobs|all|job', ArchiveJobs],
  ] as const)('checks access before reading storage on %s', async (customId, Handler) => {
    const f = fixture();
    Object.assign(f.interaction, { customId, message: f.report, channelId: 'other' });
    await new Handler().execute(f.interaction as never, f.bot);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(controls.manifest).not.toHaveBeenCalled();
    expect(controls.status).not.toHaveBeenCalled();
    expect(controls.jobs).not.toHaveBeenCalled();
  });
  it('refuses a recovered panel after the actor loses management permission', async () => {
    const f = fixture();
    Object.assign(f.interaction.guild!, { ownerId: 'someone-else' });
    Object.assign(f.interaction, {
      customId: `archive_panel|${job.jobId}`,
      message: f.report,
      memberPermissions: new PermissionsBitField(),
    });
    await new ArchivePanel().execute(f.interaction as never, f.bot);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(controls.status).not.toHaveBeenCalled();
    expect(f.rest.patch).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([]);
    expect(f.sink.followUps).toHaveLength(1);
  });
  it('refuses cross-guild durable IDs through the current guild-scoped control', async () => {
    const f = fixture();
    Object.assign(f.interaction, {
      customId: 'archive_panel|999999999999999999:foreign',
      message: f.report,
    });
    controls.status.mockRejectedValue(new Error('Unknown archive job for this guild'));
    await new ArchivePanel().execute(f.interaction as never, f.bot);
    expect(controls.construct).toHaveBeenCalledWith(
      expect.objectContaining({ collection: expect.any(Function) }),
      GUILD,
      expect.any(Object),
    );
    expect(f.sink.followUps[0]?.content).toContain('找不到指定');
    expect(f.rest.patch).not.toHaveBeenCalled();
    expect(controls.manifest).not.toHaveBeenCalled();
    expect(controls.requestConfirmation).not.toHaveBeenCalled();
  });
  it.each(['accepted', 'recovery-expired', 'rolled-back', 'complete', 'partial'])(
    'does not offer acceptance or guess a restart for ineligible %s state',
    async (status) => {
      const f = fixture('inspect', { run_id: 'run' });
      controls.manifest.mockResolvedValue({ ...manifest, run: { ...run, status, actions: [] } });
      await new Archive().execute(f.interaction, f.bot);
      expect(buttonIds(f).some((id) => id.startsWith('archive_confirm|'))).toBe(false);
      expect(controls.requestConfirmation).not.toHaveBeenCalled();
      expect(f.sink.editReplies[0]?.content).not.toContain('計畫有效至');
    },
  );
  it('fails visibly when whole-manifest statistics are unavailable instead of reporting no changes', async () => {
    const f = fixture('inspect', { run_id: 'run' });
    controls.manifest.mockResolvedValue({
      ...manifest,
      run: { ...run, actions: [] },
      summary: { status: 'unavailable', reason: 'timeout' },
    });
    await new Archive().execute(f.interaction, f.bot);
    expect(f.sink.editReplies[0]?.content).toContain('暫時無法取得');
    expect(f.sink.editReplies[0]?.content).not.toContain(
      translator.t('replies:archive.plan_no_issues'),
    );
    expect(f.sink.editReplies[0]?.content).not.toContain('預計調整：');
    expect(f.sink.editReplies[0]?.content).not.toContain('0 項');
    expect(buttonIds(f).some((id) => id.startsWith('archive_confirm|'))).toBe(false);
  });
  it('recovers jobs pagination without copying IDs', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: 'archive_jobs|all|previous', message: f.report });
    await new ArchiveJobs().execute(f.interaction as never, f.bot);
    expect(controls.jobs).toHaveBeenCalledWith({ all: true, before: 'previous', limit: 2 });
    expect(buttonIds(f)).toContain('archive_manage|jobs|cursor');
  });
  it('renders consumed confirmation replays using actual running status', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: `archive_confirm|${token}`, message: f.report });
    controls.confirm.mockResolvedValue({
      ...job,
      command: 'apply',
      status: 'running',
      progress: sanitizeArchiveProgress({ work: 'apply', state: 'running', phase: 'repair' }),
    });
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(f.sink.editReplies[0]?.content).not.toContain('尚未開始');
    expect(controls.requestConfirmation).not.toHaveBeenCalled();
  });
  it.each(['en', 'zh-TW'] as const)(
    'bounds long legacy IDs and job pagination in %s',
    async (locale) => {
      const f = fixture('jobs', { scope: 'all' });
      const localized = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      Object.assign(f.bot, { translator: localized });
      controls.jobs.mockResolvedValue({
        jobs: Array.from({ length: 10 }, (_, index) => ({
          ...job,
          jobId: `${index}${'x'.repeat(159)}`,
          command: 'refresh-attachment',
        })),
        nextCursor: 'older-jobs',
      });
      await new Archive().execute(f.interaction, f.bot);
      expect(f.sink.followUps).toHaveLength(0);
      expect(String(f.sink.editReplies[0]?.content).length).toBeLessThanOrEqual(1900);
      expect(buttonIds(f).every((id) => id.length <= 100)).toBe(true);
      const components = JSON.parse(JSON.stringify(f.sink.editReplies[0]?.components));
      const buttons = components.flatMap(
        (row: { components: { type: number; custom_id: string; label: string }[] }) =>
          row.components,
      );
      expect(buttons).toHaveLength(5);
      expect(buttons.every((button: { type: number }) => button.type === 2)).toBe(true);
      expect(
        buttons.slice(0, 2).every((button: { label: string }) => /^\d+\./.test(button.label)),
      ).toBe(true);
      const next = buttons.at(-1)!.custom_id.split('|')[2]!;
      expect(resolveArchiveReference(next)).toMatchObject({
        action: 'jobs',
        id: `1${'x'.repeat(159)}`,
      });
    },
  );
  it('requires explicit deletion confirmation and returns public cleanup counts', async () => {
    controls.purgeJobs.mockResolvedValue({ deleted: 4, running: 1 });
    const f = fixture('purge-jobs', { confirm: 'delete' });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.purgeJobs).toHaveBeenCalledOnce();
    expect(f.sink.editReplies[0]?.content).toContain('4');
    expect(f.sink.defers).toEqual([{}]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not purge without the required confirmation choice', async () => {
    const f = fixture('purge-jobs', { confirm: 'no' });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.purgeJobs).not.toHaveBeenCalled();
  });
  it.each(['audit', 'plan', 'verify'])(
    'updates the durable public card with the queued job for %s',
    async (action) => {
      const f = fixture(action, { run_id: 'run' });
      await new Archive().execute(f.interaction, f.bot);
      expect(f.sink.defers).toEqual([{}]);
      expect(controls.submit).toHaveBeenCalledWith(action, {
        runId: 'run',
        notification: { channelId: DEBUG, messageId: f.report.id },
      });
      expect(f.sink.editReplies[0]?.content).toContain('排隊中');
      expect(buttonIds(f)).toContain(`archive_panel|${job.jobId}`);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.deleteReply).toHaveBeenCalledOnce();
      expect(f.sink.followUps).toHaveLength(0);
    },
  );
  it('shows the current state when the worker starts before submission returns', async () => {
    controls.submit.mockResolvedValue({
      ...job,
      status: 'running',
      progress: { ...job.progress, state: 'running' },
    });
    const f = fixture('backup');
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.submit).toHaveBeenCalledWith('plan', {
      notification: { channelId: DEBUG },
    });
    expect(f.sink.editReplies[0]?.content).toContain('執行中');
    expect(f.sink.editReplies[0]?.content).not.toContain('尚未開始');
    expect(f.sink.defers).toEqual([{}]);
  });
  it('reports database rejection without creating a durable status notice', async () => {
    const f = fixture();
    controls.submit.mockRejectedValue(new Error('db'));
    await new Archive().execute(f.interaction, f.bot);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.report.delete).not.toHaveBeenCalled();
    expect(f.sink.editReplies[0]?.content).toContain('封存操作失敗');
  });
  it.each(['apply', 'resume', 'accept', 'rollback'])(
    'requests a bound durable confirmation for %s without enqueueing',
    async (action) => {
      const f = fixture(action, { run_id: 'run' });
      await new Archive().execute(f.interaction, f.bot);
      expect(controls.requestConfirmation).toHaveBeenCalledWith(action, 'run', {
        userId: USER,
        channelId: DEBUG,
      });
      expect(controls.submit).not.toHaveBeenCalled();
      const payload = f.sink.editReplies[0]!;
      const confirmation = await controls.requestConfirmation.mock.results[0]!.value;
      expect(payload.content).toContain(
        translator.t('replies:archive.confirm_bound', {
          expires: `<t:${Math.floor(confirmation.expiresAt / 1000)}:R>`,
        }),
      );
      expect(
        (payload.components![0] as { toJSON(): { components: { custom_id: string }[] } }).toJSON()
          .components[0]!.custom_id,
      ).toBe(`archive_confirm|${token}`);
    },
  );
  it('derives attachment access from the real actor and publishes metadata only', async () => {
    const f = fixture('refresh-attachment', {
      message_id: '723456789012345678',
      attachment_id: '823456789012345678',
    });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.submit).toHaveBeenCalledWith(
      'refresh-attachment',
      expect.objectContaining({
        userId: USER,
        channelId: '623456789012345678',
        messageId: '723456789012345678',
        attachmentId: '823456789012345678',
      }),
    );
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('https://');
  });
  it.each(['status', 'cancel'])('routes %s by guild-scoped job ID', async (action) => {
    const f = fixture(action, { job_id: 'job' });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls[action as 'status' | 'cancel']).toHaveBeenCalledWith('job');
    expect(f.sink.editReplies[0]?.content).toContain('排隊中');
  });
  it('renders a bounded public detail page without unverified historical source names', async () => {
    const progress = sanitizeArchiveProgress({
      phase: 'history',
      state: 'running',
      work: 'periodic',
      jobId: job.jobId,
      messages: { scanned: 42, admitted: 30, durable: 28 },
      activityCount: 12,
      gapCount: 7,
    })!;
    controls.status.mockResolvedValue({ ...job, progress });
    controls.progressDetails.mockResolvedValue({
      activities: [
        { sourceId: 'channel-2', name: '@everyone **source**', step: 'writing', scanned: 12 },
      ],
      gaps: [{ sourceId: 'channel-3', name: 'missing source', reason: 'permission' }],
      page: 2,
      hasNext: true,
    });
    const f = fixture('status', { job_id: 'job', page: 2 });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.progressDetails).toHaveBeenCalledWith(job.jobId, 2, 1);
    const text = f.sink.editReplies.map(({ content }) => String(content)).join('');
    expect(text).toContain('42');
    expect(text).not.toContain('符合政策 30');
    expect(text).not.toContain('已確認寫入 28');
    expect(text).not.toContain('missing source');
    expect(text.replace(/\\/g, '')).toContain('channel-3');
    expect(text).toContain('詳細資料第 2 頁；下一頁：3');
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('"messages"');
    expect(f.sink.defers).toEqual([{}]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('shows aggregate progress without loading detail rows when page is omitted', async () => {
    controls.status.mockResolvedValue({
      ...job,
      progress: sanitizeArchiveProgress({
        phase: 'repair',
        state: 'queued',
        work: 'audit',
        jobId: job.jobId,
      }),
    });
    const f = fixture('status', { job_id: 'job' });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.progressDetails).not.toHaveBeenCalled();
    expect(f.sink.editReplies[0]?.content).toContain('排隊中');
    expect(f.sink.editReplies[0]?.content).not.toContain('```');
  });
  it('renders finished checkpoint details without reviving terminal estimates', async () => {
    controls.status.mockResolvedValue({
      ...job,
      status: 'complete',
      progress: sanitizeArchiveProgress({
        phase: 'history',
        state: 'complete',
        work: 'periodic',
        jobId: job.jobId,
      }),
    });
    controls.progressDetails.mockResolvedValue({
      activities: [
        {
          sourceId: 'channel-1',
          name: 'completed source',
          step: 'checkpoint',
          scanned: 20,
          cursor: '723456789012345678',
        },
      ],
      gaps: [],
      page: 1,
      hasNext: false,
    });
    const f = fixture('status', { job_id: 'job', page: 1 });
    await new Archive().execute(f.interaction, f.bot);
    const text = f.sink.editReplies.map(({ content }) => String(content)).join('');
    expect(text).not.toContain('completed source');
    expect(text.replace(/\\/g, '')).toContain('channel-1');
    expect(text).not.toContain('723456789012345678');
    expect(text).not.toContain(job.jobId);
    expect(text).not.toContain('預估剩餘');
    expect(text).toContain('詳細資料第 1 頁');
  });
  it.each(['en', 'zh-TW'] as const)(
    'keeps long %s detail reports bounded while preserving sources and pagination',
    async (locale) => {
      const id = 'x'.repeat(160);
      const progress = sanitizeArchiveProgress({
        work: 'periodic',
        phase: 'history',
        state: 'running',
        jobId: id,
        scanId: `s${id.slice(1)}`,
        runId: `r${id.slice(1)}`,
        activityCount: 30,
        gapCount: 20,
        messages: {
          scanned: Number.MAX_SAFE_INTEGER,
          admitted: Number.MAX_SAFE_INTEGER,
          durable: 1,
        },
        live: { pending: Number.MAX_SAFE_INTEGER, oldestAgeMs: 100_000, windowMs: 60_000 },
      })!;
      controls.status.mockResolvedValue({ ...job, jobId: id, progress });
      controls.progressDetails.mockResolvedValue({
        activities: Array.from({ length: 3 }, (_, i) => ({
          sourceId: `source-${i}`,
          name: '*@'.repeat(50),
          step: 'checkpoint',
          scanned: Number.MAX_SAFE_INTEGER,
          cursor: '723456789012345678',
        })),
        gaps: Array.from({ length: 3 }, (_, i) => ({
          sourceId: `gap-${i}`,
          name: '*@'.repeat(50),
          reason: 'permission',
        })),
        page: 12,
        hasNext: true,
      });
      const f = fixture('status', { job_id: 'job', page: 12 });
      const localized = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: locale,
      });
      Object.assign(f.bot, { translator: localized });
      await new Archive().execute(f.interaction, f.bot);
      const text = [...f.sink.editReplies, ...f.sink.followUps]
        .map(({ content }) => String(content))
        .join('');
      expect(text.length).toBeLessThanOrEqual(1900);
      expect(controls.progressDetails).toHaveBeenCalledWith(id, 12, 1);
      expect(text).not.toContain(id);
      expect(text).not.toContain(`s${id.slice(1)}`);
      expect(text).not.toContain(`r${id.slice(1)}`);
      expect(text).not.toContain('723456789012345678');
      expect(text).toContain('9,007,199,254,740,991');
      const unescaped = text.replace(/\\/g, '');
      for (const sourceId of ['source-0', 'source-1', 'source-2', 'gap-0', 'gap-1', 'gap-2'])
        expect(unescaped).toContain(sourceId);
      expect(text).toContain(localized.t('replies:archive.view_detail_gap_permission'));
      expect(text).toContain(
        localized.t('replies:archive.progress_page_next', { page: 12, nextPage: 13 }),
      );
      expect(text).not.toContain('@everyone');
    },
  );
  it.each([0, -1, 1.5, 100_001, Number.NaN])(
    'rejects invalid detail page %s without reading the job',
    async (page) => {
      const f = fixture('status', { job_id: 'job', page });
      await new Archive().execute(f.interaction, f.bot);
      expect(controls.status).not.toHaveBeenCalled();
      expect(controls.progressDetails).not.toHaveBeenCalled();
    },
  );
  it('opens the plan list without requiring a copied run ID', async () => {
    controls.plans.mockResolvedValue({ plans: [{ ...run, deletable: true }] });
    const f = fixture('plans');
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.plans).toHaveBeenCalledWith({ limit: 2 });
    expect(buttonIds(f)).toContain('archive_manage|plan|run');
    expect(controls.submit).not.toHaveBeenCalled();
  });
  it('lists all jobs with pagination', async () => {
    const f = fixture('jobs');
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.jobs).toHaveBeenCalledWith({ all: true, limit: 2 });
    expect(buttonIds(f)).toContain('archive_manage|jobs|cursor');
  });
  it('keeps legacy technical pages bounded without JSON download', async () => {
    const f = fixture('inspect', {
      run_id: 'run',
      view: 'technical',
      after_sequence: 4,
      limit: 25,
    });
    controls.manifest.mockResolvedValue({
      ...manifest,
      run: { ...run, operations: 25 },
      operations: Array.from({ length: 5 }, (_, index) => ({
        sequence: index + 5,
        operationId: `operation-${index}`,
        documentId: '723456789012345678',
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        dependencies: ['dependency'],
      })),
      nextSequence: 29,
    });
    await new Archive().execute(f.interaction, f.bot);
    expect(controls.manifest).toHaveBeenCalledWith('run', { afterSequence: 4, limit: 5 });
    const pages = [...f.sink.editReplies, ...f.sink.followUps];
    expect(pages.every((payload) => String(payload.content).length <= 1900)).toBe(true);
    expect(f.sink.followUps).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
    const text = pages.map((payload) => payload.content).join('');
    expect(text).not.toContain('beforeHash');
    expect(text).not.toContain('afterHash');
    expect(text).not.toContain('dependencies');
    expect(text).not.toContain('安全 JSON');
    expect(pages[0]).not.toHaveProperty('files');
  });
  it('rejects another channel before opening storage', async () => {
    const f = fixture();
    Object.assign(f.interaction, { channelId: 'other' });
    await new Archive().execute(f.interaction, f.bot);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(f.sink.editReplies[0]?.content).toContain('debug 頻道');
  });
  it.each([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])(
    'fails closed on a missing bot permission %s',
    async (missing) => {
      const f = fixture();
      Object.assign(f.channel, {
        permissionsFor: () => ({ has: (bit: bigint) => bit !== missing }),
      });
      await new Archive().execute(f.interaction, f.bot);
      expect(f.getConnection).not.toHaveBeenCalled();
      expect(controls.submit).not.toHaveBeenCalled();
    },
  );
  it('uses buttons without exposing an unused autocomplete hook', () => {
    expect(new Archive().autocomplete).toBeUndefined();
  });
  it('keeps the successor job in the original public confirmation card', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: `archive_confirm|${token}`, message: f.report });
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(controls.validateConfirmation.mock.invocationCallOrder[0]).toBeLessThan(
      controls.confirm.mock.invocationCallOrder[0]!,
    );
    expect(controls.confirm).toHaveBeenCalledWith(
      token,
      { userId: USER, channelId: DEBUG },
      { channelId: DEBUG, messageId: f.report.id },
    );
    expect(
      (f.interaction as unknown as { deferUpdate: ReturnType<typeof vi.fn> }).deferUpdate,
    ).toHaveBeenCalledOnce();
    expect(f.sink.editReplies[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('排隊中'),
        components: expect.any(Array),
      }),
    );
    expect(buttonIds(f)).toContain(`archive_panel|${job.jobId}`);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.deleteReply).not.toHaveBeenCalled();
    expect(f.report.edit).not.toHaveBeenCalled();
  });
  it('rejects a wrong actor without consuming the confirmation', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: `archive_confirm|${token}`, message: f.report });
    controls.validateConfirmation.mockRejectedValue(new Error('actor mismatch'));
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(controls.confirm).not.toHaveBeenCalled();
    expect(f.sink.followUps[0]?.content).toContain('封存操作失敗');
    expect(f.rest.patch).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([]);
  });
  it('confirms inside a list panel while the successor keeps the original worker notice', async () => {
    const f = fixture();
    const previous = f.collection.getMockImplementation()!;
    f.collection.mockImplementation((name: string) =>
      name === 'archive_control_confirmations'
        ? {
            updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
            findOne: vi.fn().mockResolvedValue({
              _id: token,
              runId: 'run',
              publicMessage: { channelId: DEBUG, messageId: 'list-panel' },
            }),
          }
        : previous(name),
    );
    Object.assign(f.interaction, {
      customId: `archive_confirm|${token}`,
      message: { ...f.report, id: 'list-panel' },
    });
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(controls.confirm).toHaveBeenCalledWith(
      token,
      { userId: USER, channelId: DEBUG },
      { channelId: DEBUG, messageId: f.report.id },
    );
    expect(f.rest.patch.mock.calls[0]?.[0]).toBe(`/channels/${DEBUG}/messages/list-panel`);
    expect(f.sink.followUps).toEqual([]);
  });
  it('rejects a copied confirmation before redirecting the successor to another message', async () => {
    const f = fixture();
    Object.assign(f.interaction, {
      customId: `archive_confirm|${token}`,
      message: { ...f.report, id: '623456789012345678' },
    });
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(controls.validateConfirmation).toHaveBeenCalledOnce();
    expect(controls.confirm).not.toHaveBeenCalled();
    expect(f.rest.patch).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([]);
    expect(f.sink.followUps[0]?.content).toContain('確認已失效');
  });
  it('reports backend rejection privately without deleting the reply', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: `archive_confirm|${token}`, message: f.report });
    controls.confirm.mockRejectedValue(new Error('stale plan'));
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(f.sink.followUps[0]?.content).toContain('封存操作失敗');
    expect(f.deleteReply).not.toHaveBeenCalled();
  });
  it('rejects an invalid confirmation token before accessing storage', async () => {
    const f = fixture();
    Object.assign(f.interaction, { customId: 'archive_confirm|old', message: f.report });
    await new ArchiveConfirm().execute(f.interaction as never, f.bot);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(f.sink.followUps[0]?.content).toContain('確認已失效');
  });
  it.each([
    ['Unknown archive confirmation for this actor', '只有原始操作人'],
    ['Archive confirmation expired', '確認已失效'],
    ['Repair manifest changed; request confirmation again', '修復計畫已變更'],
    ['Repair settings changed; produce a new manifest', '封存設定已變更'],
    ['Unknown archive job for this guild', '找不到指定'],
    ['Repair run is not eligible for this action', '目前狀態'],
  ])('localizes safe backend refusal %s without echoing raw text', async (error, expected) => {
    const f = fixture('status', { job_id: 'job' });
    controls.status.mockRejectedValue(new Error(error));
    await new Archive().execute(f.interaction, f.bot);
    expect(f.sink.editReplies[0]?.content).toContain(expected);
    expect(f.sink.editReplies[0]?.content).not.toContain(error);
  });
});
