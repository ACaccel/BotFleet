/**
 * Integration test for the settings-api plugin's HTTP route.
 *
 * Drives the plugin's real `start` lifecycle hook (a live Express server
 * on a pre-reserved free port) and asserts the auth gate, body validation,
 * read/update of the injected endpoint cell, and that `onShutdown` releases
 * the socket. Also covers the two fail-closed skips (disabled, missing key):
 * the server must not listen at all.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createSettingsApiPlugin } from '../../../src/plugins/settings-api';
import type { TypedResolver } from '../../../src/core/plugin';
import { buildPluginContext, silentLogger } from '../../fixtures/runtime';

/**
 * Port the server bound, read from its listen log line. The server is
 * configured with port 0 so concurrent suites never race for a port
 * reserved and released ahead of time.
 */
const boundPort = (infoLines: ReadonlyArray<readonly unknown[]>): number | undefined => {
  for (const [msg] of infoLines) {
    const port = /listening on 127\.0\.0\.1:(\d+)/.exec(String(msg))?.[1];
    if (port !== undefined) return Number(port);
  }
  return undefined;
};

/**
 * Where the fail-closed skips point their requests: above the Linux
 * ephemeral range (32768-60999), so a concurrent suite's OS-assigned
 * port never lands here and nothing listens on it.
 */
const NEVER_BOUND_PORT = 65535;

// settings-api does not resolve from the container; a throwing stub
// documents that nothing in this plugin reaches for a token.
const noResolve: TypedResolver = () => {
  throw new Error('settings-api must not resolve container tokens');
};

const API_KEY = 'test-secret-key';

let activeShutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await activeShutdown?.();
  activeShutdown = undefined;
});

interface Harness {
  readonly url: (path: string) => string;
  readonly setEndpoint: Mock<(url: string) => Promise<void>>;
}

/**
 * Stand up an enabled settings-api server on an OS-assigned port with a
 * mutable endpoint cell, returning helpers to drive it. Registers
 * teardown. A skipped start (disabled, no key) logs no listen line, so
 * its URLs point at {@link NEVER_BOUND_PORT}.
 */
const startServer = async (
  overrides: { apiKey?: string | undefined; enabled?: boolean } = {},
): Promise<Harness> => {
  const logger = silentLogger();
  const info = vi.spyOn(logger, 'info');
  const ctx = buildPluginContext({ logger, resolve: noResolve });
  const setEndpoint = vi.fn<(url: string) => Promise<void>>();
  const state = { current: 'https://old.invalid/chat' };
  setEndpoint.mockImplementation(async (url: string) => {
    state.current = url;
  });

  const plugin = createSettingsApiPlugin(
    { enabled: overrides.enabled ?? true, host: '127.0.0.1' },
    {
      port: 0,
      apiKey: 'apiKey' in overrides ? overrides.apiKey : API_KEY,
      getEndpoint: () => state.current,
      setEndpoint,
    },
  );
  await plugin.start?.(ctx);
  activeShutdown = async () => {
    await plugin.onShutdown?.(ctx);
  };
  const port = boundPort(info.mock.calls) ?? NEVER_BOUND_PORT;
  return {
    url: (path: string) => `http://127.0.0.1:${port}/settings${path}`,
    setEndpoint,
  };
};

const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { Authorization: `Bearer ${API_KEY}`, ...(extra.headers ?? {}) },
});

describe('settings-api plugin HTTP route', () => {
  it('rejects requests without a valid bearer token (401)', async () => {
    const h = await startServer();

    const noHeader = await fetch(h.url('/endpoint'));
    expect(noHeader.status).toBe(401);

    const wrongKey = await fetch(h.url('/endpoint'), {
      headers: { Authorization: 'Bearer not-the-key' },
    });
    expect(wrongKey.status).toBe(401);

    // `Bearer ` with an empty token must also be rejected (length mismatch).
    const emptyToken = await fetch(h.url('/endpoint'), {
      headers: { Authorization: 'Bearer ' },
    });
    expect(emptyToken.status).toBe(401);
  });

  it('returns the current endpoint on GET with a valid token', async () => {
    const h = await startServer();
    const res = await fetch(h.url('/endpoint'), authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: 'https://old.invalid/chat' });
  });

  it('updates and persists the endpoint on a valid PUT', async () => {
    const h = await startServer();
    const res = await fetch(
      h.url('/endpoint'),
      authed({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://new.invalid/chat' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: 'https://new.invalid/chat' });
    expect(h.setEndpoint).toHaveBeenCalledWith('https://new.invalid/chat');

    // The swap is observable on the next GET.
    const after = await fetch(h.url('/endpoint'), authed());
    expect(await after.json()).toEqual({ endpoint: 'https://new.invalid/chat' });
  });

  it('rejects a malformed body (400) without calling setEndpoint', async () => {
    const h = await startServer();
    const res = await fetch(
      h.url('/endpoint'),
      authed({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'not-a-url' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.setEndpoint).not.toHaveBeenCalled();
  });

  it('returns 500 when persistence fails, without crashing the server', async () => {
    const h = await startServer();
    h.setEndpoint.mockRejectedValueOnce(new Error('disk full'));
    const res = await fetch(
      h.url('/endpoint'),
      authed({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://new.invalid/chat' }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'persist_failed' });

    // The server must still be serving after the failed write.
    const after = await fetch(h.url('/endpoint'), authed());
    expect(after.status).toBe(200);
  });

  it('does not start the server when disabled', async () => {
    const h = await startServer({ enabled: false });
    const outcome = await fetch(h.url('/endpoint'), authed())
      .then(() => 'reachable')
      .catch(() => 'refused');
    expect(outcome).toBe('refused');
  });

  it('does not start the server when enabled but no API key is configured', async () => {
    const h = await startServer({ apiKey: undefined });
    const outcome = await fetch(h.url('/endpoint'))
      .then(() => 'reachable')
      .catch(() => 'refused');
    expect(outcome).toBe('refused');
  });
});
