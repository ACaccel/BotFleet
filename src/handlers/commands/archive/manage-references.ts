import { randomBytes } from 'node:crypto';
import { ArchiveAccessError } from './access';

const references = new Map<string, { action: string; id: string; expiresAt: number }>();
/** Legacy IDs may exceed Discord component limits; only their presentation reference expires. */
export const shortArchiveReference = (action: string, id: string): string => {
  const now = Date.now();
  for (const [key, value] of references) if (value.expiresAt <= now) references.delete(key);
  while (references.size >= 5_000) {
    const key = references.keys().next().value;
    if (key === undefined) break;
    references.delete(key);
  }
  const token = randomBytes(12).toString('base64url');
  references.set(token, { action, id, expiresAt: now + 14 * 60_000 });
  return token;
};

export const resolveArchiveReference = (token: string): { action: string; id: string } => {
  const value = references.get(token);
  if (value === undefined || value.expiresAt <= Date.now())
    throw new ArchiveAccessError('replies:archive.navigation_stale');
  return value;
};
