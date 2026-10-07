import { createHash } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  MessagePayload,
  Routes,
  type APIActionRowComponent,
  type APIEmbed,
  type APIComponentInMessageActionRow,
  type Client,
  type MessageEditOptions,
} from 'discord.js';
import { safeArchiveName } from '../../core/archive/progress';

const edits = new Map<string, Promise<unknown>>();

/** Discord deduplicates an ambiguous creation retry using the durable notification identity. */
export const archivePublicMessageNonce = (
  guildId: string,
  scopeId: string,
  previousMessageId?: string,
): string =>
  createHash('sha256')
    .update(JSON.stringify([guildId, scopeId, previousMessageId ?? 'initial']))
    .digest('hex')
    .slice(0, 24);

/** Share one edit queue between worker heartbeats and public interaction updates. */
export async function withArchivePublicMessageLock<T>(
  channelId: string,
  messageId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([channelId, messageId]);
  const previous = edits.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  edits.set(key, current);
  try {
    return await current;
  } finally {
    if (edits.get(key) === current) edits.delete(key);
  }
}

interface ArchivePublicMessage {
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

/** Read within the edit queue: interaction.message can predate a completed heartbeat. */
export async function readArchivePublicMessage(
  client: Client,
  channelId: string,
  messageId: string,
): Promise<ArchivePublicMessage> {
  const message = (await client.rest.get(Routes.channelMessage(channelId, messageId))) as {
    embeds?: APIEmbed[];
    components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
  };
  return { embeds: message.embeds ?? [], components: message.components ?? [] };
}

const json = <T>(value: T | { toJSON(): T }): T =>
  typeof value === 'object' && value !== null && 'toJSON' in value ? value.toJSON() : value;

export const isArchivePublicStatusEmbed = (embed: APIEmbed | undefined): boolean =>
  embed?.timestamp !== undefined && embed.footer !== undefined && embed.color !== undefined;

/** Replace the shared detail section while retaining the worker's latest status section. */
export async function patchArchivePublicDetails(
  client: Client,
  channelId: string,
  messageId: string,
  payload: MessageEditOptions,
  options: { retainStatus?: boolean } = {},
): Promise<void> {
  await withArchivePublicMessageLock(channelId, messageId, async () => {
    const message = await readArchivePublicMessage(client, channelId, messageId);
    const details =
      payload.embeds?.map((embed) => json(embed)) ??
      (typeof payload.content === 'string' && payload.content.length > 0
        ? [{ description: payload.content }]
        : []);
    const files = await Promise.all(
      (payload.files ?? []).map((file) =>
        MessagePayload.resolveFile(file as Parameters<typeof MessagePayload.resolveFile>[0]),
      ),
    );
    await client.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: {
        content: '',
        embeds: [
          ...(options.retainStatus === false
            ? []
            : message.embeds.slice(0, 1).filter(isArchivePublicStatusEmbed)),
          ...details,
        ],
        components: payload.components?.map((component) => json(component)) ?? [],
        attachments: [
          ...(payload.attachments ?? []),
          ...files.map((file, index) => ({ id: String(index), filename: file.name })),
        ],
        allowed_mentions: { parse: [] },
      },
      ...(files.length === 0 ? {} : { files }),
    });
  });
}

/** Public messages can only name sources that everyone in the guild can read. */
export function publicArchiveSourceName(
  client: Client,
  guildId: string,
  sourceId: string,
): string | undefined {
  const guild = client.guilds?.cache?.get(guildId);
  const source = guild?.channels.cache.get(sourceId);
  if (
    guild === undefined ||
    source === undefined ||
    source.type === ChannelType.PrivateThread ||
    !source.isTextBased()
  )
    return undefined;
  const permissions = source.permissionsFor(guild.roles.everyone);
  const permissionSource = source.isThread() ? source.parent : source;
  const overwrites = permissionSource?.permissionOverwrites?.cache;
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    ...(source.type === ChannelType.GuildVoice || source.type === ChannelType.GuildStageVoice
      ? [PermissionFlagsBits.Connect]
      : []),
  ];
  if (
    !permissions?.has(required) ||
    overwrites === undefined ||
    [...overwrites.values()].some((overwrite) => required.some((bit) => overwrite.deny.has(bit)))
  )
    return undefined;
  return safeArchiveName(source.name);
}
