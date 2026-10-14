/**
 * The "the message we are replying to is gone" test for `message.reply`.
 *
 * A reply carries a `message_reference` to its parent, and when the parent
 * was deleted between the event and the reply Discord rejects the whole
 * request as an invalid form body (`50035`) with a
 * `MESSAGE_REFERENCE_UNKNOWN_MESSAGE` field error. Any reply that does real
 * work first (a preview probe, an LLM call) will sometimes lose this race;
 * it is nobody's defect and must not be filed at the same severity as a
 * rejected payload.
 *
 * `50035` alone is not enough: it is Discord's catch-all for every malformed
 * payload, so the field error is checked as well.
 */
import { DiscordAPIError } from 'discord.js';

const INVALID_FORM_BODY = 50035;
const UNKNOWN_MESSAGE_REFERENCE = 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * True when `errors.message_reference._errors` names the unknown-message
 * field error. The structure is walked defensively because
 * `DiscordErrorData.errors` is a recursive union that TypeScript cannot
 * narrow by key.
 */
const namesUnknownReference = (errors: unknown): boolean => {
  if (!isRecord(errors)) return false;
  const field = errors['message_reference'];
  if (!isRecord(field) || !Array.isArray(field['_errors'])) return false;
  return field['_errors'].some(
    (entry: unknown) => isRecord(entry) && entry['code'] === UNKNOWN_MESSAGE_REFERENCE,
  );
};

/**
 * True when `err` says the replied-to message no longer exists.
 *
 * Narrows to `DiscordAPIError` so a caller can still log the code.
 */
export const isUnknownMessageReferenceError = (err: unknown): err is DiscordAPIError =>
  err instanceof DiscordAPIError &&
  Number(err.code) === INVALID_FORM_BODY &&
  'errors' in err.rawError &&
  namesUnknownReference(err.rawError.errors);
