/**
 * Unit tests for {@link DiscordGalleryStaging}: the channel checks that make
 * staging fall back, batching within Discord's per-message limits, URL
 * expiry from the signed `ex` parameter capped by the retention, proxy
 * warming, and cleanup that deletes only this bot's expired messages.
 */
import { describe, expect, it, vi } from 'vitest';
import { Collection, PermissionFlagsBits, type Client } from 'discord.js';

import { DiscordGalleryStaging } from '../../../../src/infra/discord/gallery-staging';
import { spyLogger } from '../../../fixtures/runtime';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

interface FakeOptions {
  readonly nsfw?: boolean;
  readonly permissions?: readonly bigint[];
  readonly send?: (payload: { files: Array<{ name: string }> }) => Promise<unknown>;
  readonly history?: ReadonlyArray<{ id: string; authorId: string; createdTimestamp: number }>;
}

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

const signed = (name: string, exSeconds: number): string =>
  `https://cdn.discordapp.com/attachments/1/2/${name}?ex=${exSeconds.toString(16)}&is=0&hm=x`;

const sentMessage = (payload: { files: Array<{ name: string }> }, exSeconds: number) => ({
  attachments: new Collection(
    payload.files.map((file, index) => [
      String(index),
      {
        name: file.name,
        url: signed(file.name, exSeconds),
        proxyURL: `https://media.discordapp.net/attachments/1/2/${file.name}`,
      },
    ]),
  ),
});

const build = (options: FakeOptions = {}) => {
  const deleted: string[] = [];
  const bulkDeleted: string[][] = [];
  const history = (options.history ?? []).map((entry) => ({
    id: entry.id,
    author: { id: entry.authorId },
    createdTimestamp: entry.createdTimestamp,
    delete: vi.fn(async () => {
      deleted.push(entry.id);
    }),
  }));
  const send = vi.fn(
    options.send ?? (async (payload) => sentMessage(payload, Math.floor((NOW + 2 * DAY) / 1000))),
  );
  let fetched = false;
  const channel = {
    guildId: 'g',
    isTextBased: () => true,
    isDMBased: () => false,
    isThread: () => false,
    nsfw: options.nsfw ?? true,
    permissionsFor: () => ({
      has: (flag: bigint) => (options.permissions ?? ALL).includes(flag),
    }),
    send,
    messages: {
      fetch: vi.fn(async () => {
        if (fetched) return new Collection();
        fetched = true;
        return new Collection(history.map((message) => [message.id, message]));
      }),
    },
    bulkDelete: vi.fn(async (messages: Array<{ id: string }>) => {
      bulkDeleted.push(messages.map((message) => message.id));
    }),
  };
  const client = {
    user: { id: 'self' },
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  const logger = spyLogger();
  const warm = vi.fn(async () => undefined);
  const staging = new DiscordGalleryStaging({
    client,
    channelId: '123456789012345678',
    retentionMs: DAY,
    logger,
    now: () => NOW,
    warm,
  });
  return { staging, send, warm, logger, deleted, bulkDeleted, client };
};

const file = (name: string, size = 10) => ({ name, image: { data: Buffer.alloc(size) } });

describe('DiscordGalleryStaging.stage', () => {
  it('uploads in batches of ten, warms each proxy URL and caps expiry at the retention', async () => {
    const { staging, send, warm } = build();
    const files = Array.from({ length: 12 }, (_, i) => file(`p${i}.webp`));

    const result = await staging.stage(files);

    expect(send).toHaveBeenCalledTimes(2);
    expect(warm).toHaveBeenCalledTimes(12);
    expect(warm).toHaveBeenCalledWith('https://media.discordapp.net/attachments/1/2/p0.webp');
    expect(result).toHaveLength(12);
    expect(result[11]?.url).toBe(signed('p11.webp', Math.floor((NOW + 2 * DAY) / 1000)));
    expect(result[0]?.expiresAt).toBe(NOW + DAY);
  });

  it('returns uploaded URLs without waiting for the proxy to warm', async () => {
    const { staging, warm } = build();
    warm.mockImplementation(() => new Promise<undefined>(() => undefined));
    const result = await staging.stage([file('p0.webp')]);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(result[0]?.url).toBeDefined();
  });

  it('keeps a shorter signed expiry and splits by size', async () => {
    const ex = Math.floor((NOW + 60 * 60 * 1000) / 1000);
    const { staging, send } = build({ send: async (payload) => sentMessage(payload, ex) });
    const result = await staging.stage([
      file('a.webp', 5 * 1024 * 1024),
      file('b.webp', 5 * 1024 * 1024),
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result[0]?.expiresAt).toBe(ex * 1000);
  });

  it.each([
    ['a channel that is not age-restricted', { nsfw: false }],
    ['missing upload permission', { permissions: [PermissionFlagsBits.ViewChannel] }],
  ])('stages nothing for %s and warns once', async (_label, options) => {
    const { staging, send, logger } = build(options);
    expect(await staging.stage([file('a.webp')])).toEqual([undefined]);
    expect(await staging.stage([file('b.webp')])).toEqual([undefined]);
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns unstaged pages when the upload fails, without throwing', async () => {
    const { staging, client } = build({
      send: async () => {
        throw new Error('discord down');
      },
    });
    expect(await staging.stage([file('a.webp')])).toEqual([undefined]);
    await staging.stage([file('b.webp')]);
    expect(client.channels.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('DiscordGalleryStaging.cleanup', () => {
  it("deletes only this bot's messages past the retention", async () => {
    const { staging, bulkDeleted, deleted } = build({
      history: [
        { id: 'fresh', authorId: 'self', createdTimestamp: NOW - 60_000 },
        { id: 'old-1', authorId: 'self', createdTimestamp: NOW - 2 * DAY },
        { id: 'old-2', authorId: 'self', createdTimestamp: NOW - 3 * DAY },
        { id: 'other-bot', authorId: 'tomori', createdTimestamp: NOW - 3 * DAY },
        { id: 'ancient', authorId: 'self', createdTimestamp: NOW - 30 * DAY },
      ],
    });
    await staging.cleanup();
    expect(bulkDeleted).toEqual([['old-1', 'old-2']]);
    expect(deleted).toEqual(['ancient']);
  });

  it('deletes one by one without Manage Messages', async () => {
    const { staging, bulkDeleted, deleted } = build({
      permissions: ALL.filter((flag) => flag !== PermissionFlagsBits.ManageMessages),
      history: [
        { id: 'old-1', authorId: 'self', createdTimestamp: NOW - 2 * DAY },
        { id: 'old-2', authorId: 'self', createdTimestamp: NOW - 2 * DAY },
      ],
    });
    await staging.cleanup();
    expect(bulkDeleted).toEqual([]);
    expect(deleted).toEqual(['old-1', 'old-2']);
  });
});
