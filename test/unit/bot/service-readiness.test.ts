import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceReadiness } from '../../../src/bot/service-readiness';

describe('ServiceReadiness', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'readiness-marker-'));
    file = join(directory, 'ready.json');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('publishes a private, immutable startup attestation', () => {
    const readiness = new ServiceReadiness(file);
    readiness.publish();
    const content = readFileSync(file, 'utf8');
    readiness.publish();
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('cannot publish after shutdown even if an asynchronous callback finishes late', () => {
    const readiness = new ServiceReadiness(file);
    readiness.stop();
    readiness.publish();
    readiness.stop();
    expect(existsSync(file)).toBe(false);
  });

  it('propagates filesystem failures without leaving a temporary marker', () => {
    const readiness = new ServiceReadiness(file);
    rmSync(directory, { recursive: true });
    expect(() => readiness.publish()).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});
