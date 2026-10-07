/**
 * Unit suite for the unified config loader and per-operation options
 * parser. Targets the pure helpers in `./config.ts`; the process entry
 * point is exercised only through manual runs against a real cluster.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigurationError } from '../../../src/core/errors/configuration-error';

import { loadConfig, parseOptions } from './config';

describe('db / loadConfig', () => {
  let tmpDir: string;
  const writeConfig = (body: unknown): string => {
    const p = join(tmpDir, 'config.json');
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return p;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-config-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a minimal valid config and defaults output_path=null, operations={}', () => {
    const cfg = loadConfig(writeConfig({ mongo_uri: 'mongodb://h/', guilds: ['123'] }));
    expect(cfg.shared).toEqual({ mongoUri: 'mongodb://h/', guilds: ['123'], outputPath: null });
    expect(cfg.operations).toEqual({});
  });

  it('normalises mongo_uri to host-with-trailing-slash, stripping the query string', () => {
    const cfg = loadConfig(
      writeConfig({ mongo_uri: 'mongodb://h/?authSource=admin', guilds: ['1'] }),
    );
    expect(cfg.shared.mongoUri).toBe('mongodb://h/');
  });

  it('re-asserts a single trailing slash on a host with none or several', () => {
    expect(
      loadConfig(writeConfig({ mongo_uri: 'mongodb://h', guilds: ['1'] })).shared.mongoUri,
    ).toBe('mongodb://h/');
    expect(
      loadConfig(writeConfig({ mongo_uri: 'mongodb://h///', guilds: ['1'] })).shared.mongoUri,
    ).toBe('mongodb://h/');
  });

  it('passes operations slices through unchanged', () => {
    const cfg = loadConfig(
      writeConfig({
        mongo_uri: 'mongodb://h/',
        guilds: ['1'],
        operations: { 'drop-xfeed': { dry_run: true }, 'drop-todo': { dry_run: false } },
      }),
    );
    expect(cfg.operations).toEqual({
      'drop-xfeed': { dry_run: true },
      'drop-todo': { dry_run: false },
    });
  });

  it('honours an explicit output_path', () => {
    const cfg = loadConfig(
      writeConfig({ mongo_uri: 'mongodb://h/', guilds: ['1'], output_path: '/tmp/report.json' }),
    );
    expect(cfg.shared.outputPath).toBe('/tmp/report.json');
  });

  it('accepts multiple guild ids', () => {
    const cfg = loadConfig(writeConfig({ mongo_uri: 'mongodb://h/', guilds: ['1', '2', '3'] }));
    expect(cfg.shared.guilds).toEqual(['1', '2', '3']);
  });

  it('rejects a missing file path', () => {
    expect(() => loadConfig(join(tmpDir, 'does-not-exist.json'))).toThrow(ConfigurationError);
  });

  it('rejects malformed JSON', () => {
    expect(() => loadConfig(writeConfig('not json{'))).toThrow(ConfigurationError);
  });

  it('rejects a non-object root', () => {
    expect(() => loadConfig(writeConfig('[]'))).toThrow(ConfigurationError);
  });

  it('rejects a missing mongo_uri', () => {
    expect(() => loadConfig(writeConfig({ guilds: ['1'] }))).toThrow(ConfigurationError);
  });

  it('rejects a missing or empty guilds array', () => {
    expect(() => loadConfig(writeConfig({ mongo_uri: 'mongodb://h/' }))).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig(writeConfig({ mongo_uri: 'mongodb://h/', guilds: [] }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a non-digit guild id', () => {
    expect(() => loadConfig(writeConfig({ mongo_uri: 'mongodb://h/', guilds: ['abc'] }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects an empty-string output_path', () => {
    expect(() =>
      loadConfig(writeConfig({ mongo_uri: 'mongodb://h/', guilds: ['1'], output_path: '' })),
    ).toThrow(ConfigurationError);
  });
});

describe('db / parseOptions', () => {
  const schema = z.object({ x: z.number().int().min(0).default(5) });

  it('applies schema defaults to a missing slice', () => {
    expect(parseOptions(schema, {}, 'demo')).toEqual({ x: 5 });
  });

  it('passes a valid value through', () => {
    expect(parseOptions(schema, { x: 9 }, 'demo')).toEqual({ x: 9 });
  });

  it('throws a ConfigurationError on a schema violation', () => {
    expect(() => parseOptions(schema, { x: -1 }, 'demo')).toThrow(ConfigurationError);
    expect(() => parseOptions(schema, { x: 'nope' }, 'demo')).toThrow(ConfigurationError);
  });

  it('throws a ConfigurationError when a required field is missing', () => {
    const required = z.object({ mode: z.enum(['a', 'b']) });
    expect(() => parseOptions(required, {}, 'demo')).toThrow(ConfigurationError);
  });
});
