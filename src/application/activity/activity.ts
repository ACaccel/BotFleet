/**
 * Sign-up activity service: post an activity, let members join or leave
 * until its deadline, remind participants when it starts, record roll
 * calls taken from it, and rebuild its jobs after a restart.
 *
 * Shared by the activity plugin (job reboot) and the command, button and
 * modal handlers, which may not import each other. The surface takes a
 * typed {@link ActivityDeps} bundle rather than the whole `BaseBot`.
 */
import type { Channel, Client, Guild, Message, SendableChannels } from 'discord.js';
import type { Job } from 'node-schedule';

import type { GuildLookup } from '../guild-lookup';
import { bindTranslator, withGuildContext, type Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import { JobManager, retryWithBackoff } from '@core/scheduling';
import type { ActivityInput } from '../../persistence/repositories/activity.repo';
import type { ActivityDoc } from '../../persistence/schemas/activity.schema';
import { renderActivity } from './activity-view';

export interface ActivityDeps {
  readonly client: Client;
  readonly registry: GuildLookup<'activity'>;
  readonly jobMap: Map<string, Job>;
  readonly logger: Logger;
  readonly translator: Translator | undefined;
}

/** Closed and cancelled activities stay this long for roll calls, then expire. */
const RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A start reminder later than this after a restart is skipped as stale. */
const STALE_REMINDER_MS = 60 * 60_000;
/** Discord accepts at most 100 user mentions per message. */
const MAX_PINGS = 100;

export const activityCloseJobKey = (id: string): string => `activity:close:${id}`;
export const activityStartJobKey = (id: string): string => `activity:start:${id}`;

const purgeAt = (now: number): Date => new Date(now + RETENTION_MS);

const resolveChannel = async (
  deps: ActivityDeps,
  guild: Guild,
  channelId: string,
): Promise<SendableChannels | null> => {
  const channel: Channel | null =
    guild.channels.cache.get(channelId) ??
    (await deps.client.channels.fetch(channelId).catch(() => null));
  return channel?.isSendable() ? channel : null;
};

/** Re-render the announcement from the stored state; best effort. */
export const refreshAnnouncement = async (
  deps: ActivityDeps,
  guildId: string,
  activityId: string,
): Promise<ActivityDoc | undefined> => {
  const repos = deps.registry.getRepos(guildId);
  const guild = deps.client.guilds.cache.get(guildId);
  if (!repos || !guild) return undefined;
  const found = await repos.activity.findByActivityId(activityId);
  if (!found.ok) throw found.error;
  const doc = found.value;
  if (!doc) return undefined;
  try {
    const channel = await resolveChannel(deps, guild, doc.channel_id);
    const message = await channel?.messages.fetch(doc.message_id);
    await message?.edit(renderActivity(doc, bindTranslator(deps.translator)));
  } catch (error) {
    logError(deps.logger, guildId, error);
  }
  return doc;
};

/** Ping up to 100 participants in the activity's channel. */
const announceToParticipants = async (
  deps: ActivityDeps,
  guild: Guild,
  doc: ActivityDoc,
  key: string,
): Promise<void> => {
  const channel = await resolveChannel(deps, guild, doc.channel_id);
  if (channel === null) return;
  const pinged = doc.participants.slice(0, MAX_PINGS);
  const t = bindTranslator(deps.translator);
  await channel.send({
    content: t(key, {
      title: doc.title,
      mentions: pinged.map((id) => `<@${id}>`).join(' ') || t('replies:activity.none'),
    }),
    allowedMentions: { users: pinged },
  });
};

/**
 * Close sign-ups: lock the list, update the announcement and ping the
 * final participants. Safe to call twice; only the first call announces.
 */
export const closeActivity = async (
  deps: ActivityDeps,
  guildId: string,
  activityId: string,
  now: number = Date.now(),
): Promise<boolean> => {
  new JobManager(deps.jobMap).cancel(activityCloseJobKey(activityId));
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return false;
  const finished = await repos.activity.finish(activityId, ['open'], 'closed', purgeAt(now));
  if (!finished.ok) throw finished.error;
  const doc = await refreshAnnouncement(deps, guildId, activityId);
  const guild = deps.client.guilds.cache.get(guildId);
  if (finished.value && doc && guild) {
    await announceToParticipants(deps, guild, doc, 'replies:activity.closed_announcement');
  }
  return finished.value;
};

/** Cancel an open or closed activity; its jobs stop and the post says so. */
export const cancelActivity = async (
  deps: ActivityDeps,
  guildId: string,
  activityId: string,
  now: number = Date.now(),
): Promise<boolean> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return false;
  const finished = await repos.activity.finish(
    activityId,
    ['open', 'closed'],
    'cancelled',
    purgeAt(now),
  );
  if (!finished.ok) throw finished.error;
  const jobs = new JobManager(deps.jobMap);
  jobs.cancel(activityCloseJobKey(activityId));
  jobs.cancel(activityStartJobKey(activityId));
  await refreshAnnouncement(deps, guildId, activityId);
  return finished.value;
};

/** Remind the participants that the activity is starting, once. */
const notifyStart = async (
  deps: ActivityDeps,
  guildId: string,
  activityId: string,
): Promise<void> => {
  const repos = deps.registry.getRepos(guildId);
  const guild = deps.client.guilds.cache.get(guildId);
  if (!repos || !guild) return;
  const found = await repos.activity.findByActivityId(activityId);
  if (!found.ok) throw found.error;
  const doc = found.value;
  if (!doc || doc.status === 'cancelled') return;
  const marked = await repos.activity.markStartNotified(activityId);
  if (!marked.ok) throw marked.error;
  if (marked.value) await announceToParticipants(deps, guild, doc, 'replies:activity.starting');
};

const detached = (deps: ActivityDeps, guildId: string, run: () => Promise<unknown>) => (): void => {
  void run().catch((error: unknown) => logError(deps.logger, guildId, error));
};

/** Schedule the deadline close and the start reminder still ahead of `now`. */
const scheduleJobs = (deps: ActivityDeps, guildId: string, doc: ActivityDoc, now: number): void => {
  const jobs = new JobManager(deps.jobMap, deps.logger);
  const status = doc.status ?? 'open';
  if (status === 'open') {
    if (doc.expired_at <= now) {
      detached(deps, guildId, () => closeActivity(deps, guildId, doc.activity_id))();
    } else {
      jobs.schedule(
        activityCloseJobKey(doc.activity_id),
        new Date(doc.expired_at),
        detached(deps, guildId, () => closeActivity(deps, guildId, doc.activity_id)),
      );
    }
  }
  if (typeof doc.starts_at === 'number' && !doc.start_notified && status !== 'cancelled') {
    if (doc.starts_at > now) {
      jobs.schedule(
        activityStartJobKey(doc.activity_id),
        new Date(doc.starts_at),
        detached(deps, guildId, () => notifyStart(deps, guildId, doc.activity_id)),
      );
    } else if (now - doc.starts_at <= STALE_REMINDER_MS) {
      detached(deps, guildId, () => notifyStart(deps, guildId, doc.activity_id))();
    }
  }
};

type CreateActivityOutcome =
  | { readonly status: 'created'; readonly activityId: string }
  | { readonly status: 'no_db' }
  | { readonly status: 'announce_failed' };

/**
 * Post the announcement, store the activity keyed by the message ID, and
 * schedule its jobs. A failed write withdraws the post, so no activity
 * is left without a record.
 */
export const createActivity = async (
  deps: ActivityDeps,
  guild: Guild,
  channel: SendableChannels,
  input: Omit<ActivityInput, 'activity_id' | 'message_id' | 'channel_id'>,
  now: number = Date.now(),
): Promise<CreateActivityOutcome> => {
  const repos = deps.registry.getRepos(guild.id);
  if (!repos) return { status: 'no_db' };
  const t = bindTranslator(deps.translator);
  let message: Message;
  try {
    message = await channel.send(renderActivity({ ...input, participants: [], attendance: [] }, t));
  } catch (error) {
    logError(deps.logger, guild.id, error);
    return { status: 'announce_failed' };
  }
  const created = await repos.activity.create({
    ...input,
    activity_id: message.id,
    message_id: message.id,
    channel_id: channel.id,
  });
  if (!created.ok) {
    await message.delete().catch(() => undefined);
    throw created.error;
  }
  scheduleJobs(deps, guild.id, created.value, now);
  return { status: 'created', activityId: message.id };
};

/** Record a roll call taken from the activity and show it on the post. */
export const recordAttendance = async (
  deps: ActivityDeps,
  guildId: string,
  activityId: string,
  present: readonly string[],
  total: number,
  now: number = Date.now(),
): Promise<void> => {
  const repos = deps.registry.getRepos(guildId);
  if (!repos) return;
  const added = await repos.activity.addAttendance(activityId, { at: now, present, total });
  if (!added.ok) throw added.error;
  await refreshAnnouncement(deps, guildId, activityId);
};

/** Rebuild every guild's activity jobs, closing any whose deadline passed while down. */
export const rebootActivityJobs = async (
  deps: ActivityDeps,
  recoveredGuildId?: string,
  now: number = Date.now(),
): Promise<void> => {
  const guildIds =
    recoveredGuildId === undefined ? deps.registry.listGuildIds() : [recoveredGuildId];
  await Promise.all(
    guildIds.map((guildId) =>
      withGuildContext(deps.translator, guildId, async () => {
        const repos = deps.registry.getRepos(guildId);
        if (!repos) return;
        try {
          const activities = await retryWithBackoff(async () => {
            const result = await repos.activity.listAll();
            if (!result.ok) throw result.error;
            return result.value;
          });
          for (const doc of activities) scheduleJobs(deps, guildId, doc, now);
        } catch (error) {
          logError(deps.logger, guildId, error);
        }
      }),
    ),
  );
};
