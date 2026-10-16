/** The `/db schema` reply: fields, indexes and the newest document. */
import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from 'discord.js';

import { toJson } from '../../../application/db-inspect/display';
import type { CollectionDescription } from '../../../application/db-inspect/service';
import type { BoundTranslate } from '../../../core/i18n';
import type { InspectField } from '../../../persistence/inspect/catalog';
import { EMBED_COLORS } from '../../../infra/discord/presentation-colors';

import {
  EMBED_DESCRIPTION_LIMIT,
  INLINE_JSON_LIMIT,
  codeBlock,
  dbReply,
  formatCount,
  joinLines,
  safeFileName,
  type DbReply,
} from './text';

const fieldLine = (field: InspectField, t: BoundTranslate): string => {
  const parts = [`\`${field.path}\``, field.type];
  if (field.indexed) parts.push(t('replies:db_inspect.indexed'));
  if (field.enumValues !== undefined) parts.push(field.enumValues.join(' | '));
  if (field.ref !== undefined) parts.push(`→ ${field.ref}`);
  return parts.join(' · ');
};

const sampleEmbed = (
  description: CollectionDescription,
  t: BoundTranslate,
  files: AttachmentBuilder[],
): EmbedBuilder => {
  if (description.sample === undefined) {
    return new EmbedBuilder()
      .setColor(EMBED_COLORS.neutral)
      .setDescription(t('replies:db_inspect.schema.no_sample'));
  }
  const json = toJson(description.sample);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:db_inspect.schema.sample_title'));
  if (json.length <= INLINE_JSON_LIMIT) return embed.setDescription(codeBlock('json', json));
  files.push(
    new AttachmentBuilder(Buffer.from(json, 'utf8'), {
      name: safeFileName('json', 'sample', description.name),
    }),
  );
  return embed.setDescription(t('replies:db_inspect.document.attached'));
};

export const buildSchemaReply = (
  description: CollectionDescription,
  guild: string,
  t: BoundTranslate,
): DbReply => {
  const lines = [
    t('replies:db_inspect.guild', { guild: escapeMarkdown(guild) }),
    t('replies:db_inspect.schema.count', { count: formatCount(description.estimatedCount) }),
    ...(description.registered ? [] : [t('replies:db_inspect.schema.unregistered')]),
    ...(description.inferred ? [t('replies:db_inspect.schema.inferred')] : []),
    t('replies:db_inspect.schema.indexes', {
      indexes: description.indexes.map((index) => index.keys.join('+')).join(', ') || '—',
    }),
    '',
    ...description.fields.map((field) => fieldLine(field, t)),
  ];
  const files: AttachmentBuilder[] = [];
  const fullText = lines.join('\n');
  if (fullText.length > EMBED_DESCRIPTION_LIMIT) {
    files.push(
      new AttachmentBuilder(Buffer.from(fullText, 'utf8'), {
        name: safeFileName('txt', 'schema', description.name),
      }),
    );
  }
  const fieldsEmbed = new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle(t('replies:db_inspect.schema.title', { collection: description.name }))
    .setDescription(joinLines(lines));
  return dbReply([fieldsEmbed, sampleEmbed(description, t, files)], { files });
};
