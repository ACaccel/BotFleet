/**
 * The predicate a reply path uses to decide whether a Discord rejection
 * means "the message being replied to was deleted".
 *
 * `50035` is Discord's catch-all for every malformed payload, so the
 * predicate must read the field error too: widening it to the bare code
 * would demote a genuinely rejected payload to a debug line, and
 * narrowing it would file every withdrawn message as a defect.
 */
import { describe, expect, it } from 'vitest';
import { DiscordAPIError } from 'discord.js';

import { isUnknownMessageReferenceError } from '../../../../src/infra/discord/unknown-message-reference';

const discordError = (code: number, message: string, errors?: unknown): DiscordAPIError =>
  new DiscordAPIError(
    { message, code, ...(errors === undefined ? {} : { errors }) } as ConstructorParameters<
      typeof DiscordAPIError
    >[0],
    code,
    400,
    'POST',
    'https://discord.test/channels/1/messages',
    {},
  );

const unknownReference = {
  message_reference: {
    _errors: [{ code: 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE', message: 'Unknown message' }],
  },
};

describe('isUnknownMessageReferenceError', () => {
  it('recognises 50035 carrying the unknown-message field error', () => {
    expect(
      isUnknownMessageReferenceError(discordError(50035, 'Invalid Form Body', unknownReference)),
    ).toBe(true);
  });

  it('rejects 50035 with a different field error, which is a rejected payload', () => {
    const other = { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Too long' }] } };
    expect(isUnknownMessageReferenceError(discordError(50035, 'Invalid Form Body', other))).toBe(
      false,
    );
  });

  it('rejects 50035 with a message_reference error of another kind', () => {
    const other = {
      message_reference: {
        _errors: [{ code: 'REPLIES_CANNOT_REFERENCE_OTHER_CHANNEL', message: 'Other channel' }],
      },
    };
    expect(isUnknownMessageReferenceError(discordError(50035, 'Invalid Form Body', other))).toBe(
      false,
    );
  });

  it('rejects 50035 with no field errors at all', () => {
    expect(isUnknownMessageReferenceError(discordError(50035, 'Invalid Form Body'))).toBe(false);
  });

  it('rejects another Discord error even when it names the field', () => {
    expect(
      isUnknownMessageReferenceError(discordError(50013, 'Missing Permissions', unknownReference)),
    ).toBe(false);
  });

  it('rejects a plain Error, so a local bug is never filed as a withdrawn message', () => {
    expect(isUnknownMessageReferenceError(new Error('Unknown message'))).toBe(false);
  });

  it('rejects a non-Error throw', () => {
    expect(isUnknownMessageReferenceError('50035')).toBe(false);
  });
});
