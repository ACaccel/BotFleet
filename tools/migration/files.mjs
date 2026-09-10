import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);

/** @param {string} value @returns {boolean} */
function hasControlCharacters(value) {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** @param {string} message @returns {never} */
export function fail(message) {
  throw new Error(message);
}

/** @param {string} parent @param {string} child @returns {boolean} */
export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Reject symlink ancestors, including for destinations not created yet.
 * @param {string} value @returns {Promise<string>}
 */
export async function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || hasControlCharacters(value))
    fail('Paths must be absolute and contain no control characters.');
  const resolved = path.resolve(value);
  if (resolved === '/') fail('Filesystem root is not a valid deployment path.');
  let cursor = resolved;
  while (cursor !== '/') {
    const stat = await fs.lstat(cursor).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) fail('Symlinks are not allowed in deployment paths.');
    cursor = path.dirname(cursor);
  }
  return resolved;
}

/** @param {string} filename @returns {Promise<string>} */
export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** @param {string} filename @param {unknown} value @returns {Promise<void>} */
export async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

/** @param {string} filename @returns {Promise<unknown>} */
export async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

/** @typedef {{path: string, size: number, sha256: string, executable: boolean}} FileRecord */

/** @param {string} root @param {(relative: string) => boolean} [exclude] @returns {Promise<FileRecord[]>} */
export async function inventoryFiles(root, exclude = () => false) {
  /** @type {FileRecord[]} */
  const result = [];
  await safePath(root);
  async function walk(relative) {
    const directory = path.join(root, relative);
    const entries = (await fs.readdir(directory)).sort();
    for (const name of entries) {
      const child = path.join(relative, name);
      if (exclude(child)) continue;
      validRelative(child);
      const filename = path.join(root, child);
      const before = await fs.lstat(filename);
      if (before.isSymbolicLink()) fail('Bundle inputs must not contain symlinks.');
      if (before.isDirectory()) await walk(child);
      else if (before.isFile()) {
        const sha256 = await hashFile(filename);
        const after = await fs.lstat(filename);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ino !== after.ino ||
          before.mode !== after.mode ||
          before.ctimeMs !== after.ctimeMs
        )
          fail('A file changed during inventory; stop writers and retry with a fresh bundle.');
        result.push({
          path: child,
          size: after.size,
          sha256,
          executable: Boolean(after.mode & 0o111),
        });
      } else fail('Bundle inputs must contain only regular files and directories.');
    }
  }
  await walk('');
  return result;
}

/** @param {string} relative @returns {void} */
function validRelative(relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    hasControlCharacters(relative) ||
    relative.split(path.sep).some((part) => part === '..' || part === '.' || part === '')
  )
    fail('Unsafe bundle file path.');
}

/** @param {string} relative @returns {boolean} */
export function excludeCode(relative) {
  const parts = relative.split(path.sep);
  return (
    parts.some((part) => ['.git', '.plan', 'node_modules', 'dist', 'coverage'].includes(part)) ||
    (parts[0] === 'tools' &&
      parts[1] === 'migration' &&
      (['.state', 'runs', 'dump', 'tmp', 'temp', '.local', 'backups'].includes(parts[2]) ||
        /(?:\.tar\.gz|\.archive\.gz|\.local\.[^/]+)$/.test(parts[2] ?? '') ||
        /^config(?:\..*)?\.json$/.test(parts[2] ?? '') ||
        parts[2] === 'config.json'))
  );
}

/** Inventory only ignored local runtime data; Git determines the inclusion rules.
 * @param {string} repo @returns {Promise<FileRecord[]>}
 */
export async function inventoryIgnored(repo) {
  await safePath(repo);
  const options = {
    cwd: repo,
    encoding: /** @type {const} */ ('utf8'),
    maxBuffer: 64 * 1024 * 1024,
  };
  const { stdout } = await git(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    options,
  );
  const { stdout: trackedOutput } = await git('git', ['ls-files', '-z'], options);
  const tracked = new Set(trackedOutput.split('\0').filter(Boolean));
  /** @type {Map<string, FileRecord>} */
  const selected = new Map();
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const relative = entry.replace(/\/$/, '');
    validRelative(relative);
    if (excludeCode(relative)) continue;
    const filename = path.join(repo, relative);
    await safePath(filename);
    const stat = await fs.lstat(filename);
    const records = stat.isDirectory()
      ? (await inventoryFiles(filename, (child) => excludeCode(path.join(relative, child)))).map(
          (record) => ({ ...record, path: path.join(relative, record.path) }),
        )
      : await inventoryFiles(path.dirname(filename), (child) => child !== path.basename(filename));
    for (const record of records) {
      const finalRecord = stat.isDirectory() ? record : { ...record, path: relative };
      if (!tracked.has(finalRecord.path)) selected.set(finalRecord.path, finalRecord);
    }
  }
  // Match directory-first DFS ordering used by the complete bundle inventory.
  return [...selected.values()].sort((left, right) => {
    const a = left.path.split(path.sep);
    const b = right.path.split(path.sep);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  });
}

/** @param {string} source @param {string} target @param {FileRecord[]} records @returns {Promise<void>} */
export async function copyRecords(source, target, records) {
  await safePath(source);
  await safePath(target);
  const seen = new Set();
  for (const record of records) {
    validRelative(record.path);
    if (seen.has(record.path)) fail('Duplicate bundle file path.');
    seen.add(record.path);
    const filename = path.join(source, record.path);
    const destination = path.join(target, record.path);
    await safePath(filename);
    await safePath(destination);
    const before = await fs.lstat(filename);
    if (!before.isFile()) fail('Bundle inputs must contain only regular files.');
    if (
      before.size !== record.size ||
      Boolean(before.mode & 0o111) !== record.executable ||
      (await hashFile(filename)) !== record.sha256
    )
      fail('Source file changed before copying.');
    const existing = await fs.lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) fail('Destination file already exists; restore requires absent runtime files.');
    let ancestor = path.dirname(destination);
    while (contains(target, ancestor)) {
      const stat = await fs.lstat(ancestor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && !stat.isDirectory()) fail('Destination ancestor must be a directory.');
      if (ancestor === target) break;
      ancestor = path.dirname(ancestor);
    }
  }
  for (const record of records) {
    const filename = path.join(source, record.path);
    const destination = path.join(target, record.path);
    await safePath(filename);
    await safePath(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(filename, destination, 1);
    await fs.chmod(destination, record.executable ? 0o700 : 0o600);
    if ((await hashFile(destination)) !== record.sha256)
      fail('File changed while copying; destination is incomplete.');
  }
}

/** @typedef {{format: number, createdAt: string, gitCommit: string, mongoEnv: string, databases: string[], mongoVersion: string, toolsVersion: string, mongoPort: number, files: FileRecord[]}} Manifest */

/** Verify the complete tree, including unexpected additions.
 * @param {string} bundle @returns {Promise<{manifest: Manifest, id: string}>}
 */
export async function checkBundle(bundle) {
  await safePath(bundle);
  await safePath(path.join(bundle, 'manifest.json'));
  if (!(await fs.lstat(path.join(bundle, 'manifest.json'))).isFile())
    fail('Manifest must be a regular file.');
  const manifest = /** @type {Manifest} */ (await readJson(path.join(bundle, 'manifest.json')));
  if (!manifest || manifest.format !== 2 || !Array.isArray(manifest.files))
    fail('Unsupported or incomplete bundle.');
  const actual = await inventoryFiles(bundle, (name) => name === 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    fail('Bundle checksum or file inventory mismatch.');
  return { manifest, id: await hashFile(path.join(bundle, 'manifest.json')) };
}
