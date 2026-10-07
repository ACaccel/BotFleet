import path from 'node:path';
import type * as ArchivePublicReplyModule from '../../../../src/handlers/commands/archive/public-reply';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionsBitField, type InteractionReplyOptions } from 'discord.js';
import ArchiveBrowse from '../../../../src/handlers/buttons/archive_browse';
import ArchiveCategory from '../../../../src/handlers/select-menus/archive_category';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { ArchiveOperationSummary } from '../../../../src/core/archive/manifest-target';
import type * as ArchiveAccessModule from '../../../../src/handlers/commands/archive/access';
import type { ArchiveControlService } from '../../../../src/infra/archive/control';
import {
  archiveManifestReply,
  archiveConfirmationReply,
} from '../../../../src/handlers/commands/archive/presentation';
import {
  archiveNavigationId,
  resolveArchiveNavigation,
} from '../../../../src/handlers/commands/archive/navigation';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const access = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock('../../../../src/handlers/commands/archive/access', async (importOriginal) => {
  const actual = await importOriginal<typeof ArchiveAccessModule>();
  return { ...actual, requireArchiveAccess: access.require };
});
vi.mock('../../../../src/handlers/commands/archive/public-reply', async (importOriginal) => ({
  ...(await importOriginal<typeof ArchivePublicReplyModule>()),
  archivePublicReference: vi
    .fn()
    .mockResolvedValue({ channelId: '456', messageId: 'public-status' }),
  ensureArchivePublicReference: vi
    .fn()
    .mockResolvedValue({ channelId: '456', messageId: 'public-status' }),
}));
type Manifest = Awaited<ReturnType<ArchiveControlService['manifest']>>;
const actor = { userId: '123', channelId: '456', guildId: '789' };
const runId = 'r'.repeat(160);
let translator: Translator;
beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
    fallbackLocale: 'zh-TW',
  });
});
beforeEach(() => vi.clearAllMocks());
const operation = (
  sequence = 0,
  overrides: Partial<ArchiveOperationSummary> = {},
): ArchiveOperationSummary => ({
  operationId: `operation-${sequence}`,
  documentId: '000000000000000000000001',
  sequence,
  collection: 'fetches',
  state: 'planned',
  reason: 'reset-cursor-for-full-reconciliation',
  category: 'reset-progress',
  impact: 'update',
  target: { identity: 'known', channelId: '123456789012345678', historicalName: 'recorded source' },
  changes: [
    {
      field: 'lastMessageId',
      before: { state: 'value', value: '223456789012345678' },
      after: { state: 'unset' },
    },
  ],
  dependencies: [],
  beforeHash: 'a'.repeat(64),
  afterHash: 'b'.repeat(64),
  ...overrides,
});
const report = (
  total = 10,
  operations = Array.from({ length: 5 }, (_, index) => operation(index)),
): Manifest => ({
  run: {
    deletable: false,
    runId,
    guildId: actor.guildId,
    status: 'planned',
    createdAt: 1700000000000,
    cutoff: 1700000000000,
    operations: total,
    unresolved: 0,
    journalBytes: 30,
    issueCount: 0,
    issueCategories: [],
    actions: [],
    scope: { policy: 'unavailable', historyDiscovery: 'pending' },
  },
  summary: {
    status: 'available',
    totalOperations: total,
    categories: [
      {
        category: 'reset-progress',
        operations: total,
        insertOperations: 0,
        updateOperations: total,
        deleteOperations: 0,
        unknownImpactOperations: 0,
      },
    ],
    impacts: {
      insertOperations: 0,
      updateOperations: total,
      deleteOperations: 0,
      unknownImpactOperations: 0,
    },
    targets: { distinctSources: 3, unknownSourceOperations: 0 },
    recordTypes: [
      {
        collection: 'fetches',
        operations: total,
        insertOperations: 0,
        updateOperations: total,
        deleteOperations: 0,
        unknownImpactOperations: 0,
      },
    ],
  },
  operations,
  nextSequence: operations.at(-1)?.sequence ?? -1,
  hasNext: total > operations.length,
  hasPrevious: false,
});
const componentData = (
  reply: InteractionReplyOptions,
): { custom_id: string; label?: string; options?: { label: string; value: string }[] }[] =>
  (
    JSON.parse(JSON.stringify(reply.components)) as {
      components: {
        custom_id: string;
        label?: string;
        options?: { label: string; value: string }[];
      }[];
    }[]
  ).flatMap((row) => row.components);
const setup = (manifest = report()) => {
  const forum = buildTextChannel({ id: '100', name: 'forum', type: ChannelType.GuildForum });
  const thread = buildTextChannel({
    id: '123456789012345678',
    name: '[link](https://example.test) ``` @everyone',
    type: ChannelType.PublicThread,
    parentId: forum.id,
  });
  Object.assign(thread, { parent: forum });
  const sameName = buildTextChannel({ id: '124456789012345678', name: thread.name });
  const guild = buildGuild({ id: actor.guildId, channels: [forum, thread, sameName] });
  const fetch = vi.fn();
  Object.assign(guild.channels, { fetch });
  const { bot } = buildFakeBot({
    translator,
    client: { guilds: { cache: new Map([[actor.guildId, guild]]) } },
  });
  Object.assign(guild, { client: bot.client });
  for (const channel of guild.channels.cache.values())
    Object.assign(channel, { permissionOverwrites: { cache: new Map() } });
  const controls = {
    manifest: vi.fn().mockResolvedValue(manifest),
    manifestGroups: vi.fn().mockResolvedValue({
      status: 'available',
      totalOperations: 11,
      groups: [
        {
          key: 'fetches|reset-cursor-for-full-reconciliation|update',
          reason: 'reset-cursor-for-full-reconciliation',
          collection: 'fetches',
          impact: 'update',
          category: 'reset-progress',
          operations: 11,
          sourceCount: 3,
          unknownSourceOperations: 1,
          examples: [operation().target],
          states: { planned: 9, verified: 1, conflict: 1 },
        },
      ],
      hasNext: false,
      hasPrevious: false,
    }),
    manifestSources: vi.fn().mockResolvedValue({
      status: 'available',
      totalOperations: 11,
      sources: [
        {
          sourceId: '123456789012345678',
          target: operation().target,
          operations: 6,
          states: { planned: 6 },
        },
        {
          sourceId: '124456789012345678',
          target: { identity: 'known', channelId: '124456789012345678' },
          operations: 5,
          states: { planned: 5 },
        },
      ],
      hasNext: false,
      hasPrevious: false,
    }),
    operation: vi.fn().mockResolvedValue({ run: manifest.run, operation: operation() }),
    requestConfirmation: vi.fn(),
  };
  const control = controls as unknown as ArchiveControlService;
  access.require.mockResolvedValue({ control, guildId: actor.guildId, debugId: actor.channelId });
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    guild,
    userId: actor.userId,
    channel: { id: actor.channelId },
    sink,
  });
  Object.assign(bot.client, {
    rest: {
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
      patch: vi.fn().mockImplementation(async (_route, { body, files }) => {
        sink.editReplies.push({
          content: body.embeds?.at(-1)?.description,
          components: body.components,
          allowedMentions: body.allowed_mentions,
          files: files?.map((file: { data: Buffer }) => ({ attachment: file.data })),
        } as never);
      }),
    },
  });
  const deferUpdate = vi.fn().mockImplementation(async () => {
    sink.acknowledged.deferred = true;
  });
  Object.assign(interaction, {
    deferUpdate,
    message: { id: 'public-status', flags: { has: () => false } },
  });
  return { bot, control, controls, guild, fetch, interaction, sink, deferUpdate };
};
describe('archive information pages', () => {
  const expectCompact = (reply: InteractionReplyOptions): void => {
    const controls = componentData(reply);
    expect(String(reply.content).length).toBeLessThanOrEqual(1900);
    expect(
      controls.filter((component) => component.label !== undefined).length,
    ).toBeLessThanOrEqual(3);
    expect(new Set(controls.map((component) => component.custom_id)).size).toBe(controls.length);
    expect(controls.every((component) => component.custom_id.length <= 100)).toBe(true);
    expect(controls.filter((component) => component.options !== undefined)).toEqual([]);
    expect(String(reply.content)).not.toMatch(
      /beforeHash|afterHash|journalBytes|operation-\d|rrrrrrrr/,
    );
    expect(reply.files).toBeUndefined();
    for (const component of controls) {
      const page = resolveArchiveNavigation(component.custom_id, actor).page;
      expect(['summary', 'changes']).toContain(page.view);
      expect(page.sequence).toBeUndefined();
      expect(page.returnTo).toBeUndefined();
    }
  };

  it.each([10, 11])('uses one change view with grouping only above ten (%i)', async (total) => {
    const f = setup(report(total));
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(reply);
    expect(f.controls.manifest).toHaveBeenCalledWith(runId, { limit: 5 });
    expect(String(reply.content)).toContain('123456789012345678');
    expect(String(reply.content)).toContain('不刪除已備份訊息');
    if (total === 10) {
      expect(f.controls.manifestGroups).not.toHaveBeenCalled();
    } else {
      expect(f.controls.manifestGroups).toHaveBeenCalledWith(runId, { limit: 5 });
      expect(String(reply.content)).toContain('衝突');
      expect(String(reply.content)).toContain('另有 2 個來源');
      expect(String(reply.content)).toContain('1 筆操作的來源無法辨識');
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('retains escaped source names and IDs without category or operation controls', async () => {
    const f = setup();
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(reply);
    expect(String(reply.content)).toContain('論壇貼文');
    expect(String(reply.content)).toContain('123456789012345678');
    expect(String(reply.content)).toContain('\\[link\\]');
    expect(String(reply.content)).not.toContain('```');
  });

  it('pages grouped changes directly and returns to the next action', async () => {
    const f = setup(report(11));
    f.controls.manifestGroups.mockResolvedValue({
      ...(await f.controls.manifestGroups()),
      hasNext: true,
      hasPrevious: true,
    });
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(reply);
    const buttons = componentData(reply);
    expect(buttons).toHaveLength(3);
    const next = buttons.find((component) => component.label === '下一頁')!;
    const previous = buttons.find((component) => component.label === '上一頁')!;
    const back = buttons.find(
      (component) => resolveArchiveNavigation(component.custom_id, actor).page.view === 'summary',
    )!;
    expect(resolveArchiveNavigation(next.custom_id, actor).page).toMatchObject({
      view: 'changes',
      afterGroup: 'fetches|reset-cursor-for-full-reconciliation|update',
    });
    expect(resolveArchiveNavigation(previous.custom_id, actor).page).toMatchObject({
      view: 'changes',
      beforeGroup: 'fetches|reset-cursor-for-full-reconciliation|update',
    });
    expect(resolveArchiveNavigation(back.custom_id, actor).page).toEqual({ view: 'summary' });
    Object.assign(f.interaction, { customId: next.custom_id });
    await new ArchiveBrowse().execute(f.interaction as never, f.bot);
    expect(f.controls.manifestGroups).toHaveBeenLastCalledWith(runId, {
      limit: 5,
      afterGroup: 'fetches|reset-cursor-for-full-reconciliation|update',
    });
    expect(f.sink.editReplies).toHaveLength(1);
    expect(f.sink.followUps).toEqual([]);
  });

  it('keeps distinct source IDs and unknown impact visible', async () => {
    const f = setup(
      report(2, [
        operation(0),
        operation(1, { target: { identity: 'known', channelId: '124456789012345678' } }),
      ]),
    );
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(reply);
    expect(String(reply.content)).toContain('123456789012345678');
    expect(String(reply.content)).toContain('124456789012345678');
    f.controls.manifest.mockResolvedValue(
      report(1, [
        operation(0, {
          target: { identity: 'unknown' },
          collection: 'messages',
          category: 'unknown',
          impact: 'unknown',
          state: 'conflict',
        }),
      ]),
    );
    const unknown = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(unknown);
    expect(String(unknown.content)).toContain('未知');
    expect(String(unknown.content)).toContain('衝突');
    expect(String(unknown.content)).not.toContain('重設這個頻道');
  });

  it.each(['technical', 'download', 'operation', 'sources'] as const)(
    'reopens legacy %s links as bounded changes without technical exports',
    async (view) => {
      const f = setup();
      const reply = await archiveManifestReply(runId, f.bot, f.control, actor, {
        view,
        sequence: 0,
        returnTo: { view: 'technical' },
      });
      expectCompact(reply);
      expect(String(reply.content)).not.toMatch(/JSON|operation-0|000000000000000000000001/);
      expect(f.controls.operation).not.toHaveBeenCalled();
      expect(f.controls.manifestSources).not.toHaveBeenCalled();
    },
  );

  it('shows unavailable whole-scope statistics without claiming no matching changes', async () => {
    const f = setup(report(11));
    f.controls.manifestGroups.mockResolvedValue({
      status: 'unavailable',
      reason: 'timeout',
      groups: [],
      hasNext: false,
      hasPrevious: false,
    });
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'changes' });
    expectCompact(reply);
    expect(String(reply.content)).toContain('暫時無法取得');
    expect(String(reply.content)).not.toContain('0 筆');
  });

  it('keeps scope, destructive record types, actor, and expiry before starting', () => {
    const f = setup();
    const manifest = report();
    manifest.run.scope = { policy: 'unavailable', historyDiscovery: 'complete' };
    if (manifest.summary.status === 'available')
      manifest.summary.recordTypes = [
        {
          collection: 'archive_reactions',
          operations: 4,
          deleteOperations: 4,
          insertOperations: 0,
          updateOperations: 0,
          unknownImpactOperations: 0,
        },
      ];
    const reply = archiveConfirmationReply(
      {
        token: 'abcdefghijklmnopqrstuvwx',
        action: 'apply',
        run: manifest.run,
        summary: manifest.summary,
        expiresAt: 1700000500000,
      },
      f.bot,
      actor,
    );
    expect(String(reply.content)).toContain('反應紀錄：刪除 4');
    expect(String(reply.content)).toContain('探索已完成');
    expect(String(reply.content)).toContain('<@123>');
    expect(String(reply.content)).toContain('<t:1700000500:R>');
    expect(String(reply.content)).not.toContain(runId);
    expect(
      componentData(reply).filter((component) => component.label !== undefined).length,
    ).toBeLessThanOrEqual(3);
    expect(
      componentData(reply).find((component) => component.custom_id.startsWith('archive_confirm|')),
    ).toBeDefined();
  });

  it.each([
    ['planned', 'apply'],
    ['partial', 'resume'],
    ['complete', 'accept'],
  ] as const)('offers the eligible next action for %s', async (status, action) => {
    const manifest = report();
    manifest.run.status = status;
    manifest.run.actions = [action];
    const f = setup(manifest);
    f.controls.requestConfirmation.mockResolvedValue({
      token: 'abcdefghijklmnopqrstuvwx',
      action,
      run: manifest.run,
      summary: manifest.summary,
      expiresAt: 1700000500000,
    });
    const reply = await archiveManifestReply(runId, f.bot, f.control, actor, { view: 'summary' });
    expect(f.controls.requestConfirmation).toHaveBeenCalledWith(action, runId, actor);
    const buttons = componentData(reply).filter((component) => component.label !== undefined);
    expect(buttons.length).toBeLessThanOrEqual(3);
    expect(
      buttons.find((component) => component.custom_id.startsWith('archive_confirm|'))?.label,
    ).toBe(translator.t(`replies:archive.confirm_action_${action}`));
    expect(buttons.find((component) => component.label === '查看詳情')).toBeDefined();
    expect(String(reply.content)).toContain('<@123>');
    expect(String(reply.content)).toContain('<t:1700000500:R>');
    expect(String(reply.content)).not.toContain(runId);
  });

  it('describes rollback candidates and retains observed edit versions', () => {
    const f = setup();
    const manifest = report();
    manifest.run.status = 'complete';
    if (manifest.summary.status === 'available')
      manifest.summary.recordTypes = [
        {
          collection: 'archive_revisions',
          operations: 3,
          insertOperations: 3,
          updateOperations: 0,
          deleteOperations: 0,
          unknownImpactOperations: 0,
        },
      ];
    const reply = archiveConfirmationReply(
      {
        token: 'abcdefghijklmnopqrstuvwx',
        action: 'rollback',
        run: manifest.run,
        summary: manifest.summary,
        expiresAt: 1700000500000,
      },
      f.bot,
      actor,
    );
    expect(String(reply.content)).toContain('歷史候選範圍');
    expect(String(reply.content)).toContain('保留 3 筆已觀察到的編輯版本');
    expect(String(reply.content)).toContain('尚未取得目前可復原筆數');
    expect(String(reply.content)).not.toContain('移除原本新增的 3');
  });
  it('denies AttachFiles only on the explicit download route', async () => {
    const f = setup();
    Object.assign(f.interaction, {
      customId: archiveNavigationId(runId, actor, { view: 'download' }),
      appPermissions: new PermissionsBitField(),
    });
    await new ArchiveBrowse().execute(f.interaction as never, f.bot);
    expect(String(f.sink.followUps[0]?.content)).toContain('附加檔案');
    expect(f.controls.manifest).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([]);
    expect(f.sink.followUps).toHaveLength(1);
  });
  it('changes category in the original private panel and resets old cursors', async () => {
    const f = setup();
    Object.assign(f.interaction, {
      customId: archiveNavigationId(
        runId,
        actor,
        { view: 'changes', afterSequence: 20 },
        'category',
      ),
      values: ['reset-progress'],
    });
    await new ArchiveCategory().execute(f.interaction as never, f.bot);
    expect(f.controls.manifest).toHaveBeenCalledWith(runId, {
      category: 'reset-progress',
      limit: 5,
    });
    expect(f.sink.editReplies).toHaveLength(1);
    expect(f.sink.followUps).toEqual([]);
  });
  it.each(['unrecognized', 'wrong-actor'])(
    'rejects invalid category navigation (%s) before inspecting data',
    async (kind) => {
      const f = setup();
      Object.assign(f.interaction, {
        customId: archiveNavigationId(
          runId,
          kind === 'wrong-actor' ? { ...actor, userId: '999' } : actor,
          { view: 'changes' },
          'category',
        ),
        values: [kind],
      });
      await new ArchiveCategory().execute(f.interaction as never, f.bot);
      expect(f.controls.manifest).not.toHaveBeenCalled();
      expect(f.sink.editReplies).toEqual([]);
      expect(f.sink.followUps).toHaveLength(1);
    },
  );
  it('rejects public navigation after permissions change without editing shared progress', async () => {
    const f = setup();
    Object.assign(f.interaction, {
      customId: archiveNavigationId(runId, actor, { view: 'changes' }),
      message: { flags: { has: () => false } },
    });
    access.require.mockRejectedValue(new Error('denied'));
    await new ArchiveBrowse().execute(f.interaction as never, f.bot);
    expect(f.sink.defers).toEqual([]);
    expect(f.controls.manifest).not.toHaveBeenCalled();
    expect(f.sink.editReplies).toEqual([]);
    expect(f.sink.followUps).toHaveLength(1);
  });
});
