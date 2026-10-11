/**
 * System `zip` / `unzip` adapter for the ops CLI.
 *
 * The legacy-archive export packs and verifies its output with the
 * Info-ZIP binaries that `environment.yml` installs into the project
 * Conda runtime, rather than an npm archive library: the binaries stream
 * from disk, keep the dependency tree unchanged, and produce archives any
 * operator can inspect by hand.
 *
 * Every invocation passes an argument array to `spawn` — never a shell
 * string — with stdin closed, a timeout, and the Info-ZIP option
 * variables removed from the environment so an operator's shell settings
 * cannot change what is packed or tested. Callers pass absolute archive
 * paths and validated entry names, so no argument can be read as an
 * option or a wildcard.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Executable names (or absolute paths) of the two binaries. */
interface ZipToolsOptions {
  readonly zip: string;
  readonly unzip: string;
  /** Per-invocation ceiling; a multi-gigabyte archive takes minutes, a hang never ends. */
  readonly timeoutMs?: number;
}

/** The archive operations the export and drop commands need. */
export interface ZipTools {
  /** Fail fast when either binary cannot be executed. */
  assertAvailable(): Promise<void>;
  /** Recursively pack the contents of `sourceDir` into the new archive `zipPath`. */
  create(sourceDir: string, zipPath: string): Promise<void>;
  /** Run the archive's own CRC integrity test (`unzip -t`). */
  test(zipPath: string): Promise<void>;
  /** Entry names, one per stored file (`unzip -Z1`). */
  list(zipPath: string): Promise<string[]>;
  /**
   * Stream one entry (`unzip -p`) into `consume`, which must read the
   * stream to its end. Nothing is written to disk.
   */
  readEntry<T>(
    zipPath: string,
    entry: string,
    consume: (input: Readable) => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Captured stdout/stderr ceiling; only `list` output and error text are captured. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** Info-ZIP reads default options from these variables. */
const INFO_ZIP_ENV = ['ZIP', 'ZIPOPT', 'UNZIP', 'UNZIPOPT'] as const;

const childEnv = (): NodeJS.ProcessEnv => {
  // eslint-disable-next-line no-restricted-syntax -- the child inherits the environment minus Info-ZIP's option variables; this is not a configuration read.
  const env = { ...process.env };
  for (const name of INFO_ZIP_ENV) delete env[name];
  return env;
};

type Child = ChildProcessByStdio<null, Readable, Readable>;

const capture = (stream: Readable): (() => string) => {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_CAPTURE_BYTES) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
};

/** Resolve on exit 0; reject with the binary, exit code or signal, and stderr otherwise. */
const completion = (
  child: Child,
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  stderr: () => string,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    let settled = false;
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `"${binary}" was not found on PATH; run "bash scripts/setup-env.sh" to install it`
            : `${binary} could not start: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      const ended =
        signal === null
          ? `exit ${String(code)}`
          : `signal ${signal}; the timeout is ${String(timeoutMs)} ms`;
      reject(new Error(`${binary} ${args[0] ?? ''} failed (${ended}): ${stderr().trim()}`));
    });
  });

export const createZipTools = (
  options: ZipToolsOptions = { zip: 'zip', unzip: 'unzip' },
): ZipTools => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = (binary: string, args: readonly string[], cwd?: string) => {
    const child: Child = spawn(binary, [...args], {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    const stderr = capture(child.stderr);
    const done = completion(child, binary, args, timeoutMs, stderr);
    // Observed here so an early exit never surfaces as an unhandled rejection; callers still await it.
    done.catch(() => undefined);
    return { child, done };
  };
  const run = async (binary: string, args: readonly string[], cwd?: string): Promise<string> => {
    const { child, done } = start(binary, args, cwd);
    const stdout = capture(child.stdout);
    await done;
    return stdout();
  };

  return {
    assertAvailable: async () => {
      // `-v` prints version information and exits 0 on both Info-ZIP tools.
      await run(options.zip, ['-v']);
      await run(options.unzip, ['-v']);
    },
    // `-X` drops extra file attributes and `-D` omits directory entries, so an
    // archive holds exactly the manifest and the data files it lists.
    create: async (sourceDir, zipPath) => {
      await run(options.zip, ['-r', '-q', '-X', '-D', zipPath, '.'], sourceDir);
    },
    test: async (zipPath) => {
      await run(options.unzip, ['-t', '-qq', zipPath]);
    },
    list: async (zipPath) =>
      (await run(options.unzip, ['-Z1', zipPath])).split('\n').filter((line) => line.length > 0),
    readEntry: async (zipPath, entry, consume) => {
      const { child, done } = start(options.unzip, ['-p', zipPath, entry]);
      try {
        const result = await consume(child.stdout);
        await done;
        return result;
      } catch (error: unknown) {
        // A consumer that stops early leaves unzip blocked on a full pipe; end it.
        child.kill('SIGKILL');
        child.stdout.destroy();
        await done.catch(() => undefined);
        throw error;
      }
    },
  };
};
