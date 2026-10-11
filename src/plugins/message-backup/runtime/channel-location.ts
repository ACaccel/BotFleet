import {
  ChannelType,
  PermissionFlagsBits,
  Routes,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import type { ArchiveChannelHint, ArchiveSnapshot } from '../../../core/archive/types';
import { archiveAuthorKind } from '../../../core/archive/normalize';
import type { ArchivePolicyLocation } from '../../../core/archive/policy';
import type { DiscoveryLocation } from '../flow/discovery';
import {
  isProgrammerError,
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** Bot and webhook messages; policy rules for them may depend on the channel's parent. */
export const isAutomatedSource = (snapshot: ArchiveSnapshot): boolean => {
  const kind = archiveAuthorKind(snapshot);
  return kind === 'bot' || kind === 'webhook';
};
/**
 * Whether `@everyone` can view a channel. A private thread is visible only to its
 * members; other threads follow their parent. `undefined` when it cannot be told
 * (the channel or parent is not cached).
 */
export const everyoneCanView = (channel: GuildBasedChannel | undefined): boolean | undefined => {
  if (channel === undefined) return undefined;
  if (channel.isThread()) {
    if (channel.type === ChannelType.PrivateThread) return false;
    return everyoneCanView(channel.parent ?? undefined);
  }
  return channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
};

/** The channel details policy decisions and channel records need. */
export class ChannelLocator {
  public constructor(private readonly ctx: ArchiveWorkerContextFor<'client' | 'logger'>) {}

  /** Channel details from the client cache, captured with a live message or channel event. */
  public channelHint(channelId: string): ArchiveChannelHint | undefined {
    const channel = this.ctx.options.client.channels.cache.get(channelId);
    if (channel === undefined || channel.isDMBased()) return undefined;
    const visible = everyoneCanView(channel);
    return {
      name: channel.name,
      type: channel.type,
      ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
      ...(visible === undefined ? {} : { everyoneCanView: visible }),
    };
  }

  /**
   * The guild and parent a policy decision needs: from the captured channel details,
   * the client cache, or else `archive_channels` (never from the message itself).
   */
  public async channelLocation(
    state: ArchiveGuildState,
    channelId: string,
    hint: ArchiveChannelHint | undefined,
    needsParent: boolean,
  ): Promise<ArchivePolicyLocation> {
    const guildId = String(state.conn.guildId);
    const located = (parentId: string | null | undefined): ArchivePolicyLocation => ({
      guildId,
      ...(parentId === undefined || parentId === null ? {} : { parentId }),
    });
    const known = hint ?? this.channelHint(channelId);
    if (known !== undefined) return located(known.parentId);
    const stored = await state.repos.channels.channelParent(channelId);
    if (stored !== null || !needsParent) return located(stored?.parentId);
    // Bot and webhook rules may be scoped by parent; ask Discord for an unknown channel.
    try {
      const fetched = await this.ctx.scheduler.run(
        `channel:${channelId}`,
        'live',
        () =>
          this.ctx.options.client.rest.get(Routes.channel(channelId), {
            signal: state.signal.signal,
          }),
        {
          signal: state.signal.signal,
          guildId,
          resource: { route: 'channel', channelId: channelId },
        },
      );
      const parentId =
        typeof fetched === 'object' && fetched !== null && 'parent_id' in fetched
          ? fetched.parent_id
          : undefined;
      return located(typeof parentId === 'string' ? parentId : undefined);
    } catch (error) {
      if (isProgrammerError(error) || state.signal.signal.aborted) throw error;
      this.ctx.options.logger.warn(
        { guildId, channelId, err: error },
        'Archive channel parent unknown; parent-scoped policy rules do not match',
      );
      return located(undefined);
    }
  }

  /**
   * Live capture records a channel `archive_channels` does not hold yet, so a thread
   * created and deleted between two scans still has a name and parent.
   */
  public async registerChannel(
    state: ArchiveGuildState,
    channelId: string,
    hint: ArchiveChannelHint | undefined,
  ): Promise<void> {
    state.knownChannels ??= new Set(await state.repos.channels.listChannelIds());
    if (state.knownChannels.has(channelId)) return;
    await mutateArchive(state, () =>
      state.repos.channels.recordChannel({
        channelId,
        observedAt: Date.now(),
        initialAccess: 'readable',
        ...(hint ?? {}),
      }),
    );
    state.knownChannels.add(channelId);
  }

  public locationOf(state: ArchiveGuildState, channel: GuildBasedChannel): ArchivePolicyLocation {
    return {
      guildId: String(state.conn.guildId),
      ...(channel.parentId === null ? {} : { parentId: channel.parentId }),
    };
  }

  /** `everyoneCanView` of a discovered location; an uncached thread follows its cached parent. */
  public locationVisibility(guild: Guild, location: DiscoveryLocation): boolean | undefined {
    const cached = guild.channels.cache.get(location.id);
    if (cached !== undefined) return everyoneCanView(cached);
    if (location.type === ChannelType.PrivateThread) return false;
    if (
      (location.type === ChannelType.PublicThread ||
        location.type === ChannelType.AnnouncementThread) &&
      location.parentId !== undefined
    )
      return everyoneCanView(guild.channels.cache.get(location.parentId));
    return undefined;
  }
}
