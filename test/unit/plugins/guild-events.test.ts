/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logGuildEvent so tests can assert the local audit line independently of
// the embed — it now fires unconditionally, even when rank suppresses the
// mirror. importOriginal keeps logError / logSystem real.
vi.mock('@core/logger', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logGuildEvent: vi.fn(),
}));

// Mock archiveDeletedAttachments so the unconditional-archival test can assert
// it fires even when the embed is rank-suppressed; importOriginal keeps
// ancestorChannelIdsOf (the real ancestry walk) intact for the suppression tests.
vi.mock('../../../src/infra/discord', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  archiveDeletedAttachments: vi.fn(async () => undefined),
}));

import { Collection, EmbedBuilder, type Channel, type Message, type TextChannel } from 'discord.js';
import { logGuildEvent } from '@core/logger';
import { archiveDeletedAttachments } from '../../../src/infra/discord';
import { createGuildEventsPlugin } from '../../../src/plugins/guild-events';
import { __test as guildEventsTest } from '../../../src/plugins/guild-events/plugin';
import {
  createPermissionRankPolicy,
  type GuildOnboardingPort,
  type PermissionRankPolicy,
} from '../../../src/core/plugin';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { buildSendableChannel } from '../../fixtures/discord/channel-builder';
import { buildGuild } from '../../fixtures/discord/guild-builder';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

describe('createGuildEventsPlugin', () => {
  it('declares its event subscriptions (config block optional)', () => {
    const plugin = createGuildEventsPlugin();
    expect(plugin.id).toBe('guild-events');
    expect(plugin.init).toBeTypeOf('function');
    expect(plugin.events?.messageCreate).toBeTypeOf('function');
    expect(plugin.events?.messageUpdate).toBeTypeOf('function');
    expect(plugin.events?.messageDelete).toBeTypeOf('function');
    expect(plugin.events?.messageDeleteBulk).toBeTypeOf('function');
    expect(plugin.events?.guildMemberUpdate).toBeTypeOf('function');
    expect(plugin.events?.guildCreate).toBeTypeOf('function');
  });

  it('refuses to run an event that somehow precedes init', async () => {
    // The host never dispatches to a plugin whose init did not run, so
    // this pins the invariant rather than a reachable code path.
    const handler = createGuildEventsPlugin().events?.messageDelete;
    if (handler === undefined) throw new Error('no messageDelete handler');
    await expect(handler(buildPluginContext(), buildMessage() as never)).rejects.toThrow(
      /dispatched before init/,
    );
  });
});

describe('safeSendEmbed', () => {
  it('swallows channel.send rejections so the caller can keep running its audit-log side effects', async () => {
    const fakeChannel = {
      send: vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    } as unknown as TextChannel;
    const embed = new EmbedBuilder().setTitle('x');
    // Should NOT throw — that is the contract this regression test
    // protects: a Discord-side rejection here must not abort the
    // surrounding handler before its guildLogger / attachmentLogger
    // call sites run.
    await expect(
      guildEventsTest.safeSendEmbed(fakeChannel, embed, undefined, 'guild-1', 'message_update'),
    ).resolves.toBeUndefined();
    expect(fakeChannel.send).toHaveBeenCalledTimes(1);
  });

  it('forwards successful sends without error', async () => {
    const fakeChannel = {
      send: vi.fn(async () => undefined),
    } as unknown as TextChannel;
    const embed = new EmbedBuilder().setTitle('x');
    await guildEventsTest.safeSendEmbed(fakeChannel, embed, undefined, 'guild-1', 'message_delete');
    expect(fakeChannel.send).toHaveBeenCalledTimes(1);
  });
});

describe('handleGuildCreate', () => {
  const fakeGuild = (id: string) => buildGuild({ id, name: `guild-${id}` });

  it('delegates onboarding of a new guild to the GuildOnboardingPort', async () => {
    const onboardGuild = vi.fn(async () => ({
      guildId: 'g-1',
      databaseConnected: true,
      commandsRegistered: true,
    }));
    const port: GuildOnboardingPort = { onboardGuild };

    await guildEventsTest.handleGuildCreate(port, undefined, fakeGuild('g-1'));

    expect(onboardGuild).toHaveBeenCalledTimes(1);
    expect(onboardGuild).toHaveBeenCalledWith('g-1');
  });

  it('swallows a port failure so a dispatcher subscription never rejects', async () => {
    const port: GuildOnboardingPort = {
      onboardGuild: vi.fn(async () => {
        throw new Error('connect failed');
      }),
    };

    // Regression contract: onboarding is a structural side effect; a
    // failure is logged, not rethrown.
    await expect(
      guildEventsTest.handleGuildCreate(port, undefined, fakeGuild('g-2')),
    ).resolves.toBeUndefined();
  });
});

/**
 * Behaviour: rank gates DISCLOSURE only. For a channel above the `guild_events`
 * ceiling the Discord embed is withheld, but the local audit line and the
 * attachment archival still run. Drives the real `messageUpdate` /
 * `messageDelete` handlers with a live IoC container holding a real
 * (static-config) policy and a fake event channel; the channel's `send` spy is
 * the disclosure probe (fires only when NOT suppressed) while the mocked
 * `logGuildEvent` / `archiveDeletedAttachments` are the local-record probes
 * (fire regardless of rank).
 */
describe('guild-events disclosure gating by permission_rank', () => {
  const silent = silentLogger();

  const registryWith = (eventChannel: Channel): GuildRegistry => ({
    getRepos: () => undefined,
    getChannel: (_guildId: string, name: string) => (name === 'event' ? eventChannel : undefined),
    getRole: () => undefined,
    listGuildIds: () => [],
  });

  const buildCtx = (registry: GuildRegistry, policy: PermissionRankPolicy) => {
    const container = createContainer();
    container.registerSingleton(TOKENS.Logger, () => silent);
    container.registerSingleton(TOKENS.GuildRegistry, () => registry);
    container.registerSingleton(TOKENS.PermissionRankPolicy, () => policy);
    container.registerSingleton(TOKENS.GuildOnboardingPort, () => ({
      onboardGuild: async () => ({
        guildId: 'g1',
        databaseConnected: true,
        commandsRegistered: true,
      }),
    }));
    return buildPluginContext({ logger: silent, resolve: container.resolve.bind(container) });
  };

  /**
   * The host resolves a plugin's dependencies in `init` and only then
   * attaches its event subscriptions, so a hand-driven dispatch has to
   * run the same two steps in the same order.
   */
  const initedPlugin = async (
    registry: GuildRegistry,
    policy: PermissionRankPolicy,
  ): Promise<{
    plugin: ReturnType<typeof createGuildEventsPlugin>;
    ctx: ReturnType<typeof buildCtx>;
  }> => {
    // These cases are about rank gating, not caching. Disabling the
    // cache keeps them on the download path they were written for and
    // stops them reading the developer's real `data/` tree.
    const plugin = createGuildEventsPlugin({ attachment_cache: { enabled: false } });
    const ctx = buildCtx(registry, policy);
    await plugin.init?.(ctx);
    return { plugin, ctx };
  };

  type ChannelStub = { parentId: string | null };
  const NO_LOOKUP = { get: (): ChannelStub | undefined => undefined };

  // `lookup` resolves intermediate ancestors so the effective-rank walk can
  // climb past the immediate parent (thread → channel → category).
  const message = (
    channelId: string,
    content: string,
    parentId: string | null = null,
    lookup: { get: (id: string) => ChannelStub | undefined } = NO_LOOKUP,
  ): Message =>
    buildMessage({
      content,
      guild: { id: 'g1', name: 'Guild', channels: { cache: lookup } },
      channel: { id: channelId, parentId },
    });

  type AttachmentStub = { id: string; name: string; url: string; contentType: string | null };

  // A delete/edit message carrying attachments — drives the archival and the
  // attachment-metadata audit assertions.
  const messageWithAttachments = (
    channelId: string,
    content: string,
    attachments: readonly AttachmentStub[],
  ): Message =>
    buildMessage({
      content,
      guild: { id: 'g1', name: 'Guild', channels: { cache: NO_LOOKUP } },
      channel: { id: channelId, parentId: null },
      attachments: new Collection(attachments.map((a) => [a.id, a])),
    });

  // A partial delete whose fetch() rejects ("Unknown Message", the usual case
  // for an uncached deletion) — proves the local record still runs on failure.
  const partialDeleteThatRejectsFetch = (channelId: string): Message =>
    buildMessage({
      content: null,
      guild: { id: 'g1', name: 'Guild', channels: { cache: NO_LOOKUP } },
      channel: { id: channelId, parentId: null },
      partial: true,
      fetch: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

  // `forum` is ranked so a thread under it (itself unlisted = rank 0) inherits
  // the parent's rank and is suppressed; `cat` proves the full-ancestry case.
  const policy = createPermissionRankPolicy({ g1: { channels: { private: 1, forum: 1, cat: 1 } } });

  const fireUpdate = async (
    channelId: string,
    channel: Channel,
    parentId: string | null = null,
    lookup?: { get: (id: string) => ChannelStub | undefined },
  ): Promise<void> => {
    const { plugin, ctx } = await initedPlugin(registryWith(channel), policy);
    const handler = plugin.events?.messageUpdate;
    if (handler === undefined) throw new Error('no messageUpdate handler');
    await handler(
      ctx,
      message(channelId, 'old', parentId, lookup) as Parameters<typeof handler>[1],
      message(channelId, 'new', parentId, lookup) as Parameters<typeof handler>[2],
    );
  };

  const fireDelete = async (channelId: string, channel: Channel): Promise<void> => {
    const { plugin, ctx } = await initedPlugin(registryWith(channel), policy);
    const handler = plugin.events?.messageDelete;
    if (handler === undefined) throw new Error('no messageDelete handler');
    await handler(ctx, message(channelId, 'gone') as Parameters<typeof handler>[1]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mirrors a message edit in a rank-0 (public) channel — embed AND audit fire', async () => {
    const { channel, send } = buildSendableChannel();
    await fireUpdate('public', channel);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    expect(payload.embeds[0]?.toJSON().color).toBe(0x5865f2);
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('does not disclose an edit above the ceiling but still records it locally', async () => {
    const { channel, send } = buildSendableChannel();
    await fireUpdate('private', channel);
    expect(send).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('does not disclose an edit in a thread under a ranked parent forum but still records it', async () => {
    const { channel, send } = buildSendableChannel();
    await fireUpdate('thread', channel, 'forum'); // thread rank 0, parent forum rank 1
    expect(send).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('does not disclose an edit in a thread nested under a private category but still records it', async () => {
    const { channel, send } = buildSendableChannel();
    // thread 'th' → channel 'ch-cat' (unlisted) → category 'cat' (rank 1); the
    // lookup resolves the intermediate channel so the walk reaches the category.
    const lookup = { get: (id: string) => (id === 'ch-cat' ? { parentId: 'cat' } : undefined) };
    await fireUpdate('th', channel, 'ch-cat', lookup);
    expect(send).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('does not disclose a delete above the ceiling but still records it locally', async () => {
    const { channel, send } = buildSendableChannel();
    await fireDelete('private', channel);
    expect(send).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('mirrors a message delete in a rank-0 channel — embed AND audit fire', async () => {
    const { channel, send } = buildSendableChannel();
    await fireDelete('public', channel);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    expect(payload.embeds[0]?.toJSON().color).toBe(0x99aab5);
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('archives a deleted attachment in a suppressed channel — disclosure withheld, file still saved', async () => {
    const { channel, send } = buildSendableChannel();
    const { plugin, ctx } = await initedPlugin(registryWith(channel), policy);
    const handler = plugin.events?.messageDelete;
    if (handler === undefined) throw new Error('no messageDelete handler');
    const att: AttachmentStub = {
      id: 'a1',
      name: 'secret.png',
      url: 'https://cdn.test/secret.png',
      contentType: 'image/png',
    };
    await handler(
      ctx,
      messageWithAttachments('private', 'gone', [att]) as Parameters<typeof handler>[1],
    );
    expect(send).not.toHaveBeenCalled(); // not disclosed to Discord
    expect(archiveDeletedAttachments).toHaveBeenCalledTimes(1); // binary archived
    expect(vi.mocked(archiveDeletedAttachments).mock.calls[0]?.slice(1, 3)).toEqual(['g1', 'm1']);
    expect(logGuildEvent).toHaveBeenCalledTimes(1); // audit recorded
  });

  it('records attachment metadata in the local audit for a suppressed edit', async () => {
    const { channel, send } = buildSendableChannel();
    const { plugin, ctx } = await initedPlugin(registryWith(channel), policy);
    const handler = plugin.events?.messageUpdate;
    if (handler === undefined) throw new Error('no messageUpdate handler');
    const att: AttachmentStub = {
      id: 'a1',
      name: 'f.bin',
      url: 'https://cdn.test/f.bin',
      contentType: 'application/octet-stream',
    };
    await handler(
      ctx,
      messageWithAttachments('private', 'old', [att]) as Parameters<typeof handler>[1],
      messageWithAttachments('private', 'new', [att]) as Parameters<typeof handler>[2],
    );
    expect(send).not.toHaveBeenCalled();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
    const details = vi.mocked(logGuildEvent).mock.calls[0]?.[3] as Record<string, unknown>;
    expect(details['attachments']).toEqual(['https://cdn.test/f.bin']);
  });

  it('still records a partial delete whose fetch rejects (no throw escapes the handler)', async () => {
    const { channel } = buildSendableChannel();
    const { plugin, ctx } = await initedPlugin(registryWith(channel), policy);
    const handler = plugin.events?.messageDelete;
    if (handler === undefined) throw new Error('no messageDelete handler');
    await expect(
      handler(ctx, partialDeleteThatRejectsFetch('public') as Parameters<typeof handler>[1]),
    ).resolves.toBeUndefined();
    expect(logGuildEvent).toHaveBeenCalledTimes(1);
  });

  it('records stable correlation ids (userId / channelId / messageId) in the delete audit', async () => {
    const { channel } = buildSendableChannel();
    await fireDelete('public', channel);
    const details = vi.mocked(logGuildEvent).mock.calls[0]?.[3] as Record<string, unknown>;
    expect(details).toMatchObject({ userId: 'u1', channelId: 'public', messageId: 'm1' });
  });
});
