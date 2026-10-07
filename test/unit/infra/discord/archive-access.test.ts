import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { canReadArchiveSource } from '../../../../src/infra/discord/archive-access';

const fixture = (type = ChannelType.GuildText, membership = true) => {
  const permissions = { has: vi.fn((bits: unknown) => Array.isArray(bits)) };
  const channel = {
    type,
    isTextBased: () => true,
    permissionsFor: () => permissions,
    members: {
      fetch: vi.fn(async () => {
        if (!membership) throw new Error('not joined');
        return { id: 'user' };
      }),
    },
  };
  const guild = {
    channels: { fetch: vi.fn(async () => channel) },
    members: { fetch: vi.fn(async () => ({ id: 'user' })) },
  };
  return { guild: guild as unknown as Guild, channel, permissions };
};

describe('archive source visibility', () => {
  it('requires source view and history permissions', async () => {
    const f = fixture();
    expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(true);
    expect(f.permissions.has).toHaveBeenCalledWith([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ]);
    f.permissions.has.mockReturnValue(false);
    expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(false);
  });
  it('requires private thread membership unless ManageThreads is granted', async () => {
    const f = fixture(ChannelType.PrivateThread, false);
    expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(false);
    f.permissions.has.mockReturnValue(true);
    expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(true);
  });
  it('fails closed for inaccessible or deleted sources', async () => {
    const f = fixture();
    vi.mocked(f.guild.channels.fetch).mockRejectedValue(new Error('missing access'));
    expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(false);
  });
  it.each([ChannelType.GuildVoice, ChannelType.GuildStageVoice])(
    'requires Connect for voice/stage source %s',
    async (type) => {
      const f = fixture(type);
      expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(false);
      f.permissions.has.mockReturnValue(true);
      expect(await canReadArchiveSource(f.guild, 'channel', 'user')).toBe(true);
    },
  );
});
