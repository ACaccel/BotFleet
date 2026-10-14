/**
 * Button-based roll calls: post the list, let the called members check
 * in until a deadline or until closed, then mark who was absent. A roll
 * call taken from an activity records its attendance on the activity.
 *
 * Shared by the roll-call command, the activity and roll-call buttons,
 * and the activity plugin's reboot path.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  time,
  TimestampStyles,
  type Guild,
  type MessageEditOptions,
  type SendableChannels,
} from 'discord.js';

import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import { bindTranslator, type BoundTranslate } from '../../core/i18n';
import { logError } from '../../core/logger';
import { JobManager, retryWithBackoff } from '@core/scheduling';
import type { RollCallDoc } from '../../persistence/schemas/roll-call.schema';
import type { GuildLookup } from '../guild-lookup';
import { recordAttendance, type ActivityDeps } from '../activity/activity';

export interface RollCallDeps extends Omit<ActivityDeps, 'registry'> {
  readonly registry: GuildLookup<'rollCall' | 'activity'>;
}

/** Button custom IDs; `buttons/roll_call` routes on the second segment. */
const ROLL_CALL_BUTTON = { checkIn: 'roll_call|checkin', close: 'roll_call|close' } as const;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const DESCRIPTION_MAX = 4096;

const rollCallJobKey = (messageId: string): string => `roll-call:${messageId}`;

type RollCallView = Pick<
  RollCallDoc,
  'targets' | 'present' | 'closed' | 'deadline' | 'creator_id' | 'persona'
>;

/** The roll-call message for its current state. */
const renderRollCall = (
  view: RollCallView,
  t: BoundTranslate,
): Required<Pick<MessageEditOptions, 'embeds' | 'components'>> => {
  const present = new Set(view.present);
  const lines = view.targets.map((id) => `${present.has(id) ? '✅' : '⬜'} <@${id}>`);
  const embed = new EmbedBuilder()
    .setTitle(t('replies:roll_call.title', { persona: view.persona ?? '' }))
    .setColor(view.closed ? EMBED_COLORS.neutral : EMBED_COLORS.info)
    .setDescription(lines.join('\n').slice(0, DESCRIPTION_MAX))
    .addFields(
      {
        name: t('replies:roll_call.field_present'),
        value: `${String(present.size)} / ${String(view.targets.length)}`,
        inline: true,
      },
      { name: t('replies:roll_call.field_caller'), value: `<@${view.creator_id}>`, inline: true },
    );
  if (view.closed) {
    const absent = view.targets.filter((id) => !present.has(id));
    embed.addFields({
      name: t('replies:roll_call.field_absent'),
      value:
        absent
          .map((id) => `<@${id}>`)
          .join(' ')
          .slice(0, 1024) || t('replies:roll_call.none'),
    });
    embed.setFooter({ text: t('replies:roll_call.footer_closed') });
    return { embeds: [embed], components: [] };
  }
  if (typeof view.deadline === 'number') {
    embed.addFields({
      name: t('replies:roll_call.field_deadline'),
      value: time(Math.floor(view.deadline / 1000), TimestampStyles.RelativeTime),
      inline: true,
    });
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ROLL_CALL_BUTTON.checkIn)
      .setLabel(t('replies:roll_call.button_check_in'))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ROLL_CALL_BUTTON.close)
      .setLabel(t('replies:roll_call.button_close'))
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
};

const refresh = async (deps: RollCallDeps, guild: Guild, doc: RollCallDoc): Promise<void> => {
  try {
    const channel =
      guild.channels.cache.get(doc.channel_id) ??
      (await deps.client.channels.fetch(doc.channel_id).catch(() => null));
    if (!channel?.isSendable()) return;
    const message = await channel.messages.fetch(doc.message_id);
    await message.edit(renderRollCall(doc, bindTranslator(deps.translator)));
  } catch (error) {
    logError(deps.logger, guild.id, error);
  }
};

/**
 * Close a roll call, mark absentees, and record attendance on its
 * activity. Safe to call twice; only the first call records.
 */
export const closeRollCall = async (
  deps: RollCallDeps,
  guildId: string,
  messageId: string,
  now: number = Date.now(),
): Promise<boolean> => {
  new JobManager(deps.jobMap).cancel(rollCallJobKey(messageId));
  const repos = deps.registry.getRepos(guildId);
  const guild = deps.client.guilds.cache.get(guildId);
  if (!repos || !guild) return false;
  const closed = await repos.rollCall.close(messageId, new Date(now + RETENTION_MS));
  if (!closed.ok) throw closed.error;
  const found = await repos.rollCall.findByMessageId(messageId);
  if (!found.ok) throw found.error;
  const doc = found.value;
  if (!doc) return false;
  await refresh(deps, guild, doc);
  if (closed.value && doc.activity_id) {
    await recordAttendance(deps, guildId, doc.activity_id, doc.present, doc.targets.length, now);
  }
  return closed.value;
};

const scheduleClose = (deps: RollCallDeps, guildId: string, doc: RollCallDoc): void => {
  if (typeof doc.deadline !== 'number') return;
  const run = (): void => {
    void closeRollCall(deps, guildId, doc.message_id).catch((error: unknown) =>
      logError(deps.logger, guildId, error),
    );
  };
  if (doc.deadline <= Date.now()) run();
  else
    new JobManager(deps.jobMap, deps.logger).schedule(
      rollCallJobKey(doc.message_id),
      new Date(doc.deadline),
      run,
    );
};

interface StartRollCallArgs {
  readonly guild: Guild;
  readonly channel: SendableChannels;
  readonly creatorId: string;
  readonly targets: readonly string[];
  readonly persona: string;
  readonly activityId?: string;
  readonly deadline?: number;
}

/** Post a roll call that pings each called member once. */
export const startRollCall = async (
  deps: RollCallDeps,
  args: StartRollCallArgs,
): Promise<'started' | 'no_db'> => {
  const repos = deps.registry.getRepos(args.guild.id);
  if (!repos) return 'no_db';
  const t = bindTranslator(deps.translator);
  const view = {
    targets: [...args.targets],
    present: [],
    closed: false,
    creator_id: args.creatorId,
    persona: args.persona,
    ...(args.deadline === undefined ? {} : { deadline: args.deadline }),
  };
  const message = await args.channel.send({
    // Embeds never ping, so the call itself goes in the content.
    content: args.targets.map((id) => `<@${id}>`).join(' '),
    allowedMentions: { users: [...args.targets] },
    ...renderRollCall(view, t),
  });
  const created = await repos.rollCall.create({
    message_id: message.id,
    channel_id: args.channel.id,
    creator_id: args.creatorId,
    persona: args.persona,
    targets: args.targets,
    ...(args.activityId === undefined ? {} : { activity_id: args.activityId }),
    ...(args.deadline === undefined ? {} : { deadline: args.deadline }),
  });
  if (!created.ok) {
    await message.delete().catch(() => undefined);
    throw created.error;
  }
  scheduleClose(deps, args.guild.id, created.value);
  return 'started';
};

export type CheckInOutcome = 'checked_in' | 'already' | 'not_called' | 'closed' | 'not_found';

/** Check `userId` in and update the list. */
export const checkIn = async (
  deps: RollCallDeps,
  guildId: string,
  messageId: string,
  userId: string,
): Promise<CheckInOutcome> => {
  const repos = deps.registry.getRepos(guildId);
  const guild = deps.client.guilds.cache.get(guildId);
  if (!repos || !guild) return 'not_found';
  const changed = await repos.rollCall.checkIn(messageId, userId);
  if (!changed.ok) throw changed.error;
  const found = await repos.rollCall.findByMessageId(messageId);
  if (!found.ok) throw found.error;
  const doc = found.value;
  if (!doc) return 'not_found';
  if (changed.value) {
    await refresh(deps, guild, doc);
    return 'checked_in';
  }
  if (doc.closed) return 'closed';
  return doc.targets.includes(userId) ? 'already' : 'not_called';
};

/** Reschedule open roll calls' deadlines after a restart. */
export const rebootRollCalls = async (
  deps: RollCallDeps,
  recoveredGuildId?: string,
): Promise<void> => {
  const guildIds =
    recoveredGuildId === undefined ? deps.registry.listGuildIds() : [recoveredGuildId];
  await Promise.all(
    guildIds.map(async (guildId) => {
      const repos = deps.registry.getRepos(guildId);
      if (!repos) return;
      try {
        const open = await retryWithBackoff(async () => {
          const result = await repos.rollCall.listOpen();
          if (!result.ok) throw result.error;
          return result.value;
        });
        for (const doc of open) scheduleClose(deps, guildId, doc);
      } catch (error) {
        logError(deps.logger, guildId, error);
      }
    }),
  );
};
