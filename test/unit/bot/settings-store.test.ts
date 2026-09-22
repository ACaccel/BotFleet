/**
 * Unit tests for GopherSettingsStore: it seeds the live endpoint from the
 * `llm_auto_reply` block handed in at construction (no boot-time file read),
 * tolerates a missing/malformed endpoint, and persists updates to config.json
 * while preserving every other key with a 2-space indent.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GopherSettingsStore } from '../../../src/bot/gopher/settings-store';

describe('GopherSettingsStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gopher-store-'));
    file = path.join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          language: 'zh-TW',
          llm_auto_reply: {
            enabled: true,
            endpoint: 'https://old.invalid/chat',
            probability: 0.03,
          },
          identity_sync: { enabled: true },
        },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the initial endpoint from the provided config block', () => {
    const store = new GopherSettingsStore(file, {
      enabled: true,
      endpoint: 'https://old.invalid/chat',
      probability: 0.03,
    });
    expect(store.getEndpoint()).toBe('https://old.invalid/chat');
  });

  it('defaults to an empty endpoint when the block is missing or malformed', () => {
    expect(new GopherSettingsStore(file, undefined).getEndpoint()).toBe('');
    expect(new GopherSettingsStore(file, {}).getEndpoint()).toBe('');
    expect(new GopherSettingsStore(file, { endpoint: 42 }).getEndpoint()).toBe('');
  });

  it('updates the live endpoint and persists it, preserving other keys', async () => {
    const store = new GopherSettingsStore(file, { endpoint: 'https://old.invalid/chat' });
    await store.setEndpoint('https://new.invalid/chat');

    expect(store.getEndpoint()).toBe('https://new.invalid/chat');
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const llm = persisted.llm_auto_reply as Record<string, unknown>;
    expect(llm.endpoint).toBe('https://new.invalid/chat');
    // Sibling keys inside and outside the llm block are preserved.
    expect(llm.probability).toBe(0.03);
    expect(llm.enabled).toBe(true);
    expect(persisted.language).toBe('zh-TW');
    expect(persisted.identity_sync).toEqual({ enabled: true });
  });

  it('updates the shared config target while preserving release symlinks', async () => {
    const release = path.join(dir, 'release');
    mkdirSync(release);
    const linkedConfig = path.join(release, 'config.json');
    symlinkSync('../config.json', linkedConfig);
    const store = new GopherSettingsStore(linkedConfig, { endpoint: 'https://old.invalid/chat' });
    await store.setEndpoint('https://new.invalid/chat');

    expect(lstatSync(linkedConfig).isSymbolicLink()).toBe(true);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(persisted.language).toBe('zh-TW');
    expect(persisted.llm_auto_reply).toMatchObject({
      endpoint: 'https://new.invalid/chat',
      probability: 0.03,
    });
    expect(readFileSync(linkedConfig, 'utf8')).toBe(readFileSync(file, 'utf8'));
  });

  it('writes 2-space-indented JSON with a trailing newline', async () => {
    const store = new GopherSettingsStore(file, { endpoint: 'https://old.invalid/chat' });
    await store.setEndpoint('https://new.invalid/chat');
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "llm_auto_reply"');
  });

  it('serializes concurrent writes without corrupting the file', async () => {
    const store = new GopherSettingsStore(file, { endpoint: 'https://old.invalid/chat' });
    await Promise.all([
      store.setEndpoint('https://a.invalid/chat'),
      store.setEndpoint('https://b.invalid/chat'),
      store.setEndpoint('https://c.invalid/chat'),
    ]);
    // The file is valid JSON (no interleaved/truncated write), unrelated keys
    // survive, and the persisted endpoint matches the live in-memory value.
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(persisted.language).toBe('zh-TW');
    const llm = persisted.llm_auto_reply as Record<string, unknown>;
    expect(llm.endpoint).toBe(store.getEndpoint());
  });
});
