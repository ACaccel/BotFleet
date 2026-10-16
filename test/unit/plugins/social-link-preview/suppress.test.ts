/**
 * Unit tests for {@link applyOriginalMessageStrategy}: the permission
 * gate and the suppress / delete / leave matrix. The critical case is
 * "permission missing -> nothing mutated, no throw" (the reply-only
 * fallback), plus "Discord call throws -> swallowed".
 */
import { describe, expect, it, vi } from 'vitest';

import { applyOriginalMessageStrategy } from '../../../../src/plugins/social-link-preview/internal/suppress';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { silentLogger, spyLogger } from '../../../fixtures/runtime';

interface MsgOpts {
  readonly hasPerm?: boolean;
  readonly permsNull?: boolean;
  readonly inGuild?: boolean;
  readonly nullBotUser?: boolean;
  readonly suppressThrows?: boolean;
}

const makeMessage = (opts: MsgOpts = {}) => {
  const calls = { suppress: 0, delete: 0, permissionsFor: 0 };
  const permissions = { has: vi.fn(() => opts.hasPerm ?? true) };
  const channel = {
    permissionsFor: vi.fn(() => {
      calls.permissionsFor += 1;
      return opts.permsNull === true ? null : permissions;
    }),
  };
  const message = buildMessage({
    inGuild: () => opts.inGuild ?? true,
    client: { user: opts.nullBotUser === true ? null : { id: 'bot' } },
    channel,
    channelId: 'c1',
    guildId: 'g1',
    suppressEmbeds: vi.fn(async () => {
      calls.suppress += 1;
      if (opts.suppressThrows === true) throw new Error('already deleted');
    }),
    delete: vi.fn(async () => {
      calls.delete += 1;
    }),
  });
  return { message, calls };
};

describe('applyOriginalMessageStrategy', () => {
  it('suppresses embeds when permitted', async () => {
    const { message, calls } = makeMessage({ hasPerm: true });
    await applyOriginalMessageStrategy(message, 'suppress', silentLogger());
    expect(calls.suppress).toBe(1);
    expect(calls.delete).toBe(0);
  });

  it('deletes the message when permitted and strategy is delete', async () => {
    const { message, calls } = makeMessage({ hasPerm: true });
    await applyOriginalMessageStrategy(message, 'delete', silentLogger());
    expect(calls.delete).toBe(1);
    expect(calls.suppress).toBe(0);
  });

  it('does nothing and never checks permissions for the leave strategy', async () => {
    const { message, calls } = makeMessage({ hasPerm: true });
    await applyOriginalMessageStrategy(message, 'leave', silentLogger());
    expect(calls.permissionsFor).toBe(0);
    expect(calls.suppress).toBe(0);
    expect(calls.delete).toBe(0);
  });

  it('falls back to reply-only (no mutation, debug log) when ManageMessages is missing', async () => {
    const { message, calls } = makeMessage({ hasPerm: false });
    const logger = spyLogger();
    const { debug } = logger;
    await applyOriginalMessageStrategy(message, 'suppress', logger);
    expect(calls.suppress).toBe(0);
    expect(calls.delete).toBe(0);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('treats a null permissions result as missing permission', async () => {
    const { message, calls } = makeMessage({ permsNull: true });
    await applyOriginalMessageStrategy(message, 'suppress', silentLogger());
    expect(calls.suppress).toBe(0);
  });

  it('does nothing outside a guild', async () => {
    const { message, calls } = makeMessage({ inGuild: false });
    await applyOriginalMessageStrategy(message, 'suppress', silentLogger());
    expect(calls.permissionsFor).toBe(0);
    expect(calls.suppress).toBe(0);
  });

  it('does nothing when the bot user is not yet resolved', async () => {
    const { message, calls } = makeMessage({ nullBotUser: true });
    await applyOriginalMessageStrategy(message, 'suppress', silentLogger());
    expect(calls.permissionsFor).toBe(0);
    expect(calls.suppress).toBe(0);
  });

  it('swallows a Discord error and logs it (no throw)', async () => {
    const { message } = makeMessage({ hasPerm: true, suppressThrows: true });
    const logger = spyLogger();
    const { error } = logger;
    await expect(
      applyOriginalMessageStrategy(message, 'suppress', logger),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
