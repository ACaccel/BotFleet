import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Newest release directories always kept, in addition to every referenced release. */
export const RETAINED_RELEASES = 3;

const RELEASE_NAME = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Active state files embed the release path in their directory field and unit text. The
// recovery journal is not listed because its presence blocks pruning altogether.
const REFERENCE_FILES = ['current.json', 'mongodb.json'];

export interface PruneResult {
  removed: string[];
  failed: { name: string; message: string }[];
  skipped?: string;
}

/**
 * Removes old release directories under `<root>/.deploy/releases`.
 *
 * Rule: among entries named `<digits>-<uuid>` that are real directories (not symlinks), the
 * `keep` highest numeric prefixes are retained. Independently, any such directory whose name
 * appears in the state files is retained and does not count against
 * those `keep`. All other entries, including non-matching names, are left untouched.
 *
 * Nothing is deleted while a recovery journal exists or while another process holds the lock.
 * Every deletion is verified to resolve directly beneath the real releases directory.
 */
export function pruneReleases(
  root: string,
  lockOwnerPid: number,
  keep = RETAINED_RELEASES,
): PruneResult {
  const result: PruneResult = { removed: [], failed: [] };
  const stateDirectory = join(root, '.deploy');
  if (existsSync(join(stateDirectory, 'transaction.json'))) {
    result.skipped = 'a recovery journal exists';
    return result;
  }
  const lockFile = join(stateDirectory, 'lock');
  if (existsSync(lockFile) && readFileSync(lockFile, 'utf8').trim() !== String(lockOwnerPid)) {
    result.skipped = 'another deployment holds the lock';
    return result;
  }
  const releases = join(stateDirectory, 'releases');
  if (!existsSync(releases)) return result;
  const base = realpathSync(releases);
  if (base !== join(realpathSync(root), '.deploy', 'releases')) {
    result.skipped = 'the releases directory resolves elsewhere';
    return result;
  }
  const references = REFERENCE_FILES.map((name) => join(stateDirectory, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const candidates = readdirSync(base)
    .flatMap((name) => {
      const match = RELEASE_NAME.exec(name);
      return match ? [{ name, stamp: BigInt(match[1]!) }] : [];
    })
    .filter(({ name }) => {
      const stat = lstatSync(join(base, name));
      return stat.isDirectory() && !stat.isSymbolicLink();
    })
    .sort((a, b) => (a.stamp === b.stamp ? 0 : a.stamp > b.stamp ? -1 : 1));
  for (const { name } of candidates.slice(keep)) {
    if (references.includes(name)) continue;
    const target = join(base, name);
    try {
      if (realpathSync(target) !== target) throw new Error('Release resolves outside releases');
      // rmSync unlinks symlinks inside the tree (shared data, logs, configuration) without
      // following them.
      rmSync(target, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error) {
      result.failed.push({
        name,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return result;
}

/** Prunes after a committed deployment; failures are reported as warnings, never thrown. */
export function pruneAfterDeploy(
  root: string,
  lockOwnerPid: number,
  log: Pick<Console, 'log' | 'warn'> = console,
): void {
  try {
    const { removed, failed, skipped } = pruneReleases(root, lockOwnerPid);
    if (skipped) log.warn(`Skipped release cleanup: ${skipped}.`);
    if (removed.length > 0) log.log(`Removed ${removed.length} old release(s).`);
    for (const { name, message } of failed)
      log.warn(`Warning: could not remove release ${name}: ${message}`);
  } catch (error) {
    log.warn(
      `Warning: release cleanup failed; deployment is unaffected: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
