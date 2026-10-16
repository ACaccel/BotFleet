/**
 * Stubs for the four handler barrels (`@cmd`, `@button`, `@modal`,
 * `@select-menu`).
 *
 * Every test that boots a real `BaseBot` has to neutralise them: the
 * barrels pull in `registry.generated.ts`, which imports every handler
 * in the tree, which drags the whole handler layer — and its Discord
 * and Mongo dependencies — into a test about bot lifecycle.
 *
 * `vi.mock` is hoisted above imports by vitest's transform, so the
 * calls have to live in the test file itself. What is shared here are
 * the factories, which is where the actual duplication was: a test
 * file declares the four one-line mocks and points each at the
 * matching factory below.
 *
 * Usage:
 *
 * ```ts
 * import { barrelStubs } from '../../fixtures/handler-barrel-stubs';
 *
 * vi.mock('@cmd', () => barrelStubs.cmd);
 * vi.mock('@button', () => barrelStubs.button);
 * vi.mock('@modal', () => barrelStubs.modal);
 * vi.mock('@select-menu', () => barrelStubs.selectMenu);
 * ```
 */
const noop = async (): Promise<void> => {};
/** Every configured command name resolves, so `config.commands` passes validation. */
class StubCommand {}

export const barrelStubs = {
  cmd: {
    registerCommands: noop,
    getSlashCommandClass: (): typeof StubCommand => StubCommand,
    getCommandJsonBody: (): unknown[] => [],
    executeCommand: noop,
    executeAutocomplete: noop,
  },
  button: {
    registerButtons: noop,
    executeButton: noop,
  },
  modal: {
    registerModals: noop,
    executeModal: noop,
  },
  selectMenu: {
    registerSSMs: noop,
    executeSSM: noop,
  },
} as const;
