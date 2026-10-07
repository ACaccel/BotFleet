import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  patchArchivePublicDetails,
  publicArchiveSourceName,
  withArchivePublicMessageLock,
} from '../../../../src/infra/archive/public-message';

const readable = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

const clientWithSource = (type: ChannelType = ChannelType.GuildText, denies: bigint[] = []) => {
  const overwrites = new Map([['role', { deny: new PermissionsBitField(denies) }]]);
  const source = {
    name: 'public-room',
    type,
    isTextBased: () => true,
    isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread].includes(type),
    permissionsFor: () => new PermissionsBitField(readable),
    permissionOverwrites: { cache: overwrites },
    parent: { permissionOverwrites: { cache: overwrites } },
  };
  const guild = {
    roles: { everyone: { id: '1' } },
    channels: { cache: new Map([['10', source]]) },
  };
  return { client: { guilds: { cache: new Map([['1', guild]]) } } as unknown as Client, source };
};

describe('public archive source labels', () => {
  it('names a cached readable public source', () => {
    const { client } = clientWithSource();
    expect(publicArchiveSourceName(client, '1', '10')).toBe('public-room');
  });

  it.each([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])(
    'hides a source when a member or role overwrite denies %s despite everyone access',
    (permission) => {
      const { client } = clientWithSource(ChannelType.GuildText, [permission]);
      expect(publicArchiveSourceName(client, '1', '10')).toBeUndefined();
    },
  );

  it('checks a public thread parent and always hides private threads', () => {
    const publicThread = clientWithSource(ChannelType.PublicThread, [
      PermissionFlagsBits.ViewChannel,
    ]);
    const privateThread = clientWithSource(ChannelType.PrivateThread);
    expect(publicArchiveSourceName(publicThread.client, '1', '10')).toBeUndefined();
    expect(publicArchiveSourceName(privateThread.client, '1', '10')).toBeUndefined();
  });

  it('hides uncached sources and unknown guilds', () => {
    const { client } = clientWithSource();
    expect(publicArchiveSourceName(client, '1', '11')).toBeUndefined();
    expect(publicArchiveSourceName(client, '2', '10')).toBeUndefined();
  });
});

describe('public archive message coordination', () => {
  it('continues queued edits after an earlier edit fails', async () => {
    let release!: () => void;
    let enter!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const calls: string[] = [];
    const failed = withArchivePublicMessageLock('10', '100', async () => {
      calls.push('first');
      enter();
      await blocked;
      throw new Error('delivery unavailable');
    });
    const recovered = withArchivePublicMessageLock('10', '100', async () => {
      calls.push('second');
    });
    const rejection = expect(failed).rejects.toThrow('delivery unavailable');
    await entered;
    expect(calls).toEqual(['first']);
    release();
    await rejection;
    await recovered;
    expect(calls).toEqual(['first', 'second']);
  });

  it('reads current status in the queue and replaces only public details', async () => {
    const get = vi.fn(async () => ({
      embeds: [
        {
          title: 'Latest status',
          timestamp: '2026-10-06T00:00:00Z',
          footer: { text: 'Updated' },
          color: 0x3182ce,
        },
        { description: 'Old page' },
      ],
    }));
    const patch = vi.fn(async () => ({}));
    const client = { rest: { get, patch } } as unknown as Client;
    await patchArchivePublicDetails(client, '10', '100', { content: 'Page 2', components: [] });
    expect(get).toHaveBeenCalledWith('/channels/10/messages/100');
    expect(patch).toHaveBeenCalledWith('/channels/10/messages/100', {
      body: {
        content: '',
        embeds: [
          {
            title: 'Latest status',
            timestamp: '2026-10-06T00:00:00Z',
            footer: { text: 'Updated' },
            color: 0x3182ce,
          },
          { description: 'Page 2' },
        ],
        components: [],
        attachments: [],
        allowed_mentions: { parse: [] },
      },
    });
  });
  it('replaces list and standalone plan pages instead of duplicating their previous embed', async () => {
    let message = { embeds: [{ title: 'Plans', description: 'Old list' }] };
    const get = vi.fn(async () => message);
    const patch = vi.fn(async (_route: string, options: { body: typeof message }) => {
      message = options.body;
    });
    const client = { rest: { get, patch } } as unknown as Client;
    for (const content of ['New list', 'Selected plan', 'Refreshed plan']) {
      await patchArchivePublicDetails(client, '10', '100', { content, components: [] });
      expect(message.embeds).toEqual([{ description: content }]);
    }
  });

  it('removes the former status when navigation leaves its owning panel', async () => {
    const get = vi.fn(async () => ({
      embeds: [
        {
          title: 'Former job status',
          timestamp: '2026-10-06T00:00:00Z',
          footer: { text: 'Updated' },
          color: 0x3182ce,
        },
        { description: 'Former job details' },
      ],
    }));
    const patch = vi.fn(async () => ({}));
    const client = { rest: { get, patch } } as unknown as Client;
    await patchArchivePublicDetails(
      client,
      '10',
      '100',
      { content: 'Different job details', components: [] },
      { retainStatus: false },
    );
    expect(patch).toHaveBeenCalledWith(
      '/channels/10/messages/100',
      expect.objectContaining({
        body: expect.objectContaining({ embeds: [{ description: 'Different job details' }] }),
      }),
    );
  });
});
