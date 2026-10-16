/**
 * The predicate three acknowledgement paths use to decide whether a
 * Discord rejection means "the interaction is gone".
 *
 * It is what separates a routine expiry from a real fault, and the two
 * are logged at different severities — so a predicate that widened to
 * every `DiscordAPIError` would silently demote every rejected payload
 * to an info line, and one that narrowed would file a closed window as
 * a defect on every busy evening.
 */
import { describe, expect, it } from 'vitest';
import { DiscordAPIError } from 'discord.js';

import { isExpiredInteractionError } from '../../../../src/infra/discord/expired-interaction';

const discordError = (code: number, message: string): DiscordAPIError =>
  new DiscordAPIError({ message, code }, code, 404, 'POST', 'https://discord.test/callback', {});

describe('isExpiredInteractionError', () => {
  it('recognises 10062, the elapsed response window', () => {
    expect(isExpiredInteractionError(discordError(10062, 'Unknown interaction'))).toBe(true);
  });

  it('recognises 40060, an interaction already acknowledged', () => {
    expect(isExpiredInteractionError(discordError(40060, 'Already acknowledged'))).toBe(true);
  });

  it('rejects another Discord error, which is a real fault', () => {
    expect(isExpiredInteractionError(discordError(50035, 'Invalid Form Body'))).toBe(false);
  });

  it('rejects a plain Error, so a local bug is never filed as an expiry', () => {
    expect(isExpiredInteractionError(new Error('Unknown interaction'))).toBe(false);
  });

  it('rejects a non-Error throw', () => {
    expect(isExpiredInteractionError('10062')).toBe(false);
  });
});
