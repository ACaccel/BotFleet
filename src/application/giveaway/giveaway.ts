/**
 * Giveaway announcement, scheduling and reboot service.
 *
 * Shared by the giveaway plugin (job reboot) and the slash-command
 * handlers, which may not import each other; both reach it here in the
 * application layer. The surface takes a typed {@link GiveawayDeps} bundle rather
 * than the whole `BaseBot`: the plugin resolves it through the IoC
 * container (`ctx.resolve(...)`), and the handlers build it from their
 * `BaseBot` reference (`deps-from-bot.ts` beside them).
 */
import { randomInt } from 'node:crypto';

import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import type { Client, Guild, GuildMember, Channel, MessageReaction } from 'discord.js';
import { EmbedBuilder, time, TimestampStyles } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildLookup } from '../guild-lookup';
import { bindTranslator } from '../../core/i18n';
import type { Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import type { Message } from 'discord.js';

import { JobManager, retryWithBackoff } from '@core/scheduling';

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
  readonly registry: GuildLookup<'giveaway'>;
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
 * i18n key so no raw English reason reaches a localised reply.
 */
type DeleteGiveawayOutcome =
  | { readonly status: 'deleted' }
  | { readonly status: 'guild_not_found' }
  | { readonly status: 'no_db' }
  | { readonly status: 'giveaway_not_found' }
  | { readonly status: 'forbidden' };

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
        // Discord renders timestamps in each reader's own time zone.
        value: `${time(end_time_date, TimestampStyles.LongDateTime)} (${time(end_time_date, TimestampStyles.RelativeTime)})`,
      },
      {
        name: t('replies:giveaway.announce_field_description'),
        value: description || t('replies:common.empty_value'),
      },
    )
    .setColor(EMBED_COLORS.celebration)
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
  const participants =
    reaction === undefined ? [] : await fetchParticipants(guild, reaction, deps.logger);
  const winners = drawWinners(participants, giveaway.winner_num);

  const t = bindTranslator(deps.translator);
  const resultContent =
    winners.length > 0
      ? t('replies:giveaway.result_with_winners', {
          prize: giveaway.prize,
          winners: winners.map((w) => `<@${w.id}>`).join('\n'),
          ownerId: giveaway.prize_owner_id,
        })
      : t('replies:giveaway.result_no_participants', { prize: giveaway.prize });
  // The prize is member-written; only the winners and the owner may be pinged.
  await giveawayChannel.send({
    content: resultContent,
    allowedMentions: {
      users: winners.length > 0 ? [...winners.map((w) => w.id), giveaway.prize_owner_id] : [],
    },
  });

  const deleteResult = await repos.giveaway.deleteByMessageId(message_id);
  if (!deleteResult.ok) throw deleteResult.error;
  new JobManager(deps.jobMap).cancel(giveawayJobKey(message_id));
  return { status: 'completed' };
};

/**
 * Cancel a giveaway: drop its job and record, and mark the announcement
 * cancelled so members stop entering. `canCancel` decides from the
 * record's owner whether the requester may cancel it.
 */
export const deleteGiveaway = async (
  deps: GiveawayDeps,
  guild_id: string,
  message_id: string,
  canCancel: (ownerId: string) => boolean = () => true,
): Promise<DeleteGiveawayOutcome> => {
  const guild = deps.client.guilds.cache.get(guild_id);
  if (!guild) return { status: 'guild_not_found' };
  const repos = deps.registry.getRepos(guild_id);
  if (!repos) return { status: 'no_db' };

  // An `err` is re-thrown for the caller's surrounding catch.
  const found = await repos.giveaway.findByMessageId(message_id);
  if (!found.ok) throw found.error;
  const giveaway = found.value;
  if (!giveaway) return { status: 'giveaway_not_found' };
  if (!canCancel(giveaway.prize_owner_id)) return { status: 'forbidden' };

  new JobManager(deps.jobMap).cancel(giveawayJobKey(message_id));
  const deleteResult = await repos.giveaway.deleteByMessageId(message_id);
  if (!deleteResult.ok) throw deleteResult.error;
  await markAnnouncementCancelled(deps, guild, giveaway.channel_id, message_id);
  return { status: 'deleted' };
};

/** Best effort: a deleted announcement or channel leaves nothing to mark. */
const markAnnouncementCancelled = async (
  deps: GiveawayDeps,
  guild: Guild,
  channelId: string,
  messageId: string,
): Promise<void> => {
  try {
    const channel =
      guild.channels.cache.get(channelId) ?? (await deps.client.channels.fetch(channelId));
    if (!channel?.isSendable()) return;
    const message = await channel.messages.fetch(messageId);
    const announced = message.embeds[0];
    if (announced === undefined) return;
    const t = bindTranslator(deps.translator);
    await message.edit({
      embeds: [
        EmbedBuilder.from(announced)
          .setColor(EMBED_COLORS.neutral)
          .setFooter({ text: t('replies:giveaway.cancelled_footer') }),
      ],
    });
    await message.reactions.removeAll().catch(() => undefined);
  } catch (error) {
    deps.logger.warn(
      { err: error, guildId: guild.id, messageId },
      'could not mark giveaway cancelled',
    );
  }
};

/** Discord pages reaction users 100 at a time. */
const REACTION_PAGE_SIZE = 100;

/** Every non-bot member who entered, fetching members the cache lacks. */
const fetchParticipants = async (
  guild: Guild,
  reaction: MessageReaction,
  logger: Logger,
): Promise<GuildMember[]> => {
  const userIds: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await reaction.users.fetch({ limit: REACTION_PAGE_SIZE, after });
    for (const user of page.values()) if (!user.bot) userIds.push(user.id);
    if (page.size < REACTION_PAGE_SIZE) break;
    after = page.lastKey();
  }
  const missing = userIds.filter((id) => !guild.members.cache.has(id));
  for (let i = 0; i < missing.length; i += REACTION_PAGE_SIZE) {
    await guild.members
      .fetch({ user: missing.slice(i, i + REACTION_PAGE_SIZE) })
      .catch((error: unknown) => logger.warn({ err: error }, 'could not fetch giveaway entrants'));
  }
  // Members who left the guild are not eligible.
  return userIds.flatMap((id) => guild.members.cache.get(id) ?? []);
};

/** Up to `count` distinct winners, each entrant equally likely (Fisher–Yates). */
export const drawWinners = <T>(entrants: readonly T[], count: number): T[] => {
  const pool = [...entrants];
  const picks = Math.min(count, pool.length);
  for (let i = 0; i < picks; i += 1) {
    const j = i + randomInt(pool.length - i);
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, picks);
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
  if (outcome.status === 'message_not_found' || outcome.status === 'channel_not_found') {
    // The announcement or its channel is gone, so the draw can never be announced.
    const removed = await deps.registry.getRepos(guildId)?.giveaway.deleteByMessageId(messageId);
    if (removed !== undefined && !removed.ok) throw removed.error;
  }
  deps.logger.warn(
    { guildId, messageId, outcome: outcome.status },
    'giveaway draw did not complete',
  );
};

const REBOOT_MAX_ATTEMPTS = 3;
const rebootRetry = <T>(op: () => Promise<T>): Promise<T> =>
  retryWithBackoff(op, REBOOT_MAX_ATTEMPTS);

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
              // Ended while the bot was down: draw now rather than drop it.
              await runGiveawayDraw(deps, guildId, g.message_id);
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
