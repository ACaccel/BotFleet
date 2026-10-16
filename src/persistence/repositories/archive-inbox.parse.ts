import { ArchiveLimitExceededError } from '../../core/archive/errors';
import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveInboxDocument,
  type ArchiveInboxEntry,
} from '../../core/archive/types';

/** An inbox event that can never be claimed; it must be dead-lettered so later events proceed. */
export interface ArchiveInboxUnclaimable extends Error {
  readonly eventId: string;
}
/** A single inbox event larger than the claim memory budget. */
export class ArchiveInboxOversizedError
  extends ArchiveLimitExceededError
  implements ArchiveInboxUnclaimable
{
  public constructor(public readonly eventId: string) {
    super('Archive inbox event exceeds memory budget');
    this.name = 'ArchiveInboxOversizedError';
  }
}
/** A stored inbox event whose kind, identity or payload does not match its contract. */
export class ArchiveInboxInvalidError extends Error implements ArchiveInboxUnclaimable {
  public constructor(
    public readonly eventId: string,
    detail: string,
  ) {
    super(`Archive inbox event is invalid: ${detail}`);
    this.name = 'ArchiveInboxInvalidError';
  }
}
export const isArchiveInboxUnclaimable = (error: unknown): error is ArchiveInboxUnclaimable =>
  error instanceof ArchiveInboxOversizedError || error instanceof ArchiveInboxInvalidError;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value);
/** A stored inbox document as read, before its kind and payload are known to be valid. */
export type RawInboxDocument = Omit<
  ArchiveInboxDocument,
  'kind' | 'messageId' | 'channelId' | 'payload'
> & {
  readonly kind: unknown;
  readonly messageId?: unknown;
  readonly channelId?: unknown;
  readonly payload: unknown;
};
/**
 * Checks a stored event against the contract of its kind before it is handed to
 * the reducer; the worker dead-letters an event that fails.
 */
export const parseInboxEntry = (document: RawInboxDocument): ArchiveInboxEntry => {
  const invalid = (detail: string): never => {
    throw new ArchiveInboxInvalidError(String(document.eventId), detail);
  };
  const { payload } = document;
  if (!isRecord(payload)) return invalid('payload is not an object');
  switch (document.kind) {
    case 'snapshot': {
      const snapshot = payload['snapshot'];
      if (
        !isSnowflake(document.messageId) ||
        !isSnowflake(document.channelId) ||
        !isRecord(snapshot) ||
        snapshot['_id'] !== document.messageId ||
        snapshot['schemaVersion'] !== ARCHIVE_SCHEMA_VERSION ||
        typeof snapshot['channelId'] !== 'string' ||
        typeof snapshot['createdTimestamp'] !== 'number' ||
        typeof snapshot['observedAt'] !== 'number' ||
        (payload['channel'] !== undefined && !isRecord(payload['channel'])) ||
        (payload['create'] !== undefined && payload['create'] !== true)
      )
        return invalid('snapshot identity or payload');
      return document as unknown as ArchiveInboxEntry;
    }
    case 'delete':
      if (!isSnowflake(document.messageId) || !isSnowflake(document.channelId))
        return invalid('delete identity');
      return document as unknown as ArchiveInboxEntry;
    case 'reaction': {
      if (!isSnowflake(document.messageId) || !isSnowflake(document.channelId))
        return invalid('reaction identity');
      const target = payload['target'];
      if (
        target !== undefined &&
        !(
          isRecord(target) &&
          (target['scope'] === 'all' ||
            target['scope'] === 'poll' ||
            (target['scope'] === 'emoji' &&
              typeof target['emojiKey'] === 'string' &&
              target['emojiKey'] !== '' &&
              (target['type'] === undefined || target['type'] === 0 || target['type'] === 1)))
        )
      )
        return invalid('reaction target');
      return document as unknown as ArchiveInboxEntry;
    }
    case 'gap':
      if (payload['reason'] !== undefined && typeof payload['reason'] !== 'string')
        return invalid('gap reason');
      return document as unknown as ArchiveInboxEntry;
    default:
      return invalid(`unknown kind ${String(document.kind)}`);
  }
};
