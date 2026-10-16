import { mongo } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { processCpuBatch } from './cpu';

describe('CPU benchmark transport', () => {
  it('preserves native BSON semantics through byte transport and rejects unsupported versions', () => {
    const document = {
      id: '1',
      channel_id: '2',
      timestamp: '2023-11-14T22:13:20.000Z',
      author: { id: '3' },
      content: 'synthetic',
      _id: new mongo.ObjectId('000000000000000000000001'),
      native: new Date(1_700_000_000_000),
      bytes: Buffer.from([1, 2, 3]),
    };
    const bytes = Uint8Array.from(mongo.BSON.serialize({ documents: [document] }));
    const first = processCpuBatch({ version: 1, sequence: 2, bytes });
    const second = processCpuBatch({ version: 1, sequence: 2, bytes: structuredClone(bytes) });
    expect(first).toEqual(second);
    expect(first.hashes[0]).toHaveLength(128);
    expect(first.sequence).toBe(2);
    expect(() => processCpuBatch({ version: 2 as 1, sequence: 2, bytes })).toThrow('transport');
    expect(() =>
      processCpuBatch({ version: 1, sequence: 2, bytes: new Uint8Array([1]) }),
    ).toThrow();
  });
});
