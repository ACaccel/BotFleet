/**
 * The command registry — the single source of truth for which
 * subcommands the `db` CLI exposes.
 *
 * Adding a future operation is one edit here: import its
 * {@link RegisteredCommand} and add it to {@link COMMANDS}. Names are
 * looked up case-sensitively and must be unique.
 */
import type { RegisteredCommand } from './framework/command';
import { dropCommand as archiveLegacyDropCommand } from './commands/archive-legacy/drop';
import { exportCommand as archiveLegacyExportCommand } from './commands/archive-legacy/export';
import { isolateCommand as archiveLegacyIsolateCommand } from './commands/archive-legacy/isolate';
import { dropTodoCommand } from './commands/drop-todo';
import { dropXfeedCommand } from './commands/drop-xfeed';

/** Ordered list of every registered command; the archive-legacy trio is listed in run order. */
const COMMANDS: readonly RegisteredCommand[] = [
  dropTodoCommand,
  dropXfeedCommand,
  archiveLegacyIsolateCommand,
  archiveLegacyExportCommand,
  archiveLegacyDropCommand,
];

const BY_NAME: ReadonlyMap<string, RegisteredCommand> = new Map(
  COMMANDS.map((command) => [command.name, command]),
);

export const commandNames = (): readonly string[] => COMMANDS.map((command) => command.name);

/** A help block listing each subcommand and its description. */
export const describeCommands = (): string =>
  COMMANDS.map((command) => `  ${command.name.padEnd(24)} ${command.description}`).join('\n');

export const findCommand = (name: string): RegisteredCommand | undefined => BY_NAME.get(name);
