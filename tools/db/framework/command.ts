/**
 * The extensibility contract for the `db` ops CLI.
 *
 * Each maintenance operation is a Strategy ({@link DbCommandSpec}) that
 * declares its subcommand `name`, help `description`, a zod schema for
 * its own options slice, and a `run` that receives injected collaborators
 * and returns a {@link DbCommandResult}. `run` is pure of process
 * concerns — it never calls `process.exit`; the entry point maps the
 * returned `exitCode`.
 *
 * {@link defineCommand} wraps a typed spec into an erased
 * {@link RegisteredCommand}: the generic option type is captured inside
 * the `execute` closure (which validates the raw options via the spec's
 * schema before calling `run`), so the registry can hold commands of
 * differing option shapes in one array without `any` and without an
 * unchecked cast. Adding a future operation is: write a spec module,
 * register it, and add its `operations` section to `config.example.json`.
 */
import type { Connection } from 'mongoose';
import type { z } from 'zod';

import type { Logger } from '../../../src/core/logger';

import { parseOptions, type SharedConfig } from './config';

/** Collaborators injected into every command, independent of its options. */
export interface DbRunContext {
  readonly shared: SharedConfig;
  readonly logger: Logger;
  /** Open a per-guild connection, run `fn`, and always close it. */
  readonly withGuildConnection: <R>(
    guildId: string,
    fn: (connection: Connection) => Promise<R>,
  ) => Promise<R>;
}

/** The run context, extended with this command's validated options. */
interface DbCommandContext<TOptions> extends DbRunContext {
  readonly options: TOptions;
}

/** A command's terminal result: the report to serialize, a summary line, and the exit code. */
export interface DbCommandResult {
  /** JSON-serializable report; the shape is command-specific. */
  readonly report: unknown;
  /** The PASS / FAIL / RECOMMENDATION line printed after the report. */
  readonly summaryLine: string;
  readonly exitCode: 0 | 1;
}

/**
 * One maintenance operation. `TOptions` is the command's private options
 * slice; `optionsSchema` declares `Input = unknown` so any concrete zod
 * schema (which validates an `unknown` input) is assignable here.
 */
interface DbCommandSpec<TOptions> {
  /** Subcommand token, e.g. `drop-todo`. Must be unique in the registry. */
  readonly name: string;
  /** One-line help text, surfaced by `db` with no/unknown subcommand. */
  readonly description: string;
  /** Validates this command's slice of `config.operations[name]`. */
  readonly optionsSchema: z.ZodType<TOptions, z.ZodTypeDef, unknown>;
  run(ctx: DbCommandContext<TOptions>): Promise<DbCommandResult>;
}

/** An option-type-erased command, ready for the registry and dispatch. */
export interface RegisteredCommand {
  readonly name: string;
  readonly description: string;
  /** Validate `rawOptions` against the spec's schema, then run. */
  execute(rawOptions: unknown, ctx: DbRunContext): Promise<DbCommandResult>;
}

/**
 * Erase a typed {@link DbCommandSpec} into a {@link RegisteredCommand}.
 * The generic `TOptions` survives only inside the `execute` closure,
 * which validates the raw options before invoking `run` — keeping the
 * boundary type-safe with neither `any` nor a cast.
 */
export const defineCommand = <TOptions>(spec: DbCommandSpec<TOptions>): RegisteredCommand => ({
  name: spec.name,
  description: spec.description,
  execute: (rawOptions, ctx) =>
    spec.run({ ...ctx, options: parseOptions(spec.optionsSchema, rawOptions, spec.name) }),
});
