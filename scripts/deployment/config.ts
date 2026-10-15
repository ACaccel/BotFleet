import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) && !/[\r\n\0]/.test(value),
    'Use an absolute path without control characters',
  );
const botName = z.enum(['tomori', 'nijika', 'msg-archive', 'konata', 'gopher']);
export type BotName = z.infer<typeof botName>;
export const deploymentSchema = z
  .object({
    user: z
      .string()
      .regex(/^[a-z_][a-z0-9_-]*$/)
      .refine((value) => value !== 'root', 'Services must run as an ordinary user'),
    runtimePrefix: absolutePath.optional(),
    bots: z
      .array(botName)
      .min(1)
      .refine((bots) => new Set(bots).size === bots.length, 'Duplicate bot'),
    readinessTimeoutSeconds: z.number().int().min(15).max(600).default(120),
    mongodb: z
      .object({
        prefix: absolutePath,
        configFile: absolutePath,
        probeEnvFile: absolutePath,
      })
      .strict()
      .optional(),
  })
  .strict();
export type DeploymentConfig = z.infer<typeof deploymentSchema>;
export interface Release {
  root: string;
  directory: string;
  prefix: string;
  config: DeploymentConfig;
  units: Record<string, string>;
}
export const botService = (bot: string): string => `botfleet@${bot}.service`;
export const mongoService = 'mongodb-botfleet.service';
export const ownerMarker = (root: string): string => `# Managed by BotFleet: ${root}\n`;
const actions = [
  'prepare',
  'deploy',
  'undeploy',
  'recover',
  'mongo-prepare',
  'mongo-deploy',
  'mongo-undeploy',
];
const targetActions = ['prepare', 'deploy'];
const targetFlags = ['-t', '--target'];
/** npm flag names that select one bot (kebab-case CLI spelling). */
export const DEPLOY_NPM_FLAGS = ['t', 'target'] as const;
export type DeployNpmFlags = Readonly<Partial<Record<(typeof DEPLOY_NPM_FLAGS)[number], string>>>;
export interface DeployCommand {
  action: string;
  /** Bot whose service alone is replaced; `undefined` deploys every configured bot. */
  bot?: BotName;
}
/**
 * `npm run deploy -t tomori` reaches the script as `deploy tomori` with `npm_config_t=true`,
 * because npm consumes the flag; `npm run deploy -- -t tomori` keeps it in argv.
 */
export function parseAction(args: readonly string[], npmFlags: DeployNpmFlags = {}): DeployCommand {
  const [action, ...extra] = args;
  if (!action || !actions.includes(action))
    throw new Error(
      'Usage: deploy.ts prepare|deploy [-t <bot>] | undeploy|recover|mongo-prepare|mongo-deploy|mongo-undeploy',
    );
  let target: string | undefined;
  const select = (value: string): void => {
    if (target !== undefined && target !== value)
      throw new Error(`Conflicting target bots: ${target} and ${value}`);
    target = value;
  };
  let consumedByNpm = false;
  for (const flag of DEPLOY_NPM_FLAGS) {
    const value = npmFlags[flag];
    if (value === undefined || value === '' || value === 'false') continue;
    if (value === 'true') consumedByNpm = true;
    else select(value);
  }
  const positionals: string[] = [];
  for (let index = 0; index < extra.length; index++) {
    const token = extra[index]!;
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    if (targetFlags.includes(flag)) {
      const value = separator === -1 ? extra[++index] : token.slice(separator + 1);
      if (!value || value.startsWith('-')) throw new Error('Option -t requires a bot name');
      select(value);
    } else if (token.startsWith('-')) {
      throw new Error(
        'Service commands take only -t <bot>. Use npm run register (all bots) or npm run register -t <bot> for Discord commands.',
      );
    } else positionals.push(token);
  }
  if (positionals.length > 0 || consumedByNpm) {
    if (!consumedByNpm || positionals.length !== 1)
      throw new Error('Pass a single bot as -t <bot>; deployment.json lists the full set');
    select(positionals[0]!);
  }
  if (target === undefined) return { action };
  if (!targetActions.includes(action))
    throw new Error('Option -t applies only to prepare and deploy');
  const parsed = botName.safeParse(target);
  if (!parsed.success)
    throw new Error(`Unknown bot "${target}". Known bots: ${botName.options.join(', ')}`);
  return { action, bot: parsed.data };
}
/**
 * State recorded after deploying only `bot`: its unit comes from `next`, while every other
 * unit keeps its previous content and therefore its previous release directory.
 */
export function mergeTargetRelease(
  previous: Release | undefined,
  next: Release,
  bot: BotName,
): Release {
  const service = botService(bot);
  const unit = next.units[service];
  if (unit === undefined) throw new Error(`Release has no service for ${bot}`);
  return { ...next, units: { ...previous?.units, [service]: unit } };
}
export function validateRelease(input: unknown, root: string): Release {
  const value = z
    .object({
      root: absolutePath,
      directory: absolutePath,
      prefix: absolutePath,
      config: deploymentSchema,
      units: z.record(z.string()),
    })
    .strict()
    .parse(input);
  const base = resolve(root, '.deploy/releases');
  if (
    value.root !== root ||
    resolve(value.directory) !== value.directory ||
    !value.directory.startsWith(`${base}/`)
  )
    throw new Error('Invalid release manifest');
  for (const [name, content] of Object.entries(value.units)) {
    if (
      !/^(?:botfleet@(tomori|nijika|msg-archive|konata|gopher)|mongodb-botfleet)\.service$/.test(
        name,
      ) ||
      !content.startsWith(ownerMarker(root))
    )
      throw new Error('Invalid manifest unit ownership or name');
  }
  return value;
}
