/**
 * `/bug_report` tickets: each report becomes a post in the operator's hub
 * forum, and the reporter is answered by DM because the bot serves many
 * guilds. Shared by the bug-report plugin (relay, hub check) and the
 * command, modal, button and menu handlers.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type ForumChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';

import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import { asGuildId } from '../../core/ids';
import { bindTranslator, type BoundTranslate, type Translator } from '../../core/i18n';
import { logError, type Logger } from '../../core/logger';
import type { ConnectionManager } from '../../infra/mongo/connection-manager';
import {
  MongoBugTicketRepo,
  type BugTicketRepo,
} from '../../persistence/repositories/bug-ticket.repo';
import type {
  BugTicketDoc,
  BugTicketStatus,
  BugTicketType,
} from '../../persistence/schemas/bug-ticket.schema';
import type { BugReportConfig, BugTagKey } from './config';

export interface BugReportDeps {
  readonly client: Client;
  /** The ticket store in the hub guild's database; `undefined` without MongoDB. */
  readonly tickets: () => Promise<BugTicketRepo | undefined>;
  readonly botId: string;
  /** How the forum post names this bot, as the hub is shared between bots. */
  readonly botLabel: string;
  readonly config: BugReportConfig;
  readonly translator: Translator | undefined;
  readonly logger: Logger;
  readonly isAdmin: (userId: string) => boolean;
}

/** At most this many tickets per reporter may be open, one new one per cooldown. */
const MAX_OPEN_TICKETS = 3;
const CREATE_COOLDOWN_MS = 10 * 60_000;
const THREAD_NAME_MAX = 100;

const TICKET_BUTTON = { close: 'bug_ticket|close', reopen: 'bug_ticket|reopen' } as const;

/**
 * Open the ticket store in the hub guild's database. Tickets live there,
 * not in the reporter's guild, because one forum serves every guild.
 */
export const hubTicketStore =
  (connections: Pick<ConnectionManager, 'getConnection'> | undefined, hubGuildId: string) =>
  async (): Promise<BugTicketRepo | undefined> =>
    connections === undefined
      ? undefined
      : new MongoBugTicketRepo(await connections.getConnection(asGuildId(hubGuildId)));

/** The ticket store; `undefined` without MongoDB. */
export const ticketRepo = (deps: BugReportDeps): Promise<BugTicketRepo | undefined> =>
  deps.tickets();

/** The hub forum, or `null` when it is missing or not a forum. */
const fetchHub = async (deps: BugReportDeps): Promise<ForumChannel | null> => {
  const channel = await deps.client.channels.fetch(deps.config.hub.channelId).catch(() => null);
  return channel?.type === ChannelType.GuildForum ? channel : null;
};

/** IDs of the forum tags named for `keys` in the config; unknown names are skipped. */
const tagIds = (forum: ForumChannel, deps: BugReportDeps, keys: readonly BugTagKey[]): string[] =>
  keys.flatMap((key) => {
    const name = deps.config.tags[key];
    const tag = name === undefined ? undefined : forum.availableTags.find((t) => t.name === name);
    if (name !== undefined && tag === undefined) {
      deps.logger.warn({ tag: name }, 'bug_report: configured forum tag not found');
    }
    return tag === undefined ? [] : [tag.id];
  });

/** Footer every ticket DM carries; the ticket number is read back from it. */
export const dmFooter = (t: BoundTranslate, number: number): string =>
  t('replies:bug_report.dm_footer', { number });

/** The ticket number in a DM footer written by {@link dmFooter}. */
export const ticketNumberIn = (footer: string | undefined): number | undefined => {
  const match = footer === undefined ? null : /#(\d+)/.exec(footer);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** DM the reporter; `false` when their DMs are closed. */
export const dmReporter = async (
  deps: BugReportDeps,
  reporterId: string,
  embed: EmbedBuilder,
): Promise<boolean> => {
  try {
    const user = await deps.client.users.fetch(reporterId);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, reporterId }, 'bug_report: DM to reporter failed');
    return false;
  }
};

interface CreateTicketArgs {
  readonly reporter: User;
  readonly source: {
    readonly guildId: string;
    readonly guildName: string;
    readonly channelId: string;
  } | null;
  readonly type: BugTicketType;
  readonly title: string;
  readonly content: string;
  readonly now: number;
}

type CreateTicketOutcome =
  | { readonly status: 'created'; readonly number: number; readonly dmDelivered: boolean }
  | { readonly status: 'too_many'; readonly max: number }
  | { readonly status: 'cooldown'; readonly retryAt: number }
  | { readonly status: 'unavailable' };

const starterMessage = (args: CreateTicketArgs, number: number, t: BoundTranslate) => {
  const source = args.source;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.warning)
    .setTitle(`#${String(number)} ${args.title}`)
    .setDescription(args.content)
    .addFields(
      {
        name: t('replies:bug_report.field_type'),
        value: t(`replies:bug_report.type_${args.type}`),
        inline: true,
      },
      {
        name: t('replies:bug_report.field_reporter'),
        value: `<@${args.reporter.id}> (${args.reporter.id})`,
        inline: true,
      },
      {
        name: t('replies:bug_report.field_source'),
        value: source
          ? `${source.guildName} (${source.guildId}) <#${source.channelId}>`
          : t('replies:bug_report.source_dm'),
      },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_BUTTON.close)
      .setLabel(t('replies:bug_report.button_close'))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(TICKET_BUTTON.reopen)
      .setLabel(t('replies:bug_report.button_reopen'))
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
};

/**
 * Open a ticket: reserve its number, post it in the hub forum, then DM
 * the reporter. A failed post removes the reserved record.
 */
export const createTicket = async (
  deps: BugReportDeps,
  args: CreateTicketArgs,
): Promise<CreateTicketOutcome> => {
  const repo = await ticketRepo(deps);
  const forum = await fetchHub(deps);
  if (repo === undefined || forum === null) return { status: 'unavailable' };
  const open = await repo.listOpenByReporter(deps.botId, args.reporter.id);
  if (!open.ok) throw open.error;
  if (open.value.length >= MAX_OPEN_TICKETS) return { status: 'too_many', max: MAX_OPEN_TICKETS };
  const last = await repo.lastCreatedAt(deps.botId, args.reporter.id);
  if (!last.ok) throw last.error;
  if (last.value !== undefined && args.now - last.value < CREATE_COOLDOWN_MS) {
    return { status: 'cooldown', retryAt: last.value + CREATE_COOLDOWN_MS };
  }

  const created = await repo.createNumbered({
    bot_id: deps.botId,
    reporter_id: args.reporter.id,
    ...(args.source
      ? { source_guild_id: args.source.guildId, source_channel_id: args.source.channelId }
      : {}),
    type: args.type,
    title: args.title,
    created_at: args.now,
  });
  if (!created.ok) throw created.error;
  const number = created.value.number;
  const t = bindTranslator(deps.translator);
  let thread: ThreadChannel;
  try {
    thread = await forum.threads.create({
      name: `[${deps.botLabel}] #${String(number)} ${args.title}`.slice(0, THREAD_NAME_MAX),
      message: starterMessage(args, number, t),
      appliedTags: tagIds(forum, deps, [args.type, 'open']),
    });
  } catch (error) {
    await repo.deleteByNumber(deps.botId, number);
    throw error;
  }
  const linked = await repo.setThread(deps.botId, number, thread.id);
  if (!linked.ok) throw linked.error;

  const dmDelivered = await dmReporter(
    deps,
    args.reporter.id,
    new EmbedBuilder()
      .setColor(EMBED_COLORS.info)
      .setTitle(t('replies:bug_report.dm_created_title', { number, title: args.title }))
      .setDescription(t('replies:bug_report.dm_created_body'))
      .setFooter({ text: dmFooter(t, number) }),
  );
  if (!dmDelivered) {
    await repo.markDmFailed(deps.botId, number);
    await thread.send({ content: t('replies:bug_report.thread_dm_failed') }).catch(() => undefined);
  }
  return { status: 'created', number, dmDelivered };
};

/** Swap the status tag, keeping the type tag. */
const applyStatusTag = async (
  deps: BugReportDeps,
  thread: ThreadChannel,
  ticket: Pick<BugTicketDoc, 'type'>,
  status: BugTicketStatus,
): Promise<void> => {
  const forum = thread.parent;
  if (forum?.type !== ChannelType.GuildForum) return;
  await thread
    .setAppliedTags(tagIds(forum, deps, [ticket.type as BugTicketType, status]))
    .catch((error: unknown) => logError(deps.logger, deps.config.hub.guildId, error));
};

/** Move an open ticket to in-progress once an admin has answered. */
export const markInProgress = async (
  deps: BugReportDeps,
  thread: ThreadChannel,
  ticket: BugTicketDoc,
): Promise<void> => {
  if (ticket.status !== 'open') return;
  const repo = await ticketRepo(deps);
  const updated = await repo?.setStatus(deps.botId, ticket.number, 'in_progress');
  if (updated !== undefined && !updated.ok) throw updated.error;
  await applyStatusTag(deps, thread, ticket, 'in_progress');
};

/**
 * Close or reopen the ticket behind `thread`, tell the reporter, and lock
 * a closed post. Returns `false` when it was already in that state.
 */
export const setTicketClosed = async (
  deps: BugReportDeps,
  thread: ThreadChannel,
  ticket: BugTicketDoc,
  close: boolean,
  actorId: string,
  now: number,
): Promise<boolean> => {
  if ((ticket.status === 'closed') === close) return false;
  const repo = await ticketRepo(deps);
  if (repo === undefined) return false;
  const status: BugTicketStatus = close ? 'closed' : 'in_progress';
  const updated = await repo.setStatus(
    deps.botId,
    ticket.number,
    status,
    close ? { at: now, by: actorId } : undefined,
  );
  if (!updated.ok) throw updated.error;
  await applyStatusTag(deps, thread, ticket, status);
  const t = bindTranslator(deps.translator);
  await dmReporter(
    deps,
    ticket.reporter_id,
    new EmbedBuilder()
      .setColor(close ? EMBED_COLORS.neutral : EMBED_COLORS.info)
      .setTitle(
        t(close ? 'replies:bug_report.dm_closed' : 'replies:bug_report.dm_reopened', {
          number: ticket.number,
          title: ticket.title,
        }),
      )
      .setFooter({ text: dmFooter(t, ticket.number) }),
  );
  if (close) {
    await thread.setLocked(true).catch(() => undefined);
    await thread.setArchived(true).catch(() => undefined);
  } else {
    await thread.setArchived(false).catch(() => undefined);
    await thread.setLocked(false).catch(() => undefined);
  }
  return true;
};

const REQUIRED_HUB_PERMISSIONS = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  ManageThreads: PermissionFlagsBits.ManageThreads,
  AddReactions: PermissionFlagsBits.AddReactions,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
} as const;

/** Throw when the hub forum is missing or the bot lacks a permission it needs there. */
export const verifyHub = async (deps: BugReportDeps): Promise<void> => {
  const forum = await fetchHub(deps);
  if (forum === null) {
    throw new Error(`bug_report hub ${deps.config.hub.channelId} is not a reachable forum channel`);
  }
  const me = deps.client.user;
  const granted = me === null ? null : forum.permissionsFor(me);
  const missing = Object.entries(REQUIRED_HUB_PERMISSIONS)
    .filter(([, flag]) => granted?.has(flag) !== true)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`bug_report hub is missing permissions: ${missing.join(', ')}`);
  }
};
