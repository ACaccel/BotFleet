/**
 * Identity-sync routine: applies the bot's avatar + per-guild nickname,
 * either by mirroring a source user (sync mode) or from a static fallback.
 *
 * Free of scheduling and IoC so it is unit-testable with a fake client; the
 * plugin owns the schedule and the cross-run {@link IdentitySyncState}.
 *
 * Nickname semantics: in sync mode the bot mirrors the source user's
 * PER-GUILD display name (`GuildMember.displayName` = nickname ?? global
 * name), resolved separately in each guild — NOT the source's global
 * `User.displayName`. The avatar is necessarily global
 * (`ClientUser.setAvatar` is account-wide), so it mirrors the source user's
 * global avatar.
 *
 * Avatar rate-limit discipline: Discord throttles `PATCH /users/@me`
 * aggressively, so the avatar is only re-uploaded when it would actually
 * change. In sync mode the source user's avatar HASH is tracked (the bot's
 * own re-hashed avatar would never match it). In fallback mode a one-shot
 * marker prevents re-uploading the same local file on every daily tick.
 */
import type { Client, Guild, GuildMember } from 'discord.js';

import { logError, type Logger } from '../../../core/logger';
import type { IdentitySyncPluginConfig } from '../config';

/** Cross-run state owned by the plugin and threaded through each run. */
export interface IdentitySyncState {
  /** Hash of the source avatar last applied (sync mode); null when none. */
  lastSourceAvatarHash: string | null;
  /** Whether the fallback avatar has already been uploaded this process. */
  fallbackApplied: boolean;
}

interface IdentitySyncDeps {
  readonly client: Client;
  readonly config: IdentitySyncPluginConfig;
  readonly logger: Logger;
}

const AVATAR_OPTS = { extension: 'png', size: 1024 } as const;

/** Resolve the bot's member in a guild, fetching it when not cached. */
const resolveSelfMember = async (guild: Guild): Promise<GuildMember> =>
  guild.members.me ?? (await guild.members.fetchMe());

/**
 * Set the bot's nickname in every guild to the value `nicknameFor(guild)`
 * returns, skipping a null/empty target or a no-op change. Each guild is
 * isolated: one guild's missing permission (or a source member not present
 * there) must not abort the rest.
 */
const applyNicknames = async (
  client: Client,
  nicknameFor: (guild: Guild) => Promise<string | null>,
  logger: Logger,
): Promise<void> => {
  for (const guild of client.guilds.cache.values()) {
    try {
      const desired = await nicknameFor(guild);
      if (desired === null || desired.length === 0) continue;
      const me = await resolveSelfMember(guild);
      if (me.nickname !== desired) {
        await me.setNickname(desired);
      }
    } catch (err: unknown) {
      logError(logger, guild.id, err);
    }
  }
};

export const runIdentitySync = async (
  deps: IdentitySyncDeps,
  state: IdentitySyncState,
): Promise<void> => {
  const { client, config, logger } = deps;
  const self = client.user;
  if (self === null) return; // not logged in yet

  if (config.syncWithSource) {
    if (config.syncNickname) {
      // The source user's per-guild server nickname, resolved per guild.
      // A source member absent from a guild yields null -> that guild skips.
      await applyNicknames(
        client,
        async (guild) => {
          const member = await guild.members.fetch(config.sourceUserId).catch(() => null);
          return member?.displayName ?? null;
        },
        logger,
      );
    }
    if (config.syncAvatar) {
      const user = await client.users.fetch(config.sourceUserId).catch((err: unknown) => {
        logError(logger, null, err);
        return null;
      });
      if (user !== null && user.avatar !== state.lastSourceAvatarHash) {
        try {
          await self.setAvatar(user.displayAvatarURL(AVATAR_OPTS));
          state.lastSourceAvatarHash = user.avatar;
          state.fallbackApplied = false;
        } catch (err: unknown) {
          logError(logger, null, err);
        }
      }
    }
    return;
  }

  // Fallback mode: static identity.
  if (config.syncNickname) {
    await applyNicknames(client, async () => config.fallbackNickname, logger);
  }
  if (config.syncAvatar && !state.fallbackApplied) {
    try {
      await self.setAvatar(config.fallbackAvatarPath);
      state.fallbackApplied = true;
      state.lastSourceAvatarHash = null;
    } catch (err: unknown) {
      logError(logger, null, err);
    }
  }
};
