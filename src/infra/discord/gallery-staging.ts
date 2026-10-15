/**
 * Uploads gallery pages to a staging channel ahead of time, so a reader
 * message can show a page by URL instead of uploading it during the turn.
 *
 * The channel must be age-restricted, since it holds the same pages the
 * readers do; it is checked on first use and again after a failure, and
 * while it is unusable every page comes back unstaged and the reader falls
 * back to uploading with the turn. Several bots may share the channel: each
 * deletes only its own messages, once they are older than the retention.
 *
 * After an upload the bot requests each page once through Discord's media
 * proxy, the URL an embed displays, so the first reader to reach the page
 * does not wait for the proxy to fetch it.
 */
import {
  AttachmentBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';

import { logError, type Logger } from '../../core/logger';
import { boundedHttp } from '../http';
import { isAgeRestrictedChannel } from './channel';

const MAX_FILES_PER_MESSAGE = 10;
/** Kept below Discord's request ceiling with room for the multipart overhead. */
const MAX_BYTES_PER_MESSAGE = 9 * 1024 * 1024;
const RETRY_UNUSABLE_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** History pages read per cleanup pass, newest first. */
const CLEANUP_MAX_PAGES = 20;
/** Discord refuses bulk deletion of messages older than 14 days. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WARM_TIMEOUT_MS = 15_000;
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
];

interface StagingFile {
  readonly name: string;
  readonly image: { readonly data: Buffer };
}

interface StagedUpload {
  readonly url: string;
  readonly expiresAt: number;
}

export interface GalleryStagingOptions {
  readonly client: Client;
  readonly channelId: string;
  /** Staging messages older than this are deleted. */
  readonly retentionMs: number;
  readonly logger: Logger;
  readonly now?: () => number;
  /** Requests a URL once and discards the body; injectable for tests. */
  readonly warm?: (url: string) => Promise<void>;
}

const warmThroughProxy = async (url: string): Promise<void> => {
  await boundedHttp.get(url, { responseType: 'arraybuffer', timeout: WARM_TIMEOUT_MS });
};

/** Discord signs attachment URLs with an `ex` parameter: expiry, hexadecimal Unix seconds. */
const signedExpiry = (url: string): number | undefined => {
  const ex = new URL(url).searchParams.get('ex');
  if (ex === null || !/^[0-9a-f]+$/i.test(ex)) return undefined;
  return Number.parseInt(ex, 16) * 1000;
};

/** Split files into messages within the per-message file count and size limits. */
const batches = (files: readonly StagingFile[]): StagingFile[][] => {
  const result: StagingFile[][] = [];
  let current: StagingFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = file.image.data.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_FILES_PER_MESSAGE || bytes + size > MAX_BYTES_PER_MESSAGE)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
};

export class DiscordGalleryStaging {
  private channel: GuildTextBasedChannel | undefined;
  private unusableUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly warm: (url: string) => Promise<void>;

  public constructor(private readonly options: GalleryStagingOptions) {
    this.now = options.now ?? Date.now;
    this.warm = options.warm ?? warmThroughProxy;
  }

  /** Upload `files`; the result is aligned with them and never rejects. */
  public async stage(
    files: readonly StagingFile[],
  ): Promise<ReadonlyArray<StagedUpload | undefined>> {
    const channel = await this.usableChannel();
    if (channel === undefined) return files.map(() => undefined);
    const staged = new Map<string, StagedUpload>();
    for (const batch of batches(files)) {
      try {
        const sentAt = this.now();
        const message = await channel.send({
          files: batch.map((file) => new AttachmentBuilder(file.image.data, { name: file.name })),
          allowedMentions: { parse: [] },
        });
        const expiryCap = sentAt + this.options.retentionMs;
        const warming: Array<Promise<void>> = [];
        for (const attachment of message.attachments.values()) {
          staged.set(attachment.name, {
            url: attachment.url,
            expiresAt: Math.min(signedExpiry(attachment.url) ?? expiryCap, expiryCap),
          });
          warming.push(this.warm(attachment.proxyURL).catch(() => undefined));
        }
        await Promise.all(warming);
      } catch (error) {
        // Re-check the channel next time: it may have been deleted or its permissions changed.
        this.channel = undefined;
        logError(this.options.logger, channel.guildId, error);
      }
    }
    return files.map((file) => staged.get(file.name));
  }

  /** Start hourly deletion of this bot's expired staging messages, beginning now. */
  public start(): void {
    if (this.timer !== undefined) return;
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Delete this bot's staging messages older than the retention. Never rejects. */
  public async cleanup(): Promise<void> {
    const channel = await this.usableChannel();
    const selfId = this.options.client.user?.id;
    if (channel === undefined || selfId === undefined) return;
    try {
      const cutoff = this.now() - this.options.retentionMs;
      const expired: Message[] = [];
      let before: string | undefined;
      for (let page = 0; page < CLEANUP_MAX_PAGES; page++) {
        const messages = await channel.messages.fetch({
          limit: 100,
          ...(before ? { before } : {}),
        });
        if (messages.size === 0) break;
        for (const message of messages.values()) {
          if (message.author.id === selfId && message.createdTimestamp < cutoff)
            expired.push(message);
        }
        before = messages.last()?.id;
      }
      const canBulk =
        channel.permissionsFor(selfId)?.has(PermissionFlagsBits.ManageMessages) === true;
      const bulkCutoff = this.now() - BULK_DELETE_MAX_AGE_MS;
      const bulk = canBulk ? expired.filter((m) => m.createdTimestamp > bulkCutoff) : [];
      for (let offset = 0; offset < bulk.length; offset += 100) {
        const chunk = bulk.slice(offset, offset + 100);
        if (chunk.length === 1) await chunk[0]?.delete();
        else await channel.bulkDelete(chunk, true);
      }
      const single = expired.filter((m) => !bulk.includes(m));
      for (const message of single) await message.delete();
    } catch (error) {
      logError(this.options.logger, channel.guildId, error);
    }
  }

  private async usableChannel(): Promise<GuildTextBasedChannel | undefined> {
    if (this.channel !== undefined) return this.channel;
    if (this.now() < this.unusableUntil) return undefined;
    const reason = await this.resolve();
    if (typeof reason !== 'string') {
      this.channel = reason;
      return reason;
    }
    // Before login there is nothing to judge yet; ask again on the next call.
    if (reason === 'not_ready') return undefined;
    this.unusableUntil = this.now() + RETRY_UNUSABLE_MS;
    this.options.logger.warn(
      { channelId: this.options.channelId, reason },
      'gallery-staging: staging channel unusable; pages upload with each turn',
    );
    return undefined;
  }

  private async resolve(): Promise<GuildTextBasedChannel | string> {
    const { client, channelId } = this.options;
    const selfId = client.user?.id;
    if (selfId === undefined) return 'not_ready';
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) return 'not_found';
    if (!isAgeRestrictedChannel(channel)) return 'not_age_restricted';
    const permissions = channel.permissionsFor(selfId);
    if (permissions === null || !REQUIRED_PERMISSIONS.every((flag) => permissions.has(flag))) {
      return 'missing_permissions';
    }
    return channel;
  }
}
