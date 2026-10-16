/**
 * Archive a deleted Discord attachment to disk for forensics.
 *
 * This is the fallback path. Discord purges the CDN object for an attachment
 * nearly synchronously with the message deletion, so a download started from
 * `messageDelete` frequently 404s even though the signed URL is still valid.
 * The reliable path is the pre-delete cache in `attachment-cache.ts`; what
 * remains here is a best-effort attempt for messages the cache never saw,
 * hardened with one retry against `media.discordapp.net`, whose cache often
 * still holds recently displayed media.
 */
import type { Attachment } from 'discord.js';

import type { Logger } from '../../core/logger';

import { archiveFilePath, downloadToFile, runBounded } from './attachment-io';

/** HTTP status Discord returns once the CDN object has been purged. */
const HTTP_NOT_FOUND = 404;

/**
 * Download `attachment` and save it under
 * `./data/deleted_attachments/<guildId>/<messageId>/`. Used by the guild-events
 * plugin's `messageDelete` audit path when the pre-delete cache missed.
 *
 * Attachments are binary, not text, so this is genuine file I/O —
 * structured logging cannot stand in for it.
 *
 * Never rejects: every failure mode is logged and swallowed so one bad
 * attachment cannot disturb the caller's audit flow.
 */
export const archiveDeletedAttachment = async (
  logger: Logger | undefined,
  guildId: string,
  messageId: string,
  attachment: Attachment,
): Promise<void> => {
  const filePath = archiveFilePath(guildId, messageId, attachment.name);

  const primary = await downloadToFile(attachment.url, filePath);
  if (primary === undefined) return;

  if (primary.stage === 'mkdir') {
    logger?.error(
      { err: primary.error, guildId, messageId },
      'archiveDeletedAttachment: could not create the archive directory',
    );
    return;
  }

  if (primary.stage === 'write') {
    // The body was already in hand, so the fault is local; a second
    // fetch would fail the same way and only waste the CDN round trip.
    logger?.error(
      { err: primary.error, guildId, messageId, name: attachment.name },
      'archiveDeletedAttachment: write failed',
    );
    return;
  }

  const context = {
    err: primary.error,
    guildId,
    messageId,
    name: attachment.name,
    status: primary.status,
  };
  // 404 on the primary URL is the expected purge race, not an incident.
  const purgeRace = primary.status === HTTP_NOT_FOUND;

  // `proxyURL` is typed non-optional, but it arrives from a raw gateway
  // payload; treat an absent or duplicate value as "no second chance".
  const proxyUrl: string | undefined = attachment.proxyURL;
  if (proxyUrl === undefined || proxyUrl.length === 0 || proxyUrl === attachment.url) {
    logger?.warn(
      context,
      'archiveDeletedAttachment: fetch failed and no distinct proxy URL was available to retry',
    );
    return;
  }

  const fallback = await downloadToFile(proxyUrl, filePath);
  if (fallback === undefined) {
    const line = 'archiveDeletedAttachment: primary CDN fetch failed; proxyURL fallback succeeded';
    if (purgeRace) logger?.info(context, line);
    else logger?.warn(context, line);
    return;
  }

  const line = 'archiveDeletedAttachment: primary CDN fetch failed; proxyURL fallback failed';
  const fallbackContext = {
    ...context,
    fallbackStage: fallback.stage,
    fallbackStatus: fallback.status,
    fallbackErr: fallback.error,
  };
  // Both ends 404 means the object is simply gone — Discord purged the
  // CDN copy and the proxy had already evicted its own. Any other
  // outcome is a transport or disk problem an operator should see.
  if (purgeRace && fallback.stage === 'fetch' && fallback.status === HTTP_NOT_FOUND) {
    logger?.info(fallbackContext, line);
  } else {
    logger?.warn(fallbackContext, line);
  }
};

/**
 * Archive a batch of attachments with a bounded number of concurrent
 * downloads. Resolves once every attachment has been attempted; like
 * {@link archiveDeletedAttachment}, it never rejects.
 */
export const archiveDeletedAttachments = async (
  logger: Logger | undefined,
  guildId: string,
  messageId: string,
  attachments: Iterable<Attachment>,
): Promise<void> =>
  runBounded(attachments, (attachment) =>
    archiveDeletedAttachment(logger, guildId, messageId, attachment),
  );
