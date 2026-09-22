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
export function parseAction(args: readonly string[]): string {
  const [action, ...extra] = args;
  if (extra.length > 0)
    throw new Error(
      'Service commands take no registration flags. Use yarn register -t <bot> for Discord commands; edit deployment.json for service selection.',
    );
  if (
    !action ||
    ![
      'prepare',
      'deploy',
      'undeploy',
      'recover',
      'mongo-prepare',
      'mongo-deploy',
      'mongo-undeploy',
    ].includes(action)
  )
    throw new Error(
      'Usage: deploy.ts prepare|deploy|undeploy|recover|mongo-prepare|mongo-deploy|mongo-undeploy',
    );
  return action;
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
