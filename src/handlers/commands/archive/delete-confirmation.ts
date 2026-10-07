import { randomBytes } from 'node:crypto';
import { ArchiveAccessError } from './access';

interface Binding {
  userId: string;
  guildId: string;
  channelId: string;
  messageId: string;
}
interface Confirmation extends Binding {
  kind: 'job' | 'plan';
  id: string;
  expiresAt: number;
}
const confirmations = new Map<string, Confirmation>();

/** Deletion approval is disposable and bound to the exact public message and actor. */
export const requestArchiveDeletion = (
  kind: Confirmation['kind'],
  id: string,
  actor: Binding,
): string => {
  const now = Date.now();
  for (const [key, value] of confirmations) if (value.expiresAt <= now) confirmations.delete(key);
  while (confirmations.size >= 5_000) {
    const key = confirmations.keys().next().value;
    if (key === undefined) break;
    confirmations.delete(key);
  }
  const token = randomBytes(12).toString('base64url');
  confirmations.set(token, { ...actor, kind, id, expiresAt: now + 5 * 60_000 });
  return token;
};

export const consumeArchiveDeletion = (token: string, actor: Binding): Confirmation => {
  const value = confirmations.get(token);
  if (value === undefined || value.expiresAt <= Date.now()) {
    confirmations.delete(token);
    throw new ArchiveAccessError('replies:archive.confirm_stale');
  }
  if (
    value.userId !== actor.userId ||
    value.guildId !== actor.guildId ||
    value.channelId !== actor.channelId ||
    value.messageId !== actor.messageId
  )
    throw new ArchiveAccessError('replies:archive.confirm_actor');
  confirmations.delete(token);
  return value;
};
