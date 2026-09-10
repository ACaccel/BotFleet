import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface Inventory {
  version: string;
  databases: Array<{
    name: string;
    collections: Array<{
      name: string;
      type: string;
      options: Record<string, unknown>;
      count?: number;
      indexes?: Array<Record<string, unknown>>;
    }>;
  }>;
}

const require = createRequire(__filename);
const { validateDatabases, normalizeInventory, compareInventories, readPrivateRequest } =
  require('./mongo.cjs') as {
    validateDatabases: (value: unknown) => string[];
    normalizeInventory: (value: Inventory) => Inventory;
    compareInventories: (expected: Inventory, actual: Inventory) => string | null;
    readPrivateRequest: (filename: string) => unknown;
  };

function inventory(key = { channel: 1, timestamp: -1 }): Inventory {
  return {
    version: '7.0.34',
    databases: [
      {
        name: 'guild_123',
        collections: [
          {
            name: 'messages',
            type: 'collection',
            options: {},
            count: 12,
            indexes: [{ name: 'channel_timestamp', key, v: 2, ns: 'guild_123.messages' }],
          },
        ],
      },
    ],
  };
}

describe('migration MongoDB metadata', () => {
  it.each([[], ['admin'], ['config'], ['local'], ['a', 'a'], ['bad.name'], [''], ['a'.repeat(64)]])(
    'rejects invalid database selection %j',
    (...names) =>
      expect(() =>
        validateDatabases(names.length === 1 && Array.isArray(names[0]) ? names[0] : names),
      ).toThrow(),
  );

  it('sorts selected database names without mutating the input', () => {
    const names = ['z', 'guild_123', 'a'];
    expect(validateDatabases(names)).toEqual(['a', 'guild_123', 'z']);
    expect(names[0]).toBe('z');
  });

  it('ignores server-generated index metadata and patch version', () => {
    const actual = inventory();
    actual.version = '7.0.35';
    actual.databases[0]!.collections[0]!.indexes![0]!.v = 1;
    delete actual.databases[0]!.collections[0]!.indexes![0]!.ns;
    expect(compareInventories(inventory(), actual)).toBeNull();
  });

  it('detects changes in compound index key order', () => {
    expect(compareInventories(inventory(), inventory({ timestamp: -1, channel: 1 }))).toBe(
      'database inventory',
    );
  });

  it('detects count changes, missing collections, index options, and major versions', () => {
    const actual = inventory();
    actual.databases[0]!.collections[0]!.count = 11;
    expect(compareInventories(inventory(), actual)).toBe('database inventory');
    actual.databases[0]!.collections[0]!.count = 12;
    actual.databases[0]!.collections[0]!.indexes![0]!.unique = true;
    expect(compareInventories(inventory(), actual)).toBe('database inventory');
    actual.databases[0]!.collections = [];
    expect(compareInventories(inventory(), actual)).toBe('database inventory');
    actual.version = '8.0.1';
    expect(compareInventories(inventory(), actual)).toBe('version');
  });

  it('compares view definitions without counting views', () => {
    const actual = inventory();
    actual.databases[0]!.collections.push({
      name: 'recent',
      type: 'view',
      options: { viewOn: 'messages', pipeline: [{ $match: { active: true } }] },
    });
    const normalized = normalizeInventory(actual);
    expect(normalized.databases[0]!.collections[1]).not.toHaveProperty('count');
    expect(compareInventories(actual, normalized)).toBeNull();
    normalized.databases[0]!.collections[1]!.options.viewOn = 'other';
    expect(compareInventories(actual, normalized)).toBe('database inventory');
  });

  it('detects a changed sort priority in a view pipeline', () => {
    const expected = inventory();
    expected.databases[0]!.collections.push({
      name: 'sorted',
      type: 'view',
      options: { viewOn: 'messages', pipeline: [{ $sort: { channel: 1, timestamp: -1 } }] },
    });
    const actual = structuredClone(expected);
    actual.databases[0]!.collections[1]!.options.pipeline = [
      { $sort: { timestamp: -1, channel: 1 } },
    ];
    expect(compareInventories(expected, actual)).toBe('database inventory');
  });
});

describe('private migration request', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((directory) => rmSync(directory, { recursive: true, force: true })),
  );

  it('accepts private requests and rejects exposed files and symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'migration-request-'));
    directories.push(directory);
    const path = join(directory, 'request.json');
    writeFileSync(path, JSON.stringify({ action: 'ping' }), { mode: 0o600 });
    expect(readPrivateRequest(path)).toEqual({ action: 'ping' });
    const link = join(directory, 'link.json');
    symlinkSync(path, link);
    expect(() => readPrivateRequest(link)).toThrow();
    chmodSync(path, 0o644);
    expect(() => readPrivateRequest(path)).toThrow();
  });
});
