import path from 'node:path';
import { DiscordAPIError, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import Archive from '../../../../src/handlers/commands/archive';
import type { ArchiveControl } from '../../../../src/application/archive/control';
import { createDefaultTranslator } from '../../../../src/core/i18n';
import { localizeCommandConfig } from '../../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../../src/handlers/commands/command-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { ADMIN_ID, DEBUG_ID, archiveBot, archiveGuild } from './fixtures';

const SCHEDULE = {
  enabled: false,
  intervalMs: 3_600_000,
  nextRunAt: null,
  running: false,
  revision: 0,
  pauseVersion: 0,
};
// The control service reaches the command through the injected factory.
const control = {
  latestFullBackup: vi.fn(),
  setPanel: vi.fn(),
  requestConfirmation: vi.fn(),
  coverage: vi.fn(),
  status: vi.fn(),
  archiveBytes: vi.fn(),
  readSchedule: vi.fn(),
  updateSchedule: vi.fn(),
} satisfies Partial<ArchiveControl>;

const run = async (
  subcommand: string,
  options: {
    userId?: string;
    channelId?: string;
    minutes?: number;
    editReply?: () => Promise<unknown>;
  } = {},
) => {
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    commandName: 'archive',
    userId: options.userId ?? ADMIN_ID,
    guild: archiveGuild(),
    channel: { id: options.channelId ?? DEBUG_ID },
    sink,
    ...(options.minutes === undefined ? {} : { options: { minutes: options.minutes } }),
  });
  Object.assign(interaction.options, {
    getSubcommand: () => subcommand,
    getBoolean: () => null,
  });
  Object.assign(interaction, { fetchReply: vi.fn().mockResolvedValue({ id: '500' }) });
  if (options.editReply !== undefined) Object.assign(interaction, { editReply: options.editReply });
  const { bot, logger } = archiveBot({ control });
  await new Archive().execute(interaction, bot);
  return { sink, logger };
};
const titleOf = (sink: ReturnType<typeof newInteractionSink>) =>
  JSON.stringify((sink.editReplies.at(-1) as { embeds?: unknown } | undefined)?.embeds);

beforeEach(() => {
  vi.clearAllMocks();
  control.latestFullBackup.mockResolvedValue(undefined);
  control.requestConfirmation.mockResolvedValue({ token: 'T'.repeat(24), expiresAt: 5000 });
  control.coverage.mockResolvedValue({ readable: 1, gaps: { denied: 0, deleted: 0, unknown: 0 } });
  control.status.mockResolvedValue({
    schedule: SCHEDULE,
    coverage: { readable: 1, gaps: { denied: 0, deleted: 0, unknown: 0 } },
    inbox: { pending: 0, dead: 0 },
  });
  control.archiveBytes.mockResolvedValue(1024);
  control.readSchedule.mockResolvedValue(SCHEDULE);
});

describe('/archive', () => {
  it('registers backup, status and schedule without a default member permission', async () => {
    const translator = await createDefaultTranslator({
      localesDir: path.resolve(__dirname, '../../../../src/i18n/locales'),
      fallbackLocale: 'en',
    });
    const body = buildCommandJsonBody(localizeCommandConfig(new Archive().config, translator));
    expect(body.default_member_permissions ?? null).toBeNull();
    expect(body.options?.map((option) => option.name)).toEqual(['backup', 'status', 'schedule']);
    const scheduleOptions = (
      body.options?.find((option) => option.name === 'schedule') as {
        options?: { name: string; type: number }[];
      }
    ).options;
    // Boolean `enabled` (type 5) and integer `minutes` (type 4), both optional.
    expect(scheduleOptions?.map((option) => [option.name, option.type])).toEqual([
      ['enabled', 5],
      ['minutes', 4],
    ]);
  });

  it('opens the confirmation bound to the public reply', async () => {
    const { sink } = await run('backup');
    expect(sink.defers).toEqual([{}]);
    expect(control.requestConfirmation).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      channelId: DEBUG_ID,
      messageId: '500',
    });
    expect(sink.editReplies.at(-1)).toMatchObject({ content: '' });
    expect(titleOf(sink)).toContain('replies:archive.confirm_title');
  });

  it('shows status and the schedule from the control service', async () => {
    expect(titleOf((await run('status')).sink)).toContain('replies:archive.status_title');
    expect(control.status).toHaveBeenCalledOnce();
    await run('schedule');
    expect(control.readSchedule).toHaveBeenCalledOnce();
    expect(control.updateSchedule).not.toHaveBeenCalled();
  });

  it('rejects a non-admin privately before posting anything public', async () => {
    const { sink } = await run('backup', { userId: '999' });
    expect(sink.defers).toEqual([]);
    expect(sink.replies).toHaveLength(1);
    expect(sink.replies[0]?.content).toContain('replies:archive.permission_denied');
    expect(sink.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(control.requestConfirmation).not.toHaveBeenCalled();
  });

  it('rejects use outside the debug channel', async () => {
    const { sink } = await run('status', { channelId: '999' });
    expect(sink.replies[0]?.content).toContain('replies:archive.debug_only');
    expect(sink.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('answers an out-of-range interval through the real schedule path', async () => {
    const { sink, logger } = await run('schedule', { minutes: 10_081 });
    expect(sink.editReplies.at(-1)?.content).toContain('replies:archive.invalid_interval');
    expect(control.updateSchedule).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers an unknown subcommand and invalid control input privately', async () => {
    expect((await run('plans')).sink.replies[0]?.content).toContain(
      'replies:archive.invalid_action',
    );
    control.requestConfirmation.mockRejectedValueOnce(new z.ZodError([]));
    const { sink, logger } = await run('backup');
    expect(sink.editReplies.at(-1)?.content).toContain('replies:archive.invalid_input');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unexpected failure with the trace ID shown to the operator', async () => {
    control.status.mockRejectedValueOnce(new Error('database offline'));
    const { sink, logger } = await run('status');
    const traceId = (logger.error.mock.calls[0]?.[0] as { traceId: string }).traceId;
    expect(traceId).toMatch(/^[0-9a-f]{8}$/);
    expect(sink.editReplies.at(-1)?.content).toBe(
      `replies:archive.failed:${JSON.stringify({ traceId })}`,
    );
  });

  it('logs an expired failure reply and rethrows any other reply error', async () => {
    control.status.mockRejectedValue(new Error('database offline'));
    const expired = new DiscordAPIError(
      { code: 10062, message: 'Unknown interaction' },
      10062,
      404,
      'PATCH',
      '/webhooks/1/token/messages/@original',
      {},
    );
    const { logger } = await run('status', { editReply: vi.fn().mockRejectedValue(expired) });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: expect.any(String) }),
      'Archive failure reply expired',
    );
    await expect(
      run('status', { editReply: vi.fn().mockRejectedValue(new Error('gateway down')) }),
    ).rejects.toThrow('gateway down');
  });
});
