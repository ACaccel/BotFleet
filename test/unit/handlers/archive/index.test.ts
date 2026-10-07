import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import path from 'node:path';
import type * as ArchivePublicReplyModule from '../../../../src/handlers/commands/archive/public-reply';

import Archive from '../../../../src/handlers/commands/archive';
import { publishArchiveReply } from '../../../../src/handlers/commands/archive/replies';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { sanitizeArchiveProgress } from '../../../../src/core/archive/progress';
import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildTextChannel } from '../../../fixtures/discord/channel-builder';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const scheduleMocks = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  construct: vi.fn(),
  periodicStatus: vi.fn(),
  progressDetails: vi.fn(),
}));
vi.mock('../../../../src/infra/archive/control', () => ({
  ArchiveControlService: class {
    periodicStatus = scheduleMocks.periodicStatus;
    progressDetails = scheduleMocks.progressDetails;
  },
}));
vi.mock('../../../../src/infra/archive/schedule', () => ({
  ArchiveScheduleStore: class {
    constructor(connection: unknown, defaultIntervalMs: number) {
      scheduleMocks.construct(connection, defaultIntervalMs);
    }
    read = scheduleMocks.read;
    update = scheduleMocks.update;
  },
}));

vi.mock('../../../../src/handlers/commands/archive/public-reply', async (importOriginal) => ({
  ...(await importOriginal<typeof ArchivePublicReplyModule>()),
  ensureArchivePublicReference: vi
    .fn()
    .mockResolvedValue({ channelId: 'c-1', messageId: 'public-status' }),
}));
const GUILD_ID = '123456789012345678';
const USER_ID = 'member';
const state = {
  enabled: false,
  intervalMs: 3_600_000,
  nextRunAt: null,
  running: false,
};

const build = (
  fixture: {
    action?: string;
    group?: string;
    minutes?: number;
    page?: number;
    owner?: boolean;
    manageGuild?: boolean;
    guildId?: string | null;
    backupServers?: string[];
    intervalMinutes?: number;
    worker?: boolean;
    missingManager?: boolean;
  } = {},
) => {
  const sink = newInteractionSink();
  const channel = Object.assign(buildTextChannel({ id: 'c-1' }), {
    send: vi.fn(),
  });
  const guild = Object.assign(
    buildGuild({ id: fixture.guildId ?? GUILD_ID, channels: [channel], me: { id: 'bot' } }),
    {
      ownerId: fixture.owner === false ? 'someone-else' : USER_ID,
    },
  );
  const interaction = buildChatInputInteraction({
    commandName: 'archive',
    ...(fixture.guildId === null ? { guildId: null } : { guild }),
    userId: USER_ID,
    options: {
      ...(fixture.minutes === undefined ? {} : { minutes: fixture.minutes }),
      ...(fixture.page === undefined ? {} : { page: fixture.page }),
    },
    sink,
  });
  Object.assign(interaction.options, {
    getSubcommandGroup: () => fixture.group ?? 'schedule',
    getSubcommand: () => fixture.action ?? 'status',
  });
  Object.assign(interaction, {
    deleteReply: vi.fn(),
    memberPermissions: new PermissionsBitField(
      fixture.manageGuild === true ? [PermissionFlagsBits.ManageGuild] : [],
    ),
  });
  const connection = { name: 'archive-db', db: {} };
  const getConnection = vi.fn().mockResolvedValue({
    connection,
    archiveOwner: fixture.worker === false ? undefined : 'msg-archive',
  });
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
        content: body.embeds?.[1]?.description,
        components: body.components,
      } as never);
    }),
  };
  const { bot, logger } = buildFakeBot({
    client: { rest },
    translator: echoTranslatorWithParams(),
    config: {
      backup_server: fixture.backupServers ?? [GUILD_ID],
      guilds: { [GUILD_ID]: { channels: { debug: 'c-1' } } },
      ...(fixture.intervalMinutes !== undefined
        ? { backup_interval_minutes: fixture.intervalMinutes }
        : {}),
    },
    connectionManager: fixture.missingManager === true ? undefined : { getConnection },
  });
  return { interaction, bot, sink, getConnection, connection, logger, channel };
};

beforeEach(() => {
  vi.clearAllMocks();
  scheduleMocks.read.mockResolvedValue(state);
  scheduleMocks.update.mockResolvedValue(state);
  scheduleMocks.periodicStatus.mockResolvedValue(null);
  scheduleMocks.progressDetails.mockResolvedValue({
    activities: [],
    gaps: [],
    page: 1,
    hasNext: false,
  });
});

describe('/archive schedule', () => {
  it.each(['en', 'zh-TW'] as const)(
    'registers the complete nested command in %s',
    async (fallbackLocale) => {
      const translator = await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale,
      });
      const metadata = localizeCommandConfig(new Archive().config, translator);
      const json = buildCommandJsonBody(metadata);
      expect(json.name).toBe('archive');
      expect(metadata.subcommandGroups?.[0]?.subcommands.map(({ name }) => name)).toEqual([
        'status',
        'enable',
        'disable',
        'interval',
      ]);
      expect(JSON.stringify(json)).not.toContain('commands:');
      expect(metadata.subcommands?.map(({ name }) => name)).toEqual(['backup', 'jobs', 'plans']);
      expect(json.options).toHaveLength(4);
      for (const subcommand of metadata.subcommands ?? []) {
        expect(subcommand.description).not.toContain('archive.subcommands');
        expect(subcommand.description.length).toBeGreaterThan(0);
      }
      expect(metadata.subcommands?.every((entry) => entry.options === undefined)).toBe(true);
      expect({ ...json, options: json.options?.slice(0, 1) }).toMatchObject({
        dm_permission: false,
        default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
        options: [
          {
            name: 'schedule',
            options: [
              { name: 'status' },
              { name: 'enable' },
              { name: 'disable' },
              { name: 'interval', options: [{ name: 'minutes', min_value: 1, max_value: 10_080 }] },
            ],
          },
        ],
      });
    },
  );
  it('reads public status for the owner, and never updates settings', async () => {
    const { interaction, bot, sink, connection, getConnection, channel } = build();
    await new Archive().execute(interaction, bot);

    expect(sink.defers).toEqual([{}]);
    expect(getConnection).toHaveBeenCalledWith(GUILD_ID);
    expect(scheduleMocks.construct).toHaveBeenCalledWith(connection, 3_600_000);
    expect(scheduleMocks.read).toHaveBeenCalledOnce();
    expect(scheduleMocks.update).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
    expect(sink.followUps).toEqual([]);
    expect(sink.editReplies[0]?.content).toContain('replies:archive.disabled');
    expect(sink.editReplies[0]?.content).toContain('replies:archive.no_next_run');
  });
  it('uses the same periodic renderer and reads detail pages by scan ID', async () => {
    scheduleMocks.periodicStatus.mockResolvedValue({
      runId: 'scan-2',
      progress: sanitizeArchiveProgress({
        work: 'periodic',
        phase: 'history',
        state: 'running',
        scanId: 'scan-2',
        messages: { scanned: 32, admitted: 20, durable: 18 },
      }),
    });
    scheduleMocks.progressDetails.mockResolvedValue({
      activities: [{ sourceId: 'channel-1', name: 'source', step: 'writing', scanned: 4 }],
      gaps: [],
      page: 2,
      hasNext: false,
    });
    const { interaction, bot, sink, channel } = build({ page: 2 });
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.progressDetails).toHaveBeenCalledWith('scan-2', 2, 1);
    const content = sink.editReplies.map((payload) => payload.content).join('');
    expect(content).toContain('replies:archive.view_title');
    expect(content).toContain('"messages":"32"');
    expect(content).toContain('replies:archive.progress_page');
    expect(content).not.toContain('```');
    expect(channel.send).not.toHaveBeenCalled();
  });
  it('marks missing legacy periodic counters as unavailable without exposing raw reports', async () => {
    scheduleMocks.periodicStatus.mockResolvedValue({
      runId: 'legacy-scan',
      status: 'complete',
      counts: { scanned: 900 },
    });
    const { interaction, bot, sink } = build();
    await new Archive().execute(interaction, bot);
    const content = sink.editReplies.map((payload) => payload.content).join('');
    expect(content).toContain('replies:archive.view_counts_unavailable');
    expect(content).not.toContain('legacy-scan');
    expect(content).not.toContain('900');
    expect(content).not.toContain('```');
    expect(scheduleMocks.progressDetails).not.toHaveBeenCalled();
  });
  it('budgets the schedule summary and preserves scope, progress and detail footer', async () => {
    const id = 's'.repeat(160);
    scheduleMocks.periodicStatus.mockResolvedValue({
      runId: id,
      progress: sanitizeArchiveProgress({
        work: 'periodic',
        phase: 'history',
        state: 'running',
        scanId: id,
        runId: 'r'.repeat(160),
        jobId: 'j'.repeat(160),
        messages: { scanned: Number.MAX_SAFE_INTEGER, admitted: Number.MAX_SAFE_INTEGER },
        activityCount: 30,
        gapCount: 20,
      }),
    });
    scheduleMocks.progressDetails.mockResolvedValue({
      activities: Array.from({ length: 0 }, (_, i) => ({
        sourceId: `source-${i}`,
        name: '*'.repeat(100),
        step: 'writing',
        scanned: Number.MAX_SAFE_INTEGER,
      })),
      gaps: Array.from({ length: 1 }, (_, i) => ({
        sourceId: `gap-${i}`,
        name: '*'.repeat(100),
        reason: 'permission',
      })),
      page: 2,
      hasNext: true,
    });
    const { interaction, bot, sink } = build({ page: 2 });
    Object.assign(bot, {
      translator: await createDefaultTranslator({
        localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
        fallbackLocale: 'en',
      }),
    });
    await new Archive().execute(interaction, bot);
    const content = [...sink.editReplies, ...sink.followUps]
      .map((payload) => payload.content)
      .join('');
    expect(content.length).toBeLessThanOrEqual(1900);
    expect(scheduleMocks.progressDetails).toHaveBeenCalledWith(id, 2, 1);
    expect(content).not.toContain(id);
    expect(content).not.toContain('r'.repeat(160));
    expect(content).not.toContain('j'.repeat(160));
    expect(content).toContain(GUILD_ID);
    expect(content).toContain('9,007,199,254,740,991');
    expect(content).toContain('gap\\-0');
    expect(content).toContain('Grant View Channel and Read Message History');
    expect(content).toContain('Background history schedule: Disabled');
    expect(content).toContain('next page: 3');
  });

  it('allows a member with ManageGuild without bot-admin privileges', async () => {
    const { interaction, bot } = build({ owner: false, manageGuild: true, action: 'enable' });
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.update).toHaveBeenCalledWith({ enabled: true });
  });

  it('denies members without guild authority before accessing storage', async () => {
    const { interaction, bot, sink, getConnection } = build({ owner: false, action: 'enable' });
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toBe('replies:archive.permission_denied');
    expect(getConnection).not.toHaveBeenCalled();
    expect(scheduleMocks.update).not.toHaveBeenCalled();
  });

  it('denies direct messages before accessing storage', async () => {
    const { interaction, bot, sink, getConnection } = build({ guildId: null });
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toBe('replies:archive.guild_only');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('denies unconfigured guilds before accessing storage', async () => {
    const { interaction, bot, sink, getConnection } = build({ backupServers: ['other-guild'] });
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toBe('replies:archive.guild_not_configured');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('rejects reader personalities even with matching backup configuration', async () => {
    const { interaction, bot, sink } = build({ worker: false, action: 'enable' });
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toBe('replies:archive.worker_only');
    expect(scheduleMocks.construct).not.toHaveBeenCalled();
    expect(scheduleMocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['enable', true],
    ['disable', false],
  ])('persists %s and reports the stored state', async (action, enabled) => {
    scheduleMocks.update.mockResolvedValue({ ...state, enabled });
    const { interaction, bot, sink, channel } = build({ action });
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.update).toHaveBeenCalledWith({ enabled });
    expect(scheduleMocks.read).not.toHaveBeenCalled();
    expect(sink.defers).toEqual([{}]);
    expect(channel.send).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
    expect(sink.followUps).toEqual([]);
    expect(sink.editReplies[0]?.content).toContain('replies:archive.updated');
    expect(sink.editReplies[0]?.content).toContain(
      enabled ? 'replies:archive.enabled' : 'replies:archive.disabled',
    );
  });

  it.each(['en', 'zh-TW'] as const)(
    'reports the saved next time for unchanged %s enable and interval settings',
    async (locale) => {
      for (const action of ['enable', 'interval']) {
        scheduleMocks.update.mockResolvedValue({
          ...state,
          enabled: true,
          intervalMs: 5_400_000,
          nextRunAt: 1_700_000_000_000,
        });
        const { interaction, bot, sink } = build({ action, minutes: 90 });
        const translator = await createDefaultTranslator({
          localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
          fallbackLocale: locale,
        });
        Object.assign(bot, { translator });
        await new Archive().execute(interaction, bot);
        const content = sink.editReplies[0]?.content;
        expect(content).toContain('<t:1700000000:R>');
        expect(content).toContain(
          translator.t(
            `replies:archive.schedule_${action === 'enable' ? 'enable' : 'interval'}_effect`,
          ),
        );
        expect(content).toContain(locale === 'en' ? 'unchanged' : '相同');
      }
    },
  );

  it.each([1, 90, 10_080])('sets %i minutes and enables in one update', async (minutes) => {
    scheduleMocks.update.mockResolvedValue({
      ...state,
      enabled: true,
      intervalMs: minutes * 60_000,
    });
    const { interaction, bot, sink } = build({ action: 'enable', minutes });
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.update).toHaveBeenCalledOnce();
    expect(scheduleMocks.update).toHaveBeenCalledWith({
      enabled: true,
      intervalMs: minutes * 60_000,
    });
    expect(sink.editReplies[0]?.content).toContain('replies:archive.schedule_enable_effect');
  });

  it.each([0, -1, 10_081, 1.5, Number.NaN])(
    'rejects invalid optional enable interval %s before accessing storage',
    async (minutes) => {
      const { interaction, bot, sink, getConnection } = build({ action: 'enable', minutes });
      await new Archive().execute(interaction, bot);
      expect(sink.editReplies[0]?.content).toBe('replies:archive.invalid_interval');
      expect(getConnection).not.toHaveBeenCalled();
      expect(scheduleMocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['enable', true, 'schedule_enable_effect'],
    ['disable', false, 'schedule_disable_effect'],
    ['interval', true, 'schedule_interval_effect'],
    ['interval', false, 'schedule_interval_disabled'],
  ])('explains the effect of %s with enabled=%s', async (action, enabled, effect) => {
    scheduleMocks.update.mockResolvedValue({ ...state, enabled });
    const { interaction, bot, sink } = build({
      action,
      minutes: action === 'interval' ? 90 : undefined,
    });
    await new Archive().execute(interaction, bot);
    const content = sink.editReplies[0]?.content;
    expect(content).toContain(`replies:archive.${effect}`);
    expect(content).toContain('replies:archive.schedule_check_status');
    expect(content).not.toContain('replies:archive.schedule_policy');
  });

  it.each([1, 90, 10_080])(
    'persists an interval of %i minutes without enabling the schedule',
    async (minutes) => {
      const { interaction, bot } = build({ action: 'interval', minutes });
      await new Archive().execute(interaction, bot);
      expect(scheduleMocks.update).toHaveBeenCalledWith({ intervalMs: minutes * 60_000 });
    },
  );

  it.each([0, -1, 10_081, 1.5, Number.NaN])(
    'rejects an invalid interval of %s before accessing storage',
    async (minutes) => {
      const { interaction, bot, sink, getConnection } = build({ action: 'interval', minutes });
      await new Archive().execute(interaction, bot);
      expect(sink.editReplies[0]?.content).toBe('replies:archive.invalid_interval');
      expect(getConnection).not.toHaveBeenCalled();
      expect(scheduleMocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([{ action: 'unknown' }, { group: 'unknown' }])(
    'rejects an unknown route before accessing storage',
    async (fixture) => {
      const { interaction, bot, sink, getConnection } = build(fixture);
      await new Archive().execute(interaction, bot);
      expect(sink.editReplies[0]?.content).toBe('replies:archive.invalid_action');
      expect(getConnection).not.toHaveBeenCalled();
    },
  );

  it('uses the configured default interval and shows the next scan', async () => {
    scheduleMocks.read.mockResolvedValue({
      ...state,
      enabled: true,
      intervalMs: 5_400_000,
      nextRunAt: 1_700_000_000_001,
    });
    const { interaction, bot, sink, connection } = build({ intervalMinutes: 90 });
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.construct).toHaveBeenCalledWith(connection, 5_400_000);
    expect(sink.editReplies[0]?.content).toContain('"minutes":90');
    expect(sink.editReplies[0]?.content).toContain('<t:1700000000:R>');
    expect(sink.editReplies[0]?.content).toContain('replies:archive.idle');
  });

  it('shows the next scan as pending while an enabled scan is running', async () => {
    scheduleMocks.read.mockResolvedValue({
      ...state,
      enabled: true,
      running: true,
      nextRunAt: 1_700_000_000_001,
    });
    const { interaction, bot, sink } = build();
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toContain('replies:archive.running');
    expect(sink.editReplies[0]?.content).toContain('replies:archive.next_after_pass');
    expect(sink.editReplies[0]?.content).not.toContain('<t:');
  });

  it('shows no next scan after disabling an active pass', async () => {
    scheduleMocks.read.mockResolvedValue({
      ...state,
      running: true,
      nextRunAt: 1_700_000_000_001,
    });
    const { interaction, bot, sink } = build();
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toContain('replies:archive.no_next_run');
    expect(sink.editReplies[0]?.content).not.toContain('replies:archive.next_after_pass');
  });

  it.each(['read', 'update'] as const)(
    'reports %s failures with an error reference',
    async (operation) => {
      scheduleMocks[operation].mockRejectedValue(new Error('database unavailable'));
      const { interaction, bot, sink, channel } = build({
        action: operation === 'read' ? 'status' : 'enable',
      });
      await new Archive().execute(interaction, bot);
      expect(sink.editReplies[0]?.content).toContain('replies:archive.failed');
      expect(sink.editReplies[0]?.content).toContain('traceId');
      expect(channel.send).not.toHaveBeenCalled();
      expect(interaction.deleteReply).not.toHaveBeenCalled();
    },
  );

  it('reports an unavailable connection manager', async () => {
    const { interaction, bot, sink } = build({ missingManager: true });
    await new Archive().execute(interaction, bot);
    expect(sink.editReplies[0]?.content).toContain('replies:archive.failed');
    expect(scheduleMocks.construct).not.toHaveBeenCalled();
  });

  it('validates the archive configuration before registration', () => {
    const command = new Archive();
    expect(() => command.validateBotConfig({ backup_server: [GUILD_ID] })).not.toThrow();
    expect(() => command.validateBotConfig({})).toThrow();
    expect(() => command.validateBotConfig({ backup_server: [] })).not.toThrow();
    expect(() =>
      command.validateBotConfig({ backup_server: [GUILD_ID], backup_interval_minutes: 0 }),
    ).toThrow();
  });
  it('updates a schedule without publishing to the debug channel', async () => {
    const { interaction, bot, channel, sink } = build({ action: 'enable' });
    channel.send.mockRejectedValue(new Error('403'));
    await new Archive().execute(interaction, bot);
    expect(scheduleMocks.update).toHaveBeenCalledWith({ enabled: true });
    expect(channel.send).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
    expect(sink.editReplies[0]?.content).toContain('replies:archive.updated');
  });
});

describe('archive interaction reports', () => {
  it('keeps a 1900-character summary in one public message', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    await interaction.deferReply();
    await publishArchiveReply(interaction, { content: 'a'.repeat(1900) });
    expect(sink.editReplies).toHaveLength(1);
    expect(sink.editReplies[0]?.content).toHaveLength(1900);
    expect(sink.followUps).toHaveLength(0);
  });
  it('rejects an unbounded presenter payload without sending overflow messages', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    await interaction.deferReply();
    await expect(publishArchiveReply(interaction, { content: 'a'.repeat(1901) })).rejects.toThrow(
      'public detail budget',
    );
    expect(sink.editReplies).toEqual([]);
    expect(sink.followUps).toEqual([]);
  });

  it('keeps controls on the original response for a single page', async () => {
    const sink = newInteractionSink();
    const interaction = buildChatInputInteraction({ sink });
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('archive|confirm')
          .setLabel('Confirm')
          .setStyle(ButtonStyle.Primary),
      ),
    ];
    await interaction.deferReply();

    await publishArchiveReply(interaction, { content: 'Report', components });

    expect(sink.editReplies).toEqual([
      { content: 'Report', components, attachments: [], allowedMentions: { parse: [] } },
    ]);
    expect(sink.followUps).toEqual([]);
  });
});
