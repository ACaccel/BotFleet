/**
 * `db` — unified DB-maintenance ops CLI.
 *
 * One entry point for every database-maintenance operation, selected by a
 * subcommand:
 *
 *   npm run db -- verify              # read-only structural validation (one guild)
 *   npm run db -- migrate-timestamp   # Message.timestamp String -> numeric
 *   npm run db -- drop-todo           # drop the retired todos collection
 *
 * Optional `--config <path>` overrides the default `tools/db/config.json`
 * (gitignored — never commit operator credentials). Each command reads
 * its options from the `operations.<name>` section of that single config.
 * See `tools/db/README.md` for the field reference and per-command
 * runbooks.
 *
 * This module owns only process concerns: argv parsing, config loading,
 * logger bootstrap, dispatch, report emission, and exit-code wiring. The
 * commands themselves never call `process.exit`; they return a result and
 * this entry point maps its `exitCode`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type DbRunContext } from './framework/command';
import { loadConfig } from './framework/config';
import { withGuildConnection } from './framework/connection';
import { bootstrapToolLogger } from './framework/logger';
import { emitReport } from './framework/report';
import { describeCommands, findCommand } from './registry';

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });

  const subcommand = positionals[0];
  const command = subcommand === undefined ? undefined : findCommand(subcommand);
  if (command === undefined) {
    const reason =
      subcommand === undefined ? 'no subcommand given' : `unknown subcommand "${subcommand}"`;
    process.stderr.write(
      `[db] ${reason}\nUsage: npm run db -- <subcommand> [--config <path>]\n\n${describeCommands()}\n`,
    );
    process.exit(1);
  }

  const logger = bootstrapToolLogger(`db:${command.name}`);
  const configPath = values.config ?? resolve(__dirname, 'config.json');
  const { shared, operations } = loadConfig(configPath);

  const ctx: DbRunContext = {
    shared,
    logger,
    withGuildConnection: (guildId, fn) => withGuildConnection(shared.mongoUri, guildId, fn),
  };

  const result = await command.execute(operations[command.name] ?? {}, ctx);
  emitReport(result.report, result.summaryLine, shared.outputPath, logger);
  process.exitCode = result.exitCode;
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[db] FAIL: ${message}\n`);
  process.exit(1);
});
