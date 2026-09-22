import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import {
  parseAction,
  validateRelease,
  ownerMarker,
  mongoService,
  type Release,
} from './deployment/config';
import { atomic, run, serviceOps, inspectUnit } from './deployment/host';
import {
  makeRelease,
  readConfig,
  assertNoUnmanagedProcesses,
  relativeRelease,
} from './deployment/release';
import { applyUnits, restore, type Transaction } from './deployment/transaction';

const root = realpathSync(resolve(__dirname, '..'));
const stateDirectory = join(root, '.deploy');
const journalPath = join(stateDirectory, 'transaction.json');
interface Journal {
  release: Release;
  transaction: Transaction;
  stateName: 'current.json' | 'mongodb.json';
  previous: string | null;
  desired: string | null;
}
function readRelease(path: string): Release | undefined {
  return existsSync(path)
    ? validateRelease(JSON.parse(readFileSync(path, 'utf8')) as Release, root)
    : undefined;
}
function saveState(path: string, content: string | null): void {
  if (content === null) rmSync(path, { force: true });
  else atomic(path, content);
}
function lock(): () => void {
  const file = join(stateDirectory, 'lock');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid deployment lock; inspect .deploy/lock before removing it');
    try {
      process.kill(pid, 0);
      throw new Error('Another deployment is running');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    rmSync(file);
  }
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return () => rmSync(file, { force: true });
}
function validateJournal(journal: Journal): void {
  validateRelease(journal.release, root);
  if (
    !['current.json', 'mongodb.json'].includes(journal.stateName) ||
    journal.release.config.user !== userInfo().username
  )
    throw new Error('Invalid recovery journal owner or state');
  for (const [name, state] of Object.entries(journal.transaction.before)) {
    if (
      !/^(?:botfleet@(tomori|nijika|msg-archive|konata|gopher)|mongodb-botfleet)\.service$/.test(
        name,
      )
    )
      throw new Error('Invalid recovery unit name');
    if (state.content !== null && !state.content.startsWith(ownerMarker(root)))
      throw new Error('Invalid recovery unit ownership');
  }
}
async function recover(): Promise<void> {
  if (!existsSync(journalPath)) {
    console.log('No interrupted deployment to recover.');
    return;
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  validateJournal(journal);
  const statePath = join(stateDirectory, journal.stateName);
  const current = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
  if (current === journal.desired) {
    rmSync(journalPath);
    console.log('Finalized the completed deployment transaction.');
    return;
  }
  run('sudo', ['-v'], { quiet: false });
  await restore(
    journal.transaction,
    serviceOps(
      journal.release,
      () => undefined,
      journal.previous === null ? undefined : validateRelease(JSON.parse(journal.previous), root),
    ),
  );
  saveState(statePath, journal.previous);
  rmSync(journalPath);
  console.log('Restored the previous managed services.');
}
async function main(): Promise<void> {
  const action = parseAction(process.argv.slice(2));
  if (process.getuid?.() === 0)
    throw new Error('Run as your ordinary user; system changes request sudo');
  if (/[\r\n\0]/.test(root)) throw new Error('Unsupported project path');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const unlock = lock();
  try {
    if (action === 'recover') {
      await recover();
      return;
    }
    if (existsSync(journalPath))
      throw new Error('An interrupted deployment needs npm run deploy:recover first');
    const mongodbOnly = action.startsWith('mongo-');
    const stateName = mongodbOnly ? 'mongodb.json' : 'current.json';
    const statePath = join(stateDirectory, stateName);
    const previous = readRelease(statePath);
    const removing = action.endsWith('undeploy');
    if (removing && !previous) {
      console.log('No managed deployment to remove.');
      return;
    }
    const config = removing && previous ? previous.config : readConfig(root);
    if (config.user !== userInfo().username)
      throw new Error('Run as the configured deployment owner');
    let release: Release;
    if (removing && previous) release = previous;
    else {
      if (!mongodbOnly)
        run(
          process.execPath,
          [join(root, 'scripts/runtime.mjs'), 'exec', 'tsc', '-p', 'tsconfig.strict.json'],
          { cwd: root, quiet: false },
        );
      release = makeRelease(root, config, mongodbOnly);
      console.log(
        `Prepared ${relativeRelease(root, release)}. Review the manifest and service files.`,
      );
    }
    if (action.endsWith('prepare')) return;
    const names = new Set([...Object.keys(previous?.units ?? {}), ...Object.keys(release.units)]);
    for (const name of names) inspectUnit(root, name);
    const managedPids = [...names]
      .map((name) =>
        Number(run('systemctl', ['show', name, '--property=MainPID', '--value']).trim()),
      )
      .filter((pid) => pid > 0);
    if (!removing)
      assertNoUnmanagedProcesses(
        root,
        config.bots,
        managedPids,
        mongodbOnly ? config.mongodb?.prefix : undefined,
      );
    if (mongodbOnly && removing && existsSync(join(stateDirectory, 'current.json')))
      throw new Error('Undeploy the managed bots before removing their database service');
    if (!mongodbOnly && !removing && config.mongodb && !inspectUnit(root, mongoService).active)
      throw new Error('Deploy and verify the local MongoDB service before deploying bots');
    run('sudo', ['-v'], { quiet: false });
    const previousState = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
    const desired = removing ? null : JSON.stringify(release, null, 2) + '\n';
    const after = Object.fromEntries(
      [...names].map((name) => [name, removing ? null : (release.units[name] ?? null)]),
    );
    const ops = serviceOps(
      release,
      (transaction) => {
        if (transaction === null) rmSync(journalPath, { force: true });
        else
          atomic(
            journalPath,
            JSON.stringify(
              {
                release,
                transaction,
                stateName,
                previous: previousState,
                desired,
              } satisfies Journal,
              null,
              2,
            ) + '\n',
          );
      },
      previous,
    );
    await applyUnits(after, ops, () => saveState(statePath, desired));
    console.log(
      removing
        ? 'Managed services removed; data, environments and releases retained.'
        : 'Deployment is ready and enabled for boot.',
    );
  } finally {
    unlock();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Deployment failed');
  process.exitCode = 1;
});
