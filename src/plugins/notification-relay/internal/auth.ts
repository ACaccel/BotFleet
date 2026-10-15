/** Bearer-token check for the notification relay API. */
import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Build a check for an `Authorization` header value. Both sides are hashed
 * to a fixed length first, so the comparison time reveals neither the
 * secret's length nor how much of it a guess matched.
 */
export const createBearerCheck = (secret: string): ((header: string | undefined) => boolean) => {
  const expected = digest(secret);
  return (header) => {
    const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
    return token !== undefined && timingSafeEqual(digest(token), expected);
  };
};
