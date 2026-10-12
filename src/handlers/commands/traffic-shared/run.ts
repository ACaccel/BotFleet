/**
 * The body every `/traffic` subcommand runs around its report: read the options,
 * admit the request (one report per member, one long range per guild), check the
 * guild wiring, defer (ephemerality is fixed at defer time), build the invoker's
 * visible channel set, and send the report. Every failure ends at one boundary: a
 * query timeout answers with the translated "try a smaller range" error, anything
 * else (a renderer throw too) with the `failed` copy and a trace ID.
 *
 * Only the report itself follows `visibility`; refusals, notices (no data, channel
 * not found) and errors always reach the invoker alone (see `answerPrivately`).
 */
import {
  MessageFlags,
  type AttachmentBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
} from 'discord.js';

import type { BaseBot } from '@bot';

import type { ArchiveChannelInfo } from '../../../core/archive/stats';
import type { DatabaseError } from '../../../core/errors/external-service-error';
import { replyForError } from '../../../infra/discord/reply-for-error';
import type { RemoteImageLoader } from '../../../infra/graphics/image-loader';
import type { Repos } from '../../../persistence/repositories';
import { lookupGuildRepos } from '../../require-guild-repos';

import { loadVisibleScope } from './allowed-channels';
import { trafficImageLoader, warnOnceWithoutEmojiFont } from './images';
import { admitReport } from './inflight';
import { answerPrivately } from './private-answer';
import { readTrafficOptions, type TrafficOptionSpec } from './options';
import { hostTimeZone, resolvePeriod, type Period } from './period';
import type { TFn, TrafficOptions } from './types';

export interface TrafficContext {
  readonly interaction: ChatInputCommandInteraction;
  readonly bot: BaseBot;
  readonly guild: Guild;
  /** The invoker; every visibility decision is theirs, never a counted member's. */
  readonly member: GuildMember;
  readonly repos: Repos;
  readonly t: TFn;
  readonly options: TrafficOptions;
  readonly period: Period;
  /** Channels the reply may count; empty for subcommands that count every channel. */
  readonly visible: ReadonlySet<string>;
  /** `archive_channels` records; empty for subcommands that count every channel. */
  readonly records: readonly ArchiveChannelInfo[];
  readonly images: RemoteImageLoader;
}

export type TrafficOutcome =
  | {
      readonly kind: 'reply';
      readonly embeds: readonly EmbedBuilder[];
      readonly files: readonly AttachmentBuilder[];
    }
  /** A translated one-line answer instead of a report, e.g. no data. */
  | { readonly kind: 'notice'; readonly key: string }
  /** A failed query; answered at the boundary like a thrown error. */
  | { readonly kind: 'error'; readonly error: DatabaseError };

export const failed = (error: DatabaseError): TrafficOutcome => ({ kind: 'error', error });

export interface TrafficActionSpec {
  readonly options: TrafficOptionSpec;
  /** `visible` applies the visibility filter; `all` counts every channel (emoji, stickers). */
  readonly scope: 'visible' | 'all';
  readonly build: (context: TrafficContext) => Promise<TrafficOutcome>;
}

const FAILED_KEY = 'replies:traffic.failed';

export const runTrafficAction = async (
  interaction: ChatInputCommandInteraction,
  bot: BaseBot,
  spec: TrafficActionSpec,
): Promise<void> => {
  const t: TFn = (key, params) => bot.translator?.t(key, params) ?? '';
  const options = readTrafficOptions(interaction, spec.options);
  const admission = admitReport(interaction.guildId ?? '', interaction.user.id, options.range);
  if (admission.kind === 'busy') {
    await interaction.reply({ content: t(admission.key), flags: MessageFlags.Ephemeral });
    return;
  }
  const isPublic = options.visibility === 'public';
  try {
    const guild = interaction.guild;
    if (!guild) {
      await answerPrivately(interaction, t('errors:command.guild_not_found'), false);
      return;
    }
    const lookup = lookupGuildRepos(bot, guild.id);
    const policy = bot.permissionRankPolicy;
    if (lookup.kind !== 'ready' || !policy) {
      const key = lookup.kind === 'ready' ? 'errors:db.not_configured' : lookup.key;
      const params = lookup.kind === 'ready' ? undefined : lookup.params;
      await answerPrivately(interaction, t(key, params), false);
      return;
    }
    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });
    const repos = lookup.repos;
    const member = await guild.members.fetch(interaction.user.id);
    let scoped: Pick<TrafficContext, 'records' | 'visible'> = { records: [], visible: new Set() };
    if (spec.scope === 'visible') {
      const result = await loadVisibleScope(repos, {
        guild,
        member,
        policy,
        mode: options.visibility,
        commandChannelId: interaction.channelId,
      });
      if (!result.ok) throw result.error;
      scoped = { records: result.records, visible: result.visible };
    }
    warnOnceWithoutEmojiFont(bot.logger);
    const outcome = await spec.build({
      interaction,
      bot,
      guild,
      member,
      repos,
      t,
      options,
      period: resolvePeriod(options.range, Date.now(), hostTimeZone()),
      ...scoped,
      images: trafficImageLoader(bot.logger),
    });
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'notice') {
      await answerPrivately(interaction, t(outcome.key), isPublic);
      return;
    }
    await interaction.editReply({
      embeds: [...outcome.embeds],
      files: [...outcome.files],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyForError(interaction, bot, error, FAILED_KEY, interaction.guild?.id, {
      privateAfterPublicReply: isPublic,
    });
  } finally {
    admission.release();
  }
};
