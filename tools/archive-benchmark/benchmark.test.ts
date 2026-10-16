import type { mongo } from 'mongoose';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { DatabaseMetrics, summarize } from './metrics';

describe('synthetic archive benchmark', () => {
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
});
