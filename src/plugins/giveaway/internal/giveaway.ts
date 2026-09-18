/**
 * Giveaway reboot + scheduling internals.
 *
 * The public surface takes a typed {@link GiveawayDeps} bundle rather
 * than the whole `BaseBot`, so the plugin can resolve its dependencies
 * through the IoC container (`ctx.resolve(...)`) instead of closing
 * over the composition root's `this`.
 *
 * The slash-command handlers hold a `BaseBot` reference; they call
 * {@link buildGiveawayDepsFromBot} to bridge into this surface without
 * changing the handler signature.
 */
import type { Client, GuildMember, Channel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildRegistry } from '../../../bot/guild-registry';
import { bindTranslator } from '../../../core/i18n';
import type { Translator } from '../../../core/i18n';
import { logError, type Logger } from '../../../core/logger';
import type { Message } from 'discord.js';

import { JobManager } from '@core/scheduling';

const msgReact = async (
  logger: Logger,
  msg: Message,
  reactions: readonly string[],
): Promise<void> => {
  if (!msg || reactions.length === 0) return;
  for (const reaction of reactions) {
    try {
      await msg.react(reaction);
    } catch (error) {
      // Route through the structured logger so reaction failures are
      // observable.
      logger.error(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          messageId: msg.id,
          reaction,
        },
        'failed to add reaction to giveaway announcement message',
      );
    }
  }
};

export interface GiveawayDeps {
  readonly client: Client;
  readonly registry: GuildRegistry;
  readonly jobMap: Map<string, Job>;
  readonly logger: Logger;
  readonly translator: Translator | undefined;
}

export const giveawayJobKey = (message_id: string): string => `giveaway:${message_id}`;

/**
 * Outcome of {@link scheduleGiveaway} — the deferred draw that runs when
 * a giveaway's deadline arrives. Every non-`completed` variant names a
 * precondition that failed, so callers log a stable status instead of an
 * English sentence.
 */
type ScheduleGiveawayOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'guild_not_found' }
  | { readonly status: 'no_db' }
  | { readonly status: 'giveaway_not_found' }
  | { readonly status: 'channel_not_found' }
  | { readonly status: 'message_not_found' };

/**
 * Outcome of {@link deleteGiveaway}; the handler maps each variant to an
 * i18n key. A raw English reason string was previously interpolated
 * straight into the localised reply, so a zh-TW user saw
 * "無法刪除抽獎: Database not found".
 */
type DeleteGiveawayOutcome =
  | { readonly status: 'deleted' }
  | { readonly status: 'guild_not_found' }
  | { readonly status: 'no_db' };

export const giveawayAnnouncement = async (
  channel: Channel,
  prize: string,
  prize_owner_id: string,
  winner_num: number,
  end_time_date: Date,
  description: string,
  deps: GiveawayDeps,
): Promise<string | null> => {
  if (!channel.isSendable()) return null;

  const t = bindTranslator(deps.translator);

  const embed = new EmbedBuilder()
    .setTitle(t('replies:giveaway.announce_title', { prize }))
    .addFields(
      { name: t('replies:giveaway.announce_field_owner'), value: `<@${prize_owner_id}>` },
      { name: t('replies:giveaway.announce_field_winners'), value: winner_num.toString() },
      {
        name: t('replies:giveaway.announce_field_endtime'),
        value: end_time_date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      },
      {
        name: t('replies:giveaway.announce_field_description'),
        value: description || t('replies:common.empty_value'),
      },
    )
    .setColor('#F9F900')
    .setFooter({ text: t('replies:giveaway.announce_footer') });

  const message = await channel.send({ embeds: [embed] });
  if (!message) return null;
  else {
    void msgReact(deps.logger, message, ['🎉']);
    return message.id;
  }
};

export const findGiveaway = async (
  deps: GiveawayDeps,
  guild_id: string,
  message_id: string,
): Promise<boolean> => {
  const guild = deps.client.guilds.cache.get(guild_id);
  if (!guild) return false;
  const repos = deps.registry.getRepos(guild_id);
  if (!repos) return false;
  // Repo methods return Result<T, DatabaseError>. An `err` is
  // re-thrown so the caller's surrounding catch handles it.
  const result = await repos.giveaway.findByMessageId(message_id);
  if (!result.ok) throw result.error;
  return result.value !== undefined && result.value !== null;
};

export const scheduleGiveaway = async (
  deps: GiveawayDeps,
  guild_id: string,
  message_id: string,
): Promise<ScheduleGiveawayOutcome> => {
  const guild = deps.client.guilds.cache.get(guild_id);
  if (!guild) return { status: 'guild_not_found' };
  const repos = deps.registry.getRepos(guild_id);
  if (!repos) return { status: 'no_db' };

  // An `err` is re-thrown for the caller's surrounding catch.
  const giveawayResult = await repos.giveaway.findByMessageId(message_id);
  if (!giveawayResult.ok) throw giveawayResult.error;
  const giveaway = giveawayResult.value;
  if (!giveaway) return { status: 'giveaway_not_found' };
  // The saved announcement channel may be a thread or a channel that is not
  // in `guild.channels.cache` after a restart (threads in particular
  // are not all delivered on GUILD_CREATE). Fall back to an API fetch
  // so a persisted `channel_id` the cache cannot resolve does not
  // strand the winner draw on reboot.
  const giveawayChannel =
    guild.channels.cache.get(giveaway.channel_id) ??
    (await deps.client.channels.fetch(giveaway.channel_id).catch(() => null));
  if (!giveawayChannel?.isSendable()) return { status: 'channel_not_found' };

  const message = await giveawayChannel.messages.fetch(message_id).catch(() => null);
  if (!message) return { status: 'message_not_found' };

  const reaction = message.reactions.cache.get('🎉');
  const users = await reaction?.users.fetch().catch(() => null);

  const participantsMembers: GuildMember[] = [];
  if (users) {
    for (const [, user] of users) {
      if (user.bot) continue;
      const member = guild.members.cache.get(user.id);
      if (member) {
        participantsMembers.push(member);
      }
    }
  }
  const participantsArray = participantsMembers;

  let winners: GuildMember[] = [];
  if (participantsArray.length > 0) {
    const shuffled = [...participantsArray].sort(() => 0.5 - Math.random());
    winners = shuffled.slice(0, Math.min(giveaway.winner_num, shuffled.length));
  }

  const t = bindTranslator(deps.translator);
  const resultContent =
    winners.length > 0
      ? t('replies:giveaway.result_with_winners', {
          prize: giveaway.prize,
          winners: winners.map((w) => `<@${w.id}>`).join('\n'),
          ownerId: giveaway.prize_owner_id,
        })
      : t('replies:giveaway.result_no_participants', { prize: giveaway.prize });
  await giveawayChannel.send({ content: resultContent });

  const deleteResult = await repos.giveaway.deleteByMessageId(message_id);
  if (!deleteResult.ok) throw deleteResult.error;
  new JobManager(deps.jobMap).cancel(giveawayJobKey(message_id));
  return { status: 'completed' };
};

export const deleteGiveaway = async (
  deps: GiveawayDeps,
  guild_id: string,
  message_id: string,
): Promise<DeleteGiveawayOutcome> => {
  const guild = deps.client.guilds.cache.get(guild_id);
  if (!guild) return { status: 'guild_not_found' };
  const repos = deps.registry.getRepos(guild_id);
  if (!repos) return { status: 'no_db' };

  new JobManager(deps.jobMap).cancel(giveawayJobKey(message_id));
  // An `err` is re-thrown for the caller's surrounding catch.
  const deleteResult = await repos.giveaway.deleteByMessageId(message_id);
  if (!deleteResult.ok) throw deleteResult.error;
  return { status: 'deleted' };
};

/**
 * Run a deferred draw, recording a non-success outcome on the operator
 * channel. The job callback has no user to answer, so a silent return
 * would make a missing channel or message indistinguishable from a
 * completed draw.
 */
export const runGiveawayDraw = async (
  deps: GiveawayDeps,
  guildId: string,
  messageId: string,
): Promise<void> => {
  const outcome = await scheduleGiveaway(deps, guildId, messageId);
  if (outcome.status === 'completed') return;
  deps.logger.warn(
    { guildId, messageId, outcome: outcome.status },
    'giveaway draw did not complete',
  );
};

/**
 * Same exponential-backoff retry as `activity.rebootRetry`. Without
 * it, a transient Mongo blip during boot would silently leave the
 * guild's scheduled giveaways un-rebuilt for the process lifetime.
 */
const REBOOT_MAX_ATTEMPTS = 3;
const rebootRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < REBOOT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt < REBOOT_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
};

export const rebootGiveawayJobs = async (
  deps: GiveawayDeps,
  recoveredGuildId?: string,
): Promise<void> => {
  const jobManager = new JobManager(deps.jobMap, deps.logger);
  const guildIds =
    recoveredGuildId === undefined ? deps.registry.listGuildIds() : [recoveredGuildId];
  await Promise.all(
    guildIds.map(async (guildId) => {
      try {
        const repos = deps.registry.getRepos(guildId);
        if (!repos) return;
        // listAll returns Result<T, DatabaseError>. Throw the `err`
        // inside the retried op so `rebootRetry`'s backoff treats a
        // transient DB failure as retryable.
        const giveaways = await rebootRetry(async () => {
          const result = await repos.giveaway.listAll();
          if (!result.ok) throw result.error;
          return result.value;
        });
        for (const g of giveaways) {
          try {
            const end_time = new Date(g.end_time);
            if (end_time > new Date()) {
              jobManager.schedule(giveawayJobKey(g.message_id), end_time, async () => {
                if (await findGiveaway(deps, guildId, g.message_id)) {
                  await runGiveawayDraw(deps, guildId, g.message_id);
                }
              });
            } else {
              await rebootRetry(() => deleteGiveaway(deps, guildId, g.message_id));
            }
          } catch (rowErr) {
            logError(deps.logger, guildId, rowErr);
          }
        }
      } catch (err) {
        logError(deps.logger, guildId, err);
        const debugCh = deps.registry.getChannel(guildId, 'debug');
        if (debugCh?.isSendable()) {
          await debugCh
            .send(
              `[ ops ] giveaway reboot listAll failed for guild ${guildId} after ${REBOOT_MAX_ATTEMPTS} attempts; scheduled jobs may be missing until next restart.`,
            )
            .catch((sendErr) => logError(deps.logger, guildId, sendErr));
        }
      }
    }),
  );
};
