/**
 * A single document: indented JSON, attached when long. Archived messages
 * show author, channel, time and content; their full JSON is attached.
 */
import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from 'discord.js';

import { idString, toJson, valueAt } from '../../../application/db-inspect/display';
import type { DocumentView } from '../../../application/db-inspect/service';
import type { BoundTranslate } from '../../../core/i18n';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';

import {
  EMBED_DESCRIPTION_LIMIT,
  FIELD_VALUE_LIMIT,
  INLINE_JSON_LIMIT,
  codeBlock,
  dbReply,
  joinLines,
  safeFileName,
  truncate,
  type DbReply,
} from './text';
import { discordTime, timeOf } from './values';

const namesField = (names: ReadonlyMap<string, string>, t: BoundTranslate) =>
  names.size === 0
    ? undefined
    : {
        name: t('replies:db_inspect.document.names'),
        value: joinLines(
          [...names].map(([id, name]) => `\`${id}\` ${escapeMarkdown(name)}`),
          FIELD_VALUE_LIMIT,
        ),
      };

const messageEmbed = (view: DocumentView, t: BoundTranslate): EmbedBuilder => {
  const { document, names } = view;
  const text = (path: string): string | undefined => {
    const value = valueAt(document, path);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const authorId = text('author.id');
  const channelId = text('channelId');
  const created = timeOf(valueAt(document, 'createdTimestamp'));
  const deleted = timeOf(valueAt(document, 'deletedAt'));
  const attachments = valueAt(document, 'attachments');
  const urls = (Array.isArray(attachments) ? attachments : [])
    .map((entry) => (entry as { url?: unknown } | null)?.url)
    .filter((url): url is string => typeof url === 'string');
  const author = [text('author.username'), authorId === undefined ? undefined : `(${authorId})`]
    .filter((part) => part !== undefined)
    .join(' ');
  const embed = new EmbedBuilder()
    .setColor(deleted === undefined ? EMBED_COLORS.info : EMBED_COLORS.neutral)
    .setTitle(
      t('replies:db_inspect.document.title', {
        collection: view.collection,
        id: idString(document),
      }),
    )
    .setDescription(
      truncate(
        text('content') ?? t('replies:db_inspect.message.no_content'),
        EMBED_DESCRIPTION_LIMIT,
      ),
    )
    .addFields(
      {
        name: t('replies:db_inspect.message.author'),
        value: author.length === 0 ? '—' : escapeMarkdown(author),
        inline: true,
      },
      {
        name: t('replies:db_inspect.message.channel'),
        value:
          channelId === undefined
            ? '—'
            : `<#${channelId}> ${escapeMarkdown(names.get(channelId) ?? '')}`.trim(),
        inline: true,
      },
      {
        name: t('replies:db_inspect.message.time'),
        value: created === undefined ? '—' : discordTime(created),
        inline: true,
      },
    );
  if (deleted !== undefined) {
    embed.addFields({ name: t('replies:db_inspect.message.deleted'), value: discordTime(deleted) });
  }
  if (urls.length > 0) {
    embed.addFields({
      name: t('replies:db_inspect.message.attachments'),
      value: joinLines(urls, FIELD_VALUE_LIMIT),
    });
  }
  return embed;
};

export const buildDocumentReply = (
  view: DocumentView,
  guild: string,
  t: BoundTranslate,
): DbReply => {
  const json = toJson(view.document);
  const id = idString(view.document);
  const isMessage = view.collection === 'messages';
  const attach = isMessage || json.length > INLINE_JSON_LIMIT;
  const embed = isMessage
    ? messageEmbed(view, t)
    : new EmbedBuilder()
        .setColor(EMBED_COLORS.info)
        .setTitle(t('replies:db_inspect.document.title', { collection: view.collection, id }))
        .setDescription(
          attach ? t('replies:db_inspect.document.attached') : codeBlock('json', json),
        );
  embed.setFooter({ text: truncate(guild, 200) });
  const names = namesField(view.names, t);
  if (names !== undefined) embed.addFields(names);
  const files = attach
    ? [
        new AttachmentBuilder(Buffer.from(json, 'utf8'), {
          name: safeFileName('json', view.collection, id),
        }),
      ]
    : [];
  return dbReply([embed], { files });
};
