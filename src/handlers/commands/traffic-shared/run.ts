/**
 * The body every `/traffic` subcommand runs around its report: read the options,
 * admit the request (one report per member, one long range per guild), defer
 * (ephemerality is fixed at defer time), check the guild wiring, build the
 * invoker's visible channel set, and send the report. Every failure ends at one
 * boundary: a query timeout answers with the translated "try a smaller range"
 * error, anything else (a renderer throw too) with the `failed` copy and a trace ID.
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
  /** No full backup has completed yet, so member statistics are incomplete. */
  readonly rebuilding: boolean;
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
  try {
    await interaction.deferReply(
      options.visibility === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {},
    );
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: t('errors:command.guild_not_found') });
      return;
    }
    const lookup = lookupGuildRepos(bot, guild.id);
    const policy = bot.permissionRankPolicy;
    if (lookup.kind !== 'ready' || !policy) {
      const key = lookup.kind === 'ready' ? 'errors:db.not_configured' : lookup.key;
      const params = lookup.kind === 'ready' ? undefined : lookup.params;
      await interaction.editReply({ content: t(key, params) });
      return;
    }
    const repos = lookup.repos;
    const member = await guild.members.fetch(interaction.user.id);
    let scoped: Pick<TrafficContext, 'records' | 'visible' | 'rebuilding'> = {
      records: [],
      visible: new Set(),
      rebuilding: false,
    };
    if (spec.scope === 'visible') {
      const result = await loadVisibleScope(repos, {
        guild,
        member,
        policy,
        mode: options.visibility,
        commandChannelId: interaction.channelId,
      });
      if (!result.ok) throw result.error;
      scoped = { records: result.records, visible: result.visible, rebuilding: result.rebuilding };
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
      await interaction.editReply({ content: t(outcome.key) });
      return;
    }
    await interaction.editReply({
      embeds: [...outcome.embeds],
      files: [...outcome.files],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyForError(interaction, bot, error, FAILED_KEY, interaction.guild?.id);
  } finally {
    admission.release();
  }
};
