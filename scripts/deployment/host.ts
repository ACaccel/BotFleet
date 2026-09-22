import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerMarker, mongoService, type Release } from './config';
import { waitForMongo } from './mongo-probe';
import type { ServiceOps, Transaction, UnitState } from './transaction';

export function run(
  program: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean; timeoutMs?: number } = {},
): string {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.quiet === false ? 'inherit' : 'pipe',
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} ${args[0] ?? ''} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
    );
  return result.stdout ?? '';
}
export function atomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function field(unit: string, property: string): string {
  return run('systemctl', ['show', unit, `--property=${property}`, '--value']).trim();
}
export function inspectUnit(root: string, unit: string, allowTransitional = false): UnitState {
  const target = `/etc/systemd/system/${unit}`;
  const fragment = field(unit, 'FragmentPath');
  if (fragment && fragment !== target)
    throw new Error(`${unit} already belongs to another service definition`);
  if (field(unit, 'DropInPaths'))
    throw new Error(`${unit} has overrides; remove or reconcile them before deployment`);
  let content: string | null = null;
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw new Error(`Refusing non-regular unit: ${target}`);
    content = readFileSync(target, 'utf8');
    if (!content.startsWith(ownerMarker(root))) throw new Error(`Refusing unmanaged unit: ${unit}`);
  }
  const state = field(unit, 'UnitFileState');
  if (state && !['enabled', 'disabled'].includes(state))
    throw new Error(`Unsupported unit state for ${unit}: ${state}`);
  const active = field(unit, 'ActiveState');
  if (!allowTransitional && ['activating', 'deactivating', 'reloading'].includes(active))
    throw new Error(`${unit} is changing state; retry when it is stable`);
  return {
    content,
    enabled: state === 'enabled',
    active: ['active', 'activating', 'deactivating', 'reloading'].includes(active),
  };
}
export function readyMarkerMatches(value: unknown, pid: number, since: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    pid > 0 &&
    record.pid === pid &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt) &&
    typeof record.readyAt === 'number' &&
    Number.isFinite(record.readyAt) &&
    record.readyAt >= record.startedAt &&
    record.readyAt >= since
  );
}
export function serviceOps(
  release: Release,
  journal: (value: Transaction | null) => void,
  previousRelease?: Release,
): ServiceOps {
  const starts = new Map<string, number>();
  return {
    inspect: (unit, restoring) => inspectUnit(release.root, unit, restoring),
    journal,
    write(unit, content) {
      inspectUnit(release.root, unit);
      const target = `/etc/systemd/system/${unit}`;
      if (content === null) {
        run('sudo', ['rm', '-f', '--', target]);
        return;
      }
      if (!content.startsWith(ownerMarker(release.root))) throw new Error('Invalid unit ownership');
      const temporary = join(release.root, '.deploy', `${unit}.install`);
      atomic(temporary, content);
      try {
        run('sudo', ['install', '-m', '0644', '--', temporary, target]);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    system(action, unit) {
      if (action === 'start' && unit) starts.set(unit, Date.now());
      run(
        'sudo',
        ['systemctl', action === 'reload' ? 'daemon-reload' : action, ...(unit ? [unit] : [])],
        { quiet: false, timeoutMs: (release.config.readinessTimeoutSeconds + 90) * 1000 },
      );
    },
    async ready(unit, restoring) {
      const readinessRelease = restoring ? (previousRelease ?? release) : release;
      const since = starts.get(unit) ?? Date.now();
      const deadline = since + readinessRelease.config.readinessTimeoutSeconds * 1000;
      if (unit === mongoService) {
        if (!readinessRelease.config.mongodb) throw new Error('Missing MongoDB configuration');
        await waitForMongo(
          readinessRelease.config.mongodb.probeEnvFile,
          readinessRelease.config.readinessTimeoutSeconds,
        );
        if (field(unit, 'ActiveState') !== 'active')
          throw new Error('MongoDB service is not active');
        return;
      }
      const bot = /^botfleet@([a-z-]+)\.service$/.exec(unit)?.[1];
      if (!bot) throw new Error('Invalid bot service');
      while (Date.now() < deadline) {
        const state = field(unit, 'ActiveState');
        if (state === 'failed') throw new Error(`${unit} failed; inspect journalctl -u ${unit}`);
        const pid = Number(field(unit, 'MainPID'));
        const readyFile = `/run/botfleet-${bot}/ready.json`;
        if (state === 'active' && existsSync(readyFile)) {
          try {
            if (
              readyMarkerMatches(JSON.parse(readFileSync(readyFile, 'utf8')), pid, since) &&
              field(unit, 'ActiveState') === 'active' &&
              Number(field(unit, 'MainPID')) === pid
            )
              return;
          } catch {
            /* A process may remove its marker during shutdown. */
          }
        }
        await delay(500);
      }
      throw new Error(`${unit} did not report Discord/database readiness before the deadline`);
    },
  };
}
