import { mongo } from 'mongoose';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { datasetIdentity, syntheticBatches, syntheticMessage } from './dataset';
import { DatabaseMetrics, summarize } from './metrics';
import { parseOptions } from './run';
import { parseProcessStat } from './mongo-process';
import { LiveUpdateProbe } from './live-updates';

describe('synthetic archive benchmark', () => {
  it('reads Mongo CPU and RSS without confusing process names with stat fields', () => {
    const fields = Array.from({ length: 22 }, () => '0');
    fields[0] = 'R';
    fields[11] = '25';
    fields[12] = '5';
    fields[21] = '100';
    expect(parseProcessStat(`1 (process (worker)) ${fields.join(' ')}`)).toEqual({
      cpuTicks: 30,
      rssPages: 100,
    });
    expect(() => parseProcessStat('invalid')).toThrow('statistics');
  });
  it('generates deterministic identities and documents without production input', () => {
    expect(syntheticMessage(10, 'clean')).toEqual(syntheticMessage(10, 'clean'));
    expect(datasetIdentity({ count: 100_000, scenario: 'clean' })).toBe(
      datasetIdentity({ count: 100_000, scenario: 'clean' }),
    );
    expect(datasetIdentity({ count: 1_000_000, scenario: 'clean' })).not.toBe(
      datasetIdentity({ count: 100_000, scenario: 'clean' }),
    );
  });

  it('bounds all staged documents by count and BSON bytes', () => {
    const sampleBytes = mongo.BSON.calculateObjectSize(syntheticMessage(0, 'reaction-heavy'));
    const batches = [
      ...syntheticBatches({ count: 7, scenario: 'reaction-heavy' }, 4, sampleBytes * 2),
    ];
    expect(batches.flatMap((batch) => batch.documents)).toHaveLength(7);
    for (const batch of batches) {
      expect(batch.documents.length).toBeLessThanOrEqual(4);
      expect(batch.bytes).toBeLessThanOrEqual(sampleBytes * 2);
    }
    expect(() => [...syntheticBatches({ count: 1, scenario: 'clean' }, 1, 10)]).toThrow(
      'byte budget',
    );
    expect(() => [...syntheticBatches({ count: 1, scenario: 'clean' }, 1, Number.NaN)]).toThrow(
      'positive',
    );
  });

  it('creates conflict, author exclusion, timestamp and membership workloads', () => {
    const original = syntheticMessage(0, 'duplicate-conflicts');
    const conflict = syntheticMessage(1, 'duplicate-conflicts');
    expect(original['messageId']).toBe(conflict['messageId']);
    expect(original['content']).not.toBe(conflict['content']);
    expect(syntheticMessage(1, 'bot-heavy')['authorKind']).toBe('bot');
    expect(typeof syntheticMessage(0, 'old-timestamps')['timestamp']).toBe('string');
    expect(syntheticMessage(0, 'reaction-heavy')['reactions']).toHaveLength(5);
  });

  it('refuses production URIs, duplicate options and insufficient repetitions', () => {
    expect(() =>
      parseOptions(['--scenario', 'missing-permissions', '--output', '/tmp/result']),
    ).toThrow('Unknown');
    expect(() =>
      parseOptions(['--uri', 'mongodb://production', '--output', '/tmp/result']),
    ).toThrow('Expected');
    expect(() => parseOptions(['--runs', '2', '--output', '/tmp/result'])).toThrow('Runs');
    expect(() => parseOptions(['--count', '1', '--count', '2', '--output', '/tmp/result'])).toThrow(
      'unique',
    );
    expect(
      parseOptions(['--count', '5500000', '--max-db-mib', '32768', '--output', '/tmp/result'])
        .count,
    ).toBe(5_500_000);
    expect(
      parseOptions([
        '--cache',
        'mongo-cold',
        '--batch-documents',
        '1000',
        '--output',
        '/tmp/result',
      ]),
    ).toMatchObject({ cache: 'mongo-cold', batchDocuments: 1000 });
    for (const batch of ['0', '1001', 'NaN'])
      expect(() => parseOptions(['--batch-documents', batch, '--output', '/tmp/result'])).toThrow(
        'Batch',
      );
  });

  it('uses numeric aggregates and prevents high cardinality or sensitive payload retention', () => {
    const metrics = new DatabaseMetrics();
    const base = {
      address: 'synthetic',
      databaseName: 'synthetic',
      serverConnectionId: null,
      hasServiceId: false,
      requestId: 1,
      commandName: 'find',
    };
    metrics.started({
      ...base,
      command: { find: 'messages', filter: { content: 'private message', token: 'private token' } },
    });
    metrics.succeeded({
      ...base,
      duration: 4,
      reply: { cursor: { firstBatch: [{ content: 'private reply' }] } },
    });
    metrics.started({ ...base, requestId: 2, commandName: 'sensitive-route-name', command: {} });
    metrics.failed({ ...base, requestId: 2, duration: 5, failure: new Error('private exception') });
    const snapshot = metrics.snapshot();
    expect(snapshot['find']?.count).toBe(1);
    expect(snapshot['find']?.durationMs).toBe(4);
    expect(snapshot['find']?.requestBsonBytes).toBeGreaterThan(0);
    expect(snapshot['other']?.failures).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|sensitive-route/);
    metrics.started({ ...base, requestId: 3, command: { unserializable: Symbol('secret') } });
    expect(() =>
      metrics.succeeded({
        ...base,
        requestId: 3,
        duration: 1,
        reply: { unserializable: () => undefined },
      }),
    ).not.toThrow();
  });

  it('reports medians and ranges from at least three measured runs', () => {
    expect(summarize([50, 10, 30])).toEqual({ median: 30, min: 10, max: 50 });
    expect(summarize([40, 10, 30, 20])).toEqual({ median: 25, min: 10, max: 40 });
    expect(() => summarize([10, 20])).toThrow('three');
  });

  it('freezes and detaches the DB window before post-phase validation', () => {
    const source = new EventEmitter();
    const metrics = new DatabaseMetrics();
    const stop = metrics.attach(source as unknown as mongo.MongoClient);
    const event = { requestId: 1, commandName: 'find', command: { find: 'messages' } };
    source.emit('commandStarted', event);
    source.emit('commandSucceeded', { requestId: 1, duration: 2, reply: { ok: 1 } });
    expect(stop()['find']?.count).toBe(1);
    expect(source.listenerCount('commandStarted')).toBe(0);
    source.emit('commandStarted', { ...event, requestId: 2 });
    expect(stop()['find']?.count).toBe(1);
  });

  it('keeps only one live edit in flight and drains it before shutdown', async () => {
    vi.useFakeTimers();
    try {
      let finish: (() => void) | undefined;
      const update = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const probe = new LiveUpdateProbe(update, 10, 100);
      probe.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(update).toHaveBeenCalledTimes(1);
      const drain = probe.stop();
      finish?.();
      expect(await drain).toMatchObject({ completed: 1, failed: false });
      await vi.advanceTimersByTimeAsync(1000);
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('limits live edits and contains update failures without queued retries', async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn().mockResolvedValue(undefined);
      const probe = new LiveUpdateProbe(update, 10, 3);
      probe.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(update).toHaveBeenCalledTimes(3);
      expect(await probe.stop()).toMatchObject({ completed: 3, failed: false });
      const failedUpdate = vi.fn().mockRejectedValue(new Error('synthetic failure'));
      const failedProbe = new LiveUpdateProbe(failedUpdate, 10, 3);
      failedProbe.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(failedUpdate).toHaveBeenCalledTimes(1);
      expect(await failedProbe.stop()).toMatchObject({ completed: 0, failed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
