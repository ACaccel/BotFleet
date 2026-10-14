/**
 * GuildEventsPlugin — records message edits/deletes and role changes, and
 * mirrors them to a guild's configured `event` channel.
 *
 *   - `messageCreate`: cache attachments to disk, best-effort and never
 *     gating the message. Discord purges the CDN object almost as soon as a
 *     message is deleted, so downloading at `messageDelete` usually 404s.
 *   - `messageUpdate` / `messageDelete`: when content changed (or on delete),
 *     record the event locally and mirror an embed; a delete also archives
 *     every attachment, from the cache when possible, else by download.
 *   - `messageDeleteBulk`: carries no hydrated content, so it mirrors nothing;
 *     it rescues cached attachments and records one audit line per rescued
 *     message before the cache expires them.
 *   - `guildMemberUpdate`: role-delta embed.
 *   - `guildCreate`: onboard the guild through {@link GuildOnboardingPort},
 *     so no plugin code reaches into `BaseBot` internals.
 *
 * Rank gates disclosure only: {@link PermissionRankPolicy} may suppress the
 * `event`-channel embed for a channel, but the local record (the
 * `logGuildEvent` audit line and attachment archival) runs unconditionally
 * for every non-bot guild message. Private channels are therefore fully
 * recorded server-side yet never mirrored to Discord.
 */
import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import {
  EmbedBuilder,
  type Guild,
  type Message,
  type PartialMessage,
  type Snowflake,
  type TextChannel,
} from 'discord.js';

import { TOKENS } from '../../bot/tokens';
import type { GuildRegistry } from '../../bot/guild-registry';
import type { Plugin } from '../../core/plugin';
import type { GuildOnboardingPort, PermissionRankPolicy } from '../../core/plugin';
import { logError, logGuildEvent, logSystem, type Logger } from '../../core/logger';
import {
  archiveDeletedAttachments,
  ancestorChannelIdsOf,
  createAttachmentCache,
  type AttachmentCache,
} from '../../infra/discord';
import { parseGuildEventsConfig } from './config';

const PLUGIN_ID = 'guild-events';
const PLUGIN_VERSION = '1.1.0';
const EVENT_CHANNEL = 'event';
const MAX_MESSAGE_PREVIEW = 1000;

/**
 * How often the expired-cache sweep runs. Hourly is fine granularity
 * against a TTL measured in hours and costs one directory walk.
 */
const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const truncate = (text: string): string =>
  text.length > MAX_MESSAGE_PREVIEW ? `${text.slice(0, MAX_MESSAGE_PREVIEW)}...` : text;

const resolveEventChannel = (registry: GuildRegistry, guildId: string): TextChannel | undefined => {
  const channel = registry.getChannel(guildId, EVENT_CHANNEL);
  if (channel === undefined) return undefined;
  // Use `isSendable()` — discord.js's narrowing predicate models
  // exactly the "this channel accepts .send" capability the embed
  // mirror needs.
  return channel.isSendable() ? (channel as TextChannel) : undefined;
};

/**
 * Mirror an embed to the event channel, swallowing send failures so a
 * misconfigured channel (perms revoked, channel deleted between cache
 * read and send) never suppresses the audit-log side effects that
 * follow. Without the swallow, a Discord-side rejection here would
 * abort the surrounding handler before the audit-log writes ran.
 *
 * The bot tag on the structured error line is ambient via the
 * logger's base bindings (`createBootstrapLogger` attaches `{ bot }`),
 * so no `clientId` parameter is threaded through.
 */
const safeSendEmbed = async (
  channel: TextChannel,
  embed: EmbedBuilder,
  logger: Logger | undefined,
  guildId: string,
  context: string,
): Promise<void> => {
  try {
    await channel.send({ embeds: [embed] });
  } catch (err: unknown) {
    logError(
      logger,
      guildId,
      new Error(`guild-events: failed to mirror ${context} embed: ${String(err)}`),
    );
  }
};

/** Everything the event handlers read, resolved once in `init`. */
interface GuildEventsDeps {
  readonly registry: GuildRegistry;
  readonly policy: PermissionRankPolicy;
  readonly onboardingPort: GuildOnboardingPort;
  /** The bot-root logger, not the plugin child: audit lines are per-guild. */
  readonly logger: Logger;
  /** Pre-delete attachment cache; `undefined` when the operator disabled it. */
  readonly cache: AttachmentCache | undefined;
}

/** Optional collaborators wired by the composition root / tests. */
interface CreateGuildEventsDeps {
  /**
   * Pre-delete attachment cache. Injectable (mirroring
   * `createSocialFeedPlugin`'s `platforms` seam) so tests drive the real
   * cache against a temporary directory instead of the production tree.
   */
  readonly cache?: AttachmentCache;
}

/**
 * The cache the handlers use: an injected one wins, otherwise one built
 * from config — and nothing at all when the operator disabled it, so a
 * disabled cache is an absent collaborator rather than a no-op object.
 */
const buildCache = (
  config: ReturnType<typeof parseGuildEventsConfig>,
  deps: CreateGuildEventsDeps,
  logger: Logger,
): AttachmentCache | undefined => {
  if (!config.attachment_cache.enabled) return undefined;
  return (
    deps.cache ??
    createAttachmentCache({
      ttlHours: config.attachment_cache.ttlHours,
      minFreeDiskMb: config.attachment_cache.minFreeDiskMb,
      logger,
    })
  );
};

/**
 * Build the guild-events plugin from its raw `guild_events` config
 * block. Suppression is decided per event by the
 * {@link PermissionRankPolicy} resolved in `init`; the block only
 * configures the pre-delete attachment cache.
 */
export const createGuildEventsPlugin = (
  rawConfig?: unknown,
  deps: CreateGuildEventsDeps = {},
): Plugin => {
  const config = parseGuildEventsConfig(rawConfig);
  let resolved: GuildEventsDeps | undefined;
  let sweepHandle: NodeJS.Timeout | undefined;
  let stopped = false;
  /** See the `init` contract in `core/plugin/types.ts`: unreachable. */
  const resolvedDeps = (): GuildEventsDeps => {
    if (resolved === undefined) {
      throw new TypeError('guild-events: event dispatched before init resolved dependencies');
    }
    return resolved;
  };

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,

    async init(ctx): Promise<void> {
      const logger = ctx.resolve(TOKENS.Logger);
      resolved = {
        registry: ctx.resolve(TOKENS.GuildRegistry),
        policy: ctx.resolve(TOKENS.PermissionRankPolicy),
        onboardingPort: ctx.resolve(TOKENS.GuildOnboardingPort),
        logger,
        cache: buildCache(config, deps, logger),
      };
    },

    /**
     * Start the TTL sweep. The first pass runs immediately so a restart
     * clears whatever expired while the bot was down, then a
     * self-rescheduling timer takes over (the `social-feed` loop
     * shape): a throw is logged and the loop always reschedules.
     */
    async onReady(ctx): Promise<void> {
      const { cache } = resolvedDeps();
      // A host that stops and restarts reuses this object; without the
      // reset the sweep would stay permanently disabled while the cache
      // kept writing.
      stopped = false;
      if (cache === undefined) {
        logSystem(ctx.logger, 'guild-events: attachment cache disabled; not sweeping');
        return;
      }
      const sweepOnce = async (): Promise<void> => {
        const removed = await cache.sweepExpired(ctx.clock.now());
        if (removed > 0) {
          logSystem(ctx.logger, `guild-events: swept ${String(removed)} expired attachment caches`);
        }
      };
      const scheduleNext = (): void => {
        if (stopped) return;
        sweepHandle = setTimeout(() => {
          void (async (): Promise<void> => {
            try {
              await sweepOnce();
            } catch (err: unknown) {
              logError(ctx.logger, null, err);
            } finally {
              scheduleNext();
            }
          })();
        }, CACHE_SWEEP_INTERVAL_MS);
      };
      try {
        await sweepOnce();
      } catch (err: unknown) {
        logError(ctx.logger, null, err);
      }
      scheduleNext();
    },

    /** Tolerates un-initialised state — see the `onShutdown` contract. */
    async onShutdown(): Promise<void> {
      stopped = true;
      if (sweepHandle !== undefined) {
        clearTimeout(sweepHandle);
        sweepHandle = undefined;
      }
    },

    events: {
      messageCreate: (_ctx, message) => {
        const { cache, logger } = resolvedDeps();
        // Fire-and-forget: the download must never delay the other
        // `messageCreate` subscribers. `store` swallows its failures.
        void cacheMessageAttachments(cache, logger, message);
      },
      messageUpdate: async (_ctx, oldMessage, newMessage) => {
        const { registry, policy, logger } = resolvedDeps();
        await handleMessageUpdate(registry, policy, logger, oldMessage, newMessage);
      },
      messageDelete: async (_ctx, message) => {
        await handleMessageDelete(resolvedDeps(), message);
      },
      messageDeleteBulk: async (_ctx, messages) => {
        const { cache, logger } = resolvedDeps();
        await handleMessageDeleteBulk(cache, logger, messages);
      },
      guildCreate: async (_ctx, guild) => {
        const { onboardingPort, logger } = resolvedDeps();
        await handleGuildCreate(onboardingPort, logger, guild);
      },
      guildMemberUpdate: async (_ctx, oldMember, newMember) => {
        const { registry, logger } = resolvedDeps();
        const guildId = newMember.guild.id;
        const eventChannel = resolveEventChannel(registry, guildId);
        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;
        const addedRoles = newRoles.filter((role) => !oldRoles.has(role.id));
        const removedRoles = oldRoles.filter((role) => !newRoles.has(role.id));
        if (addedRoles.size === 0 && removedRoles.size === 0) return;
        if (oldMember.partial) await oldMember.fetch();
        if (newMember.partial) await newMember.fetch();
        const addedRolesList = addedRoles.map((role) => `<@&${role.id}>`).join(', ');
        const removedRolesList = removedRoles.map((role) => `<@&${role.id}>`).join(', ');
        const addedRoleMentions = addedRoles.map((role) => `<@&${role.id}>`);
        const removedRoleMentions = removedRoles.map((role) => `<@&${role.id}>`);
        if (eventChannel !== undefined) {
          const embed = new EmbedBuilder()
            .setColor(EMBED_COLORS.info)
            .setTitle('Role Update')
            .setAuthor({
              name: newMember.user.username,
              iconURL: newMember.user.displayAvatarURL(),
            })
            .addFields(
              { name: 'user', value: `<@${newMember.user.id}>`, inline: true },
              {
                name: 'added roles',
                value: addedRolesList.length > 0 ? addedRolesList : 'No roles added',
                inline: true,
              },
              {
                name: 'removed roles',
                value: removedRolesList.length > 0 ? removedRolesList : 'No roles removed',
                inline: true,
              },
            )
            .setTimestamp();
          await safeSendEmbed(eventChannel, embed, logger, guildId, 'guild_member_update');
        }
        // Audit-log line, decoupled from the embed write so a missing
        // `event` channel does not suppress the audit trail.
        logGuildEvent(
          logger,
          guildId,
          'guild_member_update',
          {
            user: newMember.user.username,
            added: addedRoleMentions,
            removed: removedRoleMentions,
          },
          newMember.guild.name,
        );
      },
    },
  };
};

/**
 * Hydrate a partial message, tolerating a fetch rejection. A deleted
 * message's `fetch()` rejects with `Unknown Message`; swallowing it (after an
 * error line) lets the unconditional local-record path still run on whatever
 * the cache held, rather than aborting the whole handler. On `messageUpdate`
 * the content guards already ran before this call, so there the tolerance
 * covers attachment hydration rather than content. The narrowing of `guildId`
 * to a string is the caller's responsibility (the guards run first).
 */
const fetchPartialMessage = async (
  message: Message | PartialMessage,
  logger: Logger | undefined,
  guildId: string,
): Promise<void> => {
  if (!message.partial) return;
  try {
    await message.fetch();
  } catch (err: unknown) {
    logError(logger, guildId, err);
  }
};

const handleMessageUpdate = async (
  registry: GuildRegistry,
  policy: PermissionRankPolicy,
  logger: Logger | undefined,
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> => {
  // Relevance guards: skip when either content side is missing, identical, or
  // the author / guild is unresolvable. These also filter the partial-message
  // edge that pre-cache messages emit. They are relevance filters ("is there a
  // textual change worth recording at all"), not disclosure filters, so they
  // stay BEFORE the rank check; the guild guard also puts a guild id in hand.
  if (oldMessage.content === null || oldMessage.content === undefined) return;
  if (newMessage.content === null || newMessage.content === undefined) return;
  if (oldMessage.content === newMessage.content) return;
  if (newMessage.guild === null || newMessage.guildId === null) return;
  if (newMessage.author === null || oldMessage.author === null) return;
  if (newMessage.author.bot) return;

  // Hydrate partials before recording so the local audit captures full content
  // even for channels the embed mirror will skip.
  await fetchPartialMessage(oldMessage, logger, newMessage.guildId);
  await fetchPartialMessage(newMessage, logger, newMessage.guildId);

  // Rank gates DISCLOSURE only: a channel above the `guild_events` ceiling is
  // withheld from the Discord `event` channel but still recorded locally below.
  const suppressed = policy.isSuppressed(
    newMessage.guildId,
    'guild_events',
    oldMessage.channel.id,
    ancestorChannelIdsOf(oldMessage.channel, oldMessage.guild?.channels.cache),
  );

  if (!suppressed) {
    const eventChannel = resolveEventChannel(registry, newMessage.guildId);
    if (eventChannel !== undefined) {
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.info)
        .setTitle('Message Updated')
        .setAuthor({
          name: newMessage.author.displayName,
          iconURL: newMessage.author.displayAvatarURL(),
        })
        .addFields(
          { name: 'author', value: `<@${newMessage.author.id}>`, inline: true },
          { name: 'channel', value: `<#${newMessage.channel.id}>`, inline: true },
          { name: 'old message', value: truncate(oldMessage.content), inline: false },
          { name: 'new message', value: truncate(newMessage.content), inline: false },
        )
        .setTimestamp();
      await safeSendEmbed(eventChannel, embed, logger, newMessage.guildId, 'message_update');
    }
  }

  // Local audit record — unconditional, regardless of rank or event-channel
  // presence. Stable ids (`userId` / `channelId` / `messageId`) make the line
  // independently usable, since display / channel names change and collide.
  // `?.name` tolerates a channel missing from the cache.
  const channelName = newMessage.guild.channels.cache.get(newMessage.channel.id)?.name;
  const details: Record<string, unknown> = {
    user: newMessage.author.username,
    userId: newMessage.author.id,
    channel: channelName ?? '<unknown>',
    channelId: newMessage.channel.id,
    messageId: newMessage.id,
    oldMessage: oldMessage.content,
    newMessage: newMessage.content,
  };
  // Edits cannot add attachments via Discord and the message still exists, so
  // record only their metadata here — the binary archival is a delete concern.
  const updatedAttachmentUrls = newMessage.attachments.map((a) => a.url);
  if (updatedAttachmentUrls.length > 0) {
    details['attachments'] = updatedAttachmentUrls;
  }
  logGuildEvent(logger, newMessage.guildId, 'message_update', details, newMessage.guild.name);
};

/**
 * Cache a freshly created message's attachments so a later deletion can
 * archive them from disk. Bot authors and DMs are out of scope: the
 * archive only ever records non-bot guild messages.
 */
const cacheMessageAttachments = async (
  cache: AttachmentCache | undefined,
  logger: Logger | undefined,
  message: Message,
): Promise<void> => {
  if (cache === undefined) return;
  if (message.guildId === null) return;
  if (message.author.bot) return;
  if (message.attachments.size === 0) return;
  try {
    await cache.store(message.guildId, message.id, message.attachments.values());
  } catch (err: unknown) {
    logError(logger, message.guildId, err);
  }
};

/**
 * Rescue the cached attachments of a bulk-deleted batch. Discord emits
 * no per-message `messageDelete` for a bulk purge, so without this the
 * cached copies would sit untouched until the TTL sweep removed them.
 *
 * No embed and no message content: a bulk purge carries neither the
 * hydrated content the mirror would need nor a per-message disclosure
 * decision. What it does emit is one audit line per rescued message, so
 * every file the archive gains is reconcilable against the log rather
 * than appearing there unexplained.
 *
 * Only runs while the attachment cache is enabled — with it off there is
 * nothing local to rescue and a bulk purge leaves no archive, exactly as
 * before this path existed.
 */
const handleMessageDeleteBulk = async (
  cache: AttachmentCache | undefined,
  logger: Logger | undefined,
  messages: ReadonlyMap<Snowflake, Message | PartialMessage>,
): Promise<void> => {
  if (cache === undefined) return;
  for (const message of messages.values()) {
    const guildId = message.guildId;
    if (guildId === null) continue;
    // Isolated per message: a batch can carry a hundred, and one bad
    // entry must not abandon the rest of them.
    try {
      const archived = await cache.archiveCached(guildId, message.id);
      if (archived === 0) continue;
      logGuildEvent(
        logger,
        guildId,
        'message_delete',
        {
          channelId: message.channel.id,
          messageId: message.id,
          source: 'bulk',
          archivedAttachments: archived,
        },
        message.guild?.name ?? '<unknown>',
      );
    } catch (err: unknown) {
      logError(logger, guildId, err);
    }
  }
};

const handleMessageDelete = async (
  { registry, policy, logger, cache }: GuildEventsDeps,
  message: Message | PartialMessage,
): Promise<void> => {
  if (message.guild === null || message.guildId === null) return;
  if (message.author === null) return;
  if (message.author.bot) return;

  // Hydrate before reading content / attachments. A deleted message's
  // `fetch()` rejects with `Unknown Message`; the helper tolerates that so the
  // unconditional local record below still runs on the cached partial.
  await fetchPartialMessage(message, logger, message.guildId);

  // Rank gates DISCLOSURE only — see handleMessageUpdate. The local record
  // (attachment archival + audit line) runs regardless of this flag.
  const suppressed = policy.isSuppressed(
    message.guildId,
    'guild_events',
    message.channel.id,
    ancestorChannelIdsOf(message.channel, message.guild?.channels.cache),
  );

  const content =
    message.content === null || message.content === undefined || message.content.length === 0
      ? 'No content'
      : truncate(message.content);

  if (!suppressed) {
    const eventChannel = resolveEventChannel(registry, message.guildId);
    if (eventChannel !== undefined) {
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.neutral)
        .setTitle('Message Deleted')
        .setAuthor({
          name: message.author.displayName,
          iconURL: message.author.displayAvatarURL(),
        })
        .addFields(
          { name: 'author', value: `<@${message.author.id}>`, inline: true },
          { name: 'channel', value: `<#${message.channel.id}>`, inline: true },
          { name: 'message', value: content, inline: false },
        )
        .setTimestamp();
      if (message.attachments.size > 0) {
        message.attachments.forEach((attachment) => {
          if (attachment.contentType === null) return;
          if (attachment.contentType.includes('image')) {
            embed.setImage(attachment.url);
          } else {
            embed.addFields({ name: 'attachment', value: attachment.url, inline: false });
          }
        });
      }
      await safeSendEmbed(eventChannel, embed, logger, message.guildId, 'message_delete');
    }
  }

  // Local audit record — unconditional, regardless of rank or event-channel
  // presence, so deletions are traceable even for private channels and when
  // the mirror is offline. Stable ids correlate the line independently.
  //
  // Written BEFORE the archival: the record is the one thing that must always
  // survive, so nothing that touches the disk gets to run ahead of it.
  const channelName = message.guild.channels.cache.get(message.channel.id)?.name;
  const attachmentUrls = message.attachments.map((a) => a.url);
  const details: Record<string, unknown> = {
    user: message.author.username,
    userId: message.author.id,
    channel: channelName ?? '<unknown>',
    channelId: message.channel.id,
    messageId: message.id,
    message: message.content ?? '',
  };
  if (attachmentUrls.length > 0) {
    details['attachments'] = attachmentUrls;
  }
  logGuildEvent(logger, message.guildId, 'message_delete', details, message.guild.name);

  await archiveDeletedMessageAttachments(cache, logger, message);
};

/**
 * Archive a deleted message's attachments — unconditional, regardless of rank,
 * and for every attachment including images the embed separately previews.
 *
 * The cache comes first and without a network call: Discord purges the CDN
 * object nearly synchronously with the deletion, so a download started here
 * usually 404s.
 *
 * The download runs whenever the cache came up short of the message's own
 * attachment count, not only on a total miss: a partially cached message would
 * otherwise report a hit and quietly abandon the rest. It may re-archive a file
 * the cache already moved, and a duplicate forensic copy is much cheaper than a
 * missing one.
 */
const archiveDeletedMessageAttachments = async (
  cache: AttachmentCache | undefined,
  logger: Logger | undefined,
  message: Message | PartialMessage,
): Promise<void> => {
  const guildId = message.guildId;
  if (guildId === null) return;
  let archivedFromCache = 0;
  try {
    archivedFromCache = cache === undefined ? 0 : await cache.archiveCached(guildId, message.id);
  } catch (err: unknown) {
    logError(logger, guildId, err);
  }
  if (archivedFromCache < message.attachments.size) {
    // Fire-and-forget: the helper bounds its own concurrency and has its own
    // try/catch per file.
    void archiveDeletedAttachments(logger, guildId, message.id, message.attachments.values());
  }
};

/**
 * Onboard a freshly joined guild through the {@link GuildOnboardingPort}.
 *
 * The port owns the two infrastructure actions a new guild needs —
 * connecting its per-guild database and registering the bot's slash
 * commands. The plugin merely resolves the port and invokes it, so no
 * plugin code reaches into `BaseBot` internals.
 *
 * A failed onboarding is caught and logged rather than rethrown: the
 * dispatcher already isolates subscription failures, but onboarding is
 * a structural side effect (not user-facing) and the structured
 * operator log is the actionable record. Letting it escape would only
 * produce a less-contextual dispatcher-level error line.
 */
const handleGuildCreate = async (
  onboardingPort: GuildOnboardingPort,
  logger: Logger | undefined,
  guild: Guild,
): Promise<void> => {
  try {
    await onboardingPort.onboardGuild(guild.id);
    // Promoted from `logSystem` to `logGuildEvent` so the file sink
    // files it under `logs/<bot>/<guildId>/` rather than the bot-root
    // directory — the line is per-guild by definition.
    logGuildEvent(
      logger,
      guild.id,
      'guild_create',
      {
        guildId: guild.id,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
      },
      guild.name,
    );
  } catch (err: unknown) {
    logSystem(
      logger,
      `guild-events: failed to onboard guild ${guild.name} (${guild.id}): ${String(err)}`,
    );
  }
};

/** Test-only access. Not part of the plugin's public API. */
export const __test = { safeSendEmbed, handleGuildCreate };
