import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { REST } from 'discord.js';
import { ArchiveRestTelemetry } from '../../../src/plugins/message-backup/flow/rest-telemetry';

const wait = (majorParameter = 'one') => ({
  hash: 'bucket',
  majorParameter,
  retryAfter: 500,
  timeToReset: 300,
  sublimitTimeout: 0,
});
describe('shared SDK REST observation', () => {
  it('exposes local/global waits separately and contains observer failures', () => {
    const updates: { channelId: string; route?: string; global: boolean; deadlineAt: number }[] =
      [];
    const telemetry = new ArchiveRestTelemetry(
      () => 1000,
      (value) => {
        updates.push(value);
        throw new Error('diagnostic observer failed');
      },
    );
    expect(() => telemetry.wait({ ...wait('10'), global: false })).not.toThrow();
    expect(() => telemetry.wait({ ...wait('20'), global: true })).not.toThrow();
    expect(() =>
      telemetry.wait({ ...wait('30'), route: '/channels/:id/messages', global: false }),
    ).not.toThrow();
    expect(updates).toEqual([
      { channelId: '10', bucketKey: expect.any(String), global: false, deadlineAt: 1500 },
      { channelId: '20', bucketKey: expect.any(String), global: true, deadlineAt: 1500 },
      expect.objectContaining({ channelId: '30', route: 'messages', global: false }),
    ]);
    expect(telemetry.snapshot()).toMatchObject({
      announcedLocalWaitMs: 1000,
      announcedGlobalWaitMs: 500,
      sdkWaitEvents: 3,
      responses: 0,
      observerFailures: 3,
    });
  });
  it('distinguishes queue waits from actual attempts and shared 429 invalid exposure', () => {
    const telemetry = new ArchiveRestTelemetry();
    telemetry.wait(wait());
    expect(telemetry.snapshot().responses).toBe(0);
    telemetry.response(429, 'shared');
    telemetry.response(429, 'user');
    telemetry.response(429, null, 'true');
    telemetry.response(401, null);
    telemetry.response(403, null);
    expect(telemetry.snapshot().responses).toBe(5);
    expect(telemetry.snapshot().actual429).toEqual({ shared: 1, user: 1, global: 1, unknown: 0 });
    expect(telemetry.snapshot().invalidResponsesLast10Minutes).toBe(4);
  });
  it('keeps learned hash and major resource identities separate without logging URLs or IDs', () => {
    const telemetry = new ArchiveRestTelemetry();
    telemetry.wait(wait('channel-one'));
    telemetry.wait(wait('channel-two'));
    const value = telemetry.snapshot();
    expect(value.bucketWaits).toHaveLength(2);
    expect(JSON.stringify(value)).not.toContain('channel-one');
    expect(JSON.stringify(value)).not.toContain('channel-two');
  });
  it('bounds long-running bucket and invalid-window statistics', () => {
    let now = 0;
    const telemetry = new ArchiveRestTelemetry(() => now);
    telemetry.response(403, null);
    now = 601000;
    expect(telemetry.snapshot().invalidResponsesLast10Minutes).toBe(0);
    for (let index = 0; index < 1000; index++) telemetry.wait(wait(String(index)));
    expect(telemetry.snapshot().bucketWaits).toHaveLength(128);
  });
  it('attaches once and detaches only its own listeners from the existing REST manager', () => {
    const rest = new EventEmitter();
    let other = 0;
    rest.on('response', () => other++);
    const telemetry = new ArchiveRestTelemetry();
    telemetry.attach(rest as unknown as REST);
    telemetry.attach(rest as unknown as REST);
    rest.emit(
      'response',
      { headers: { authorization: 'secret' } },
      { status: 429, headers: new Headers({ 'x-ratelimit-scope': 'shared' }) },
    );
    expect(telemetry.snapshot().responses).toBe(1);
    expect(telemetry.snapshot().invalidResponsesLast10Minutes).toBe(0);
    expect(other).toBe(1);
    telemetry.detach();
    rest.emit('response', {}, {});
    expect(telemetry.snapshot().responses).toBe(1);
    expect(other).toBe(2);
  });
});
