import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackupLog,
  NullBackupLog,
  type BackupTranscript,
} from '../../../src/plugins/message-backup/internal/backup-log';

// Pass-through spies: the file-backed log hits the real disk, while the Null
// Object test can still prove it reaches no filesystem call. (Module mock,
// not `vi.spyOn`, because node:fs's namespace properties are non-configurable
// under ESM and cannot be redefined in place.)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

let root: string;
const opened: BackupTranscript[] = [];

/** Open a log and remember it so a failing test still releases the descriptor. */
const open = (filePath: string): BackupLog => {
  const log = new BackupLog(filePath);
  opened.push(log);
  return log;
};

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-log-'));
});

afterEach(() => {
  for (const log of opened.splice(0)) {
    try {
      log.close();
    } catch {
      // Already closed by the test under inspection.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('BackupLog', () => {
  it('creates the transcript directory and truncates any prior run’s file', () => {
    const filePath = path.join(root, 'logs', 'backup', 'msg-archive-g1-2026-01-01_00-00-00.log');

    const prior = open(filePath);
    prior.writeln('left over from an earlier run');
    prior.close();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('left over from an earlier run\n');

    // Each run owns a fresh, timestamped artifact: reopening starts empty.
    open(filePath);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('');
  });

  it('terminates every line and writes it through synchronously', () => {
    // Synchronous writes are the point: a backup killed mid-pass must
    // still leave every line it reported already on disk, so the file is
    // read back before `close`.
    const filePath = path.join(root, 'run.log');
    const log = open(filePath);

    log.writeln('=== MSG ARCHIVE BACKUP ===');
    log.writeln();

    expect(fs.readFileSync(filePath, 'utf8')).toBe('=== MSG ARCHIVE BACKUP ===\n\n');
  });

  it('releases the descriptor it opened when closed', () => {
    const log = open(path.join(root, 'run.log'));

    log.close();

    // A released descriptor can no longer be written through.
    expect(() => log.writeln('after close')).toThrow(/EBADF/);
  });
});

describe('NullBackupLog', () => {
  it('is a no-op transcript that never touches the filesystem', () => {
    const log: BackupTranscript = new NullBackupLog();
    log.writeln('a line');
    log.writeln();
    log.close();

    // No `logs/backup/` directory or file is ever created.
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.writeSync).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
});
