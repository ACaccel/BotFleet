/**
 * Two-way ticket relay: admins answer in the hub forum post and the bot
 * forwards it to the reporter's DMs; the reporter answers in DMs and the
 * bot forwards it to the post. All relayed text pings nobody.
 */
import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Message,
} from 'discord.js';

import { EMBED_COLORS } from '../../infra/discord/presentation-colors';
import { bindTranslator, type BoundTranslate } from '../../core/i18n';
import type { BugTicketDoc } from '../../persistence/schemas/bug-ticket.schema';
import {
  dmFooter,
  dmReporter,
  markInProgress,
  ticketNumberIn,
  ticketRepo,
  type BugReportDeps,
} from './tickets';

/** Admin messages starting with this are internal notes and stay in the post. */
const INTERNAL_NOTE_PREFIX = '//';
const DESCRIPTION_MAX = 4096;

/** Custom ID prefix of the "which ticket?" menu; the DM's message ID follows. */
const TICKET_PICK_MENU = 'bug_ticket_pick';

/** An embed carrying a relayed message, its attachments as links. */
const relayEmbed = (message: Message, author: string, footer: string, color: number) => {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: author })
    .setFooter({ text: footer });
  if (message.content.length > 0) embed.setDescription(message.content.slice(0, DESCRIPTION_MAX));
  const attachments = [...message.attachments.values()].map((file) => file.url);
  if (attachments.length > 0)
    embed.addFields({ name: '📎', value: attachments.join('\n').slice(0, 1024) });
  return embed;
};

/** Forward an admin's message in a ticket post to the reporter. */
export const relayAdminMessage = async (deps: BugReportDeps, message: Message): Promise<void> => {
  const thread = message.channel;
  if (message.author.bot || !thread.isThread() || thread.parentId !== deps.config.hub.channelId)
    return;
  if (message.content.startsWith(INTERNAL_NOTE_PREFIX)) return;
  const repo = await ticketRepo(deps);
  const found = await repo?.findByThread(thread.id);
  if (found === undefined) return;
  if (!found.ok) throw found.error;
  const ticket = found.value;
  if (!ticket || ticket.bot_id !== deps.botId || ticket.status === 'closed') return;

  const t = bindTranslator(deps.translator);
  const name = message.member?.displayName ?? message.author.displayName;
  const delivered = await dmReporter(
    deps,
    ticket.reporter_id,
    relayEmbed(
      message,
      t('replies:bug_report.from_admin', { name }),
      dmFooter(t, ticket.number),
      EMBED_COLORS.info,
    ),
  );
  await message.react(delivered ? '✅' : '⚠️').catch(() => undefined);
  if (delivered) await markInProgress(deps, thread, ticket);
};

/** Forward a reporter's DM into `ticket`'s post. */
export const relayDmToTicket = async (
  deps: BugReportDeps,
  dm: Message,
  ticket: BugTicketDoc,
  t: BoundTranslate,
): Promise<'relayed' | 'closed' | 'failed'> => {
  if (ticket.status === 'closed') return 'closed';
  const thread = await deps.client.channels.fetch(ticket.thread_id ?? '').catch(() => null);
  if (!thread?.isThread()) return 'failed';
  await thread.send({
    embeds: [
      relayEmbed(
        dm,
        t('replies:bug_report.from_reporter', { name: dm.author.displayName }),
        `#${String(ticket.number)}`,
        EMBED_COLORS.warning,
      ),
    ],
    allowedMentions: { parse: [] },
  });
  await dm.react('✅').catch(() => undefined);
  return 'relayed';
};

/** The ticket a DM replies to, by the footer of the bot's DM it quotes. */
const quotedTicketNumber = async (
  deps: BugReportDeps,
  dm: Message,
): Promise<number | undefined> => {
  const quotedId = dm.reference?.messageId;
  if (quotedId === undefined) return undefined;
  const quoted = await dm.channel.messages.fetch(quotedId).catch(() => null);
  if (quoted?.author.id !== deps.client.user?.id) return undefined;
  return ticketNumberIn(quoted?.embeds[0]?.footer?.text);
};

/**
 * Route a reporter's DM: to the ticket it replies to, else to their only
 * open ticket, else ask which ticket with a menu.
 */
export const relayReporterDm = async (deps: BugReportDeps, dm: Message): Promise<void> => {
  if (dm.author.bot || dm.guildId !== null) return;
  const repo = await ticketRepo(deps);
  if (repo === undefined) return;
  const t = bindTranslator(deps.translator);
  const answer = (key: string, params?: Record<string, string | number>) =>
    dm.reply({ content: t(`replies:bug_report.${key}`, params), allowedMentions: { parse: [] } });

  const quoted = await quotedTicketNumber(deps, dm);
  if (quoted !== undefined) {
    const found = await repo.findByNumber(deps.botId, quoted);
    if (!found.ok) throw found.error;
    const ticket = found.value;
    if (!ticket || ticket.reporter_id !== dm.author.id)
      return void (await answer('dm_unknown_ticket'));
    const outcome = await relayDmToTicket(deps, dm, ticket, t);
    if (outcome !== 'relayed')
      await answer(outcome === 'closed' ? 'dm_ticket_closed' : 'dm_relay_failed');
    return;
  }

  const open = await repo.listOpenByReporter(deps.botId, dm.author.id);
  if (!open.ok) throw open.error;
  const [only, ...others] = open.value;
  if (only === undefined) return void (await answer('dm_no_ticket'));
  if (others.length === 0) {
    const outcome = await relayDmToTicket(deps, dm, only, t);
    if (outcome !== 'relayed')
      await answer(outcome === 'closed' ? 'dm_ticket_closed' : 'dm_relay_failed');
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TICKET_PICK_MENU}|${dm.id}`)
    .setPlaceholder(t('replies:bug_report.pick_placeholder'))
    .addOptions(
      open.value.map((ticket) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`#${String(ticket.number)} ${ticket.title}`.slice(0, 100))
          .setValue(String(ticket.number)),
      ),
    );
  await dm.reply({
    content: t('replies:bug_report.pick_prompt'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    allowedMentions: { parse: [] },
  });
};
