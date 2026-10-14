/**
 * Typed accessors for slash-command options.
 *
 * discord.js types `CommandInteractionOption.value` as
 * `string | number | boolean | undefined`, so a bare
 * `interaction.options.get('x')?.value as string` cast hides a missing
 * option behind `undefined`-typed-as-`string` and silently accepts a
 * value of the wrong primitive type.
 *
 * These helpers make the two cases explicit:
 *
 *   - `getRequired*` — the option is declared `required: true`, so a
 *     missing or wrongly-typed value is a contract violation by Discord
 *     or by the handler's own `setConfig`. It throws a `TypeError`,
 *     which the handler's `replyForError` boundary turns into a
 *     trace-id-stamped reply and an operator log line.
 *   - `getOptional*` — the option may legitimately be absent; the
 *     caller gets `undefined` and decides on a default.
 */
import type { CommandInteractionOption } from 'discord.js';

/** The option-reading surface both chat-input and context-menu interactions expose. */
export interface OptionSource {
  readonly options: {
    get(name: string): CommandInteractionOption | null | undefined;
  };
}

const rawValue = (source: OptionSource, name: string): unknown => source.options.get(name)?.value;

const contractViolation = (name: string, expected: string, actual: unknown): TypeError =>
  new TypeError(
    `slash-command option "${name}" is declared required and must be a ${expected}, got ${
      actual === undefined ? 'no value' : typeof actual
    }`,
  );

/** Read a required string option. @throws {TypeError} when absent or non-string. */
export const getRequiredString = (source: OptionSource, name: string): string => {
  const value = rawValue(source, name);
  if (typeof value !== 'string') throw contractViolation(name, 'string', value);
  return value;
};

/** Read an optional string option; `undefined` when absent or non-string. */
export const getOptionalString = (source: OptionSource, name: string): string | undefined => {
  const value = rawValue(source, name);
  return typeof value === 'string' ? value : undefined;
};

/** Read a required number option. @throws {TypeError} when absent or non-number. */
export const getRequiredNumber = (source: OptionSource, name: string): number => {
  const value = rawValue(source, name);
  if (typeof value !== 'number') throw contractViolation(name, 'number', value);
  return value;
};

/** Read an optional number option; `undefined` when absent or non-number. */
export const getOptionalNumber = (source: OptionSource, name: string): number | undefined => {
  const value = rawValue(source, name);
  return typeof value === 'number' ? value : undefined;
};

/**
 * Read an optional option constrained to a fixed set of choices,
 * falling back when it is absent or not one of them.
 *
 * The alternative — `(getOptionalString(...) ?? 'x') as 'x' | 'y'` —
 * asserts rather than checks, so a renamed choice in `setConfig`
 * produces a value the type says is impossible.
 */
export const getOptionalChoice = <const T extends readonly string[]>(
  source: OptionSource,
  name: string,
  choices: T,
  fallback: T[number],
): T[number] => {
  const value = getOptionalString(source, name);
  return value !== undefined && choices.includes(value) ? value : fallback;
};
