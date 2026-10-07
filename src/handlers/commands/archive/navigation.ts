import { randomBytes } from 'node:crypto';
import type { ArchiveManifestCategory } from '../../../core/archive/manifest-summary';
import { ArchiveAccessError } from './access';

export interface ArchiveBrowsePage {
  view: 'summary' | 'changes' | 'technical' | 'groups' | 'sources' | 'operation' | 'download';
  category?: ArchiveManifestCategory;
  group?: {
    reason: string;
    collection: string;
    impact: 'insert' | 'update' | 'delete' | 'unknown';
  };
  sourceId?: string;
  afterSequence?: number;
  beforeSequence?: number;
  afterGroup?: string;
  beforeGroup?: string;
  afterSource?: string;
  beforeSource?: string;
  sequence?: number;
  detailPage?: number;
  limit?: number;
  returnTo?: ArchiveBrowsePage;
}
export interface ArchiveNavigationActor {
  userId: string;
  channelId: string;
  guildId: string;
  messageId?: string;
}
interface NavigationEntry {
  runId: string;
  actor: ArchiveNavigationActor;
  page: ArchiveBrowsePage;
  expiresAt: number;
}
const lifetime = 14 * 60_000;
const capacity = 5_000;
const entries = new Map<string, NavigationEntry>();

/** View positions are disposable; durable run identity and approvals stay in MongoDB. */
export const archiveNavigationId = (
  runId: string,
  actor: ArchiveNavigationActor,
  page: ArchiveBrowsePage,
  kind: 'button' | 'category' = 'button',
): string => {
  const now = Date.now();
  for (const [token, entry] of entries) if (entry.expiresAt <= now) entries.delete(token);
  while (entries.size >= capacity) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  const token = randomBytes(12).toString('base64url');
  entries.set(token, {
    runId,
    actor: { ...actor },
    page: structuredClone(page),
    expiresAt: now + lifetime,
  });
  return `${kind === 'button' ? 'archive_browse' : 'archive_category'}|${token}`;
};

export const resolveArchiveNavigation = (
  customId: string,
  actor: ArchiveNavigationActor,
  kind: 'button' | 'category' = 'button',
): { runId: string; page: ArchiveBrowsePage } => {
  const prefix = kind === 'button' ? 'archive_browse' : 'archive_category';
  const match = new RegExp(`^${prefix}\\|([A-Za-z0-9_-]{16})$`).exec(customId);
  const token = match?.[1];
  const entry = token === undefined ? undefined : entries.get(token);
  if (entry === undefined || entry.expiresAt <= Date.now()) {
    if (token !== undefined) entries.delete(token);
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  }
  if (
    (entry.actor.messageId === undefined
      ? entry.actor.userId !== actor.userId
      : entry.actor.messageId !== actor.messageId) ||
    entry.actor.channelId !== actor.channelId ||
    entry.actor.guildId !== actor.guildId
  )
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  return { runId: entry.runId, page: structuredClone(entry.page) };
};

/** Bind newly rendered navigation to the shared message before publishing it. */
export const bindArchiveNavigationMessage = (
  customId: string,
  channelId: string,
  messageId: string,
  guildId: string,
): void => {
  const token = /^(?:archive_browse|archive_category)\|([A-Za-z0-9_-]{16})$/.exec(customId)?.[1];
  const entry = token === undefined ? undefined : entries.get(token);
  if (entry === undefined || entry.actor.channelId !== channelId || entry.actor.guildId !== guildId)
    return;
  if (entry.actor.messageId !== undefined && entry.actor.messageId !== messageId)
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  entry.actor.messageId = messageId;
};
