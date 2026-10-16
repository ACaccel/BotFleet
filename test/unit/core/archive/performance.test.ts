import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { ArchivePerformanceSampler } from '../../../../src/core/archive/performance';

describe('Archive process performance sampling', () => {
  it('rejects invalid sampling intervals and invalid lifecycle calls', () => {
    for (const interval of [0, 19, NaN, Infinity, 20.5, 2_147_483_648])
      expect(() => new ArchivePerformanceSampler(interval)).toThrow();
    const maximum = new ArchivePerformanceSampler(2_147_483_647);
    maximum.start();
    expect(maximum.stop().memorySampleIntervalMs).toBe(2_147_483_647);
    const sampler = new ArchivePerformanceSampler();
    expect(() => sampler.snapshot()).toThrow('performance-sampler-not-started');
    expect(() => sampler.stop()).toThrow('performance-sampler-not-started');
    sampler.start();
    try {
      expect(() => sampler.start()).toThrow('performance-sampler-already-started');
    } finally {
      sampler.stop();
    }
  });

  it('reports finite empty histograms and freezes results after releasing observers', async () => {
    const sampler = new ArchivePerformanceSampler(20);
    sampler.start();
    try {
      const immediate = sampler.snapshot();
      expect(immediate.eventLoop).toEqual({ samples: 0, meanMs: 0, maxMs: 0 });
      await setTimeout(65);
      const result = sampler.stop();
      expect(result.scope).toBe('current-node-process');
      expect(result.elapsedMs).toBeGreaterThan(0);
      expect(result.eventLoop.samples).toBeGreaterThan(0);
      expect(result.sampledPeakRssBytes).toBeGreaterThan(0);
      expect(result.sampledPeakHeapBytes).toBeGreaterThan(0);
      expect(result.cpuUserMs).toBeGreaterThanOrEqual(0);
      expect(result.cpuSystemMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(result)).not.toContain('null');
      await setTimeout(25);
      expect(sampler.snapshot()).toEqual(result);
      expect(sampler.stop()).toEqual(result);
      expect(sampler.snapshot()).not.toBe(result);
    } finally {
      sampler.stop();
    }
  });
});
