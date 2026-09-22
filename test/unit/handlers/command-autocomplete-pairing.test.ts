/**
 * Sweep over every registered command, pinning the two halves of the
 * autocomplete contract against each other.
 *
 * The contract is three-part — an option flagged `autocomplete: true`,
 * a `Command.autocomplete` hook, and the dispatcher that joins them —
 * and the pairing is the part no type can express: `setConfig` runs in
 * a constructor, so the compiler never sees the flag next to the hook.
 * Its failure mode is also the quietest one in the framework. A flag
 * with no hook registers cleanly and offers an empty dropdown forever; a
 * hook with no flag is code Discord never calls. Neither raises
 * anything at runtime, so this sweep is the only thing that can catch
 * them.
 *
 * The JSON build is swept here for the same reason: `buildCommandJsonBody`
 * rejects a misdeclared option, but only a command whose own test
 * happens to call it would ever reach that check. Running it over every
 * command is what makes that rejection a test-time failure rather than
 * a `yarn register` one.
 */
import { describe, expect, it } from 'vitest';

import type { Translator } from '../../../src/core/i18n';
import { createAllSlashCommands } from '../../../src/handlers/commands';
import { localizeCommandConfig, type CommandConfig } from '../../../src/handlers/commands/command';
import { buildCommandJsonBody } from '../../../src/handlers/commands/command-builder';

/** `buildCommandJsonBody` rejects an empty description, so keys stand in for copy. */
const echoTranslator = { t: (key: string) => key } as unknown as Translator;

/** True when any option asks Discord to query the handler as the member types. */
const declaresAutocompleteOption = (config: CommandConfig): boolean =>
  Object.values(config.options ?? {}).some((options) =>
    options.some((option) => option.autocomplete === true),
  );

const registered = [...createAllSlashCommands().entries()];

describe('every registered command', () => {
  it('registers at least one command, so the sweep below is not vacuous', () => {
    expect(registered.length).toBeGreaterThan(0);
  });

  it.each(registered)('%s builds a Discord command payload', (_name, command) => {
    expect(() =>
      buildCommandJsonBody(localizeCommandConfig(command.config, echoTranslator)),
    ).not.toThrow();
  });

  it.each(registered)('%s pairs its autocomplete flag with its hook', (_name, command) => {
    // Both directions: a flag without a hook is a dead dropdown, a hook
    // without a flag is dead code, and neither says so at runtime.
    expect(declaresAutocompleteOption(command.config)).toBe(command.autocomplete !== undefined);
  });
});
