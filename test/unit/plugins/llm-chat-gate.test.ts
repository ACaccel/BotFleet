import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../src/core/result';
import { databaseErrorFrom } from '../../../src/persistence/error-translator';
import { gateChatRequest, releaseChatRequest } from '../../../src/plugins/llm-chat/internal';
import type { AiUsageRepo } from '../../../src/persistence/repositories/ai-usage.repo';

const limits = { perUserPerHour: 5, perUserPerDay: 10, concurrent: 1 };
const repo = (): AiUsageRepo => ({
  record: vi.fn(async () => ok(undefined)),
  windowSince: vi.fn(async () => ok({ count: 0 })),
});

describe('gateChatRequest', () => {
  it('refuses a member who already has a request in flight', async () => {
    const usage = repo();
    const decision = await gateChatRequest(usage, new Map([['u1', 1]]), 'u1', 0, limits);
    expect(decision).toEqual(ok({ kind: 'busy' }));
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('admits and records a member under every limit', async () => {
    const usage = repo();
    const decision = await gateChatRequest(usage, new Map(), 'u1', 0, limits);
    expect(decision).toEqual(ok({ kind: 'admitted' }));
    expect(usage.record).toHaveBeenCalledOnce();
  });

  it('reserves a concurrency slot before any asynchronous admission reads', async () => {
    const usage = repo();
    const inFlight = new Map<string, number>();
    const decisions = await Promise.all([
      gateChatRequest(usage, inFlight, 'u1', 0, limits),
      gateChatRequest(usage, inFlight, 'u1', 0, limits),
    ]);
    expect(decisions).toEqual([ok({ kind: 'admitted' }), ok({ kind: 'busy' })]);
    expect(usage.record).toHaveBeenCalledOnce();
    expect(inFlight.get('u1')).toBe(1);
    releaseChatRequest(inFlight, 'u1');
    expect(inFlight.has('u1')).toBe(false);
  });

  it.each(['hour', 'day'])(
    'serializes persisted admission for a concurrent %s quota',
    async (window) => {
      let recorded = 0;
      const usage: AiUsageRepo = {
        record: vi.fn(async () => {
          recorded += 1;
          return ok(undefined);
        }),
        windowSince: vi.fn(async () => ok({ count: recorded, oldest: new Date(0) })),
      };
      const inFlight = new Map<string, number>();
      const quotas = {
        perUserPerHour: window === 'hour' ? 1 : 5,
        perUserPerDay: window === 'day' ? 1 : 5,
        concurrent: 2,
      };
      const decisions = await Promise.all([
        gateChatRequest(usage, inFlight, 'u1', 0, quotas),
        gateChatRequest(usage, inFlight, 'u1', 0, quotas),
      ]);
      expect(decisions[0]).toEqual(ok({ kind: 'admitted' }));
      expect(decisions[1]).toEqual(
        ok({ kind: 'limited', retryAt: (window === 'hour' ? 1 : 24) * 60 * 60_000 }),
      );
      expect(usage.record).toHaveBeenCalledOnce();
      expect(inFlight.get('u1')).toBe(1);
    },
  );

  it('releases reservations and pending admission locks on database failures', async () => {
    const failure = databaseErrorFrom(new Error('unavailable'), { operation: 'test' });
    const usage: AiUsageRepo = {
      record: vi.fn(async () => ok(undefined)),
      windowSince: vi.fn(async () => err(failure)),
    };
    const inFlight = new Map<string, number>();
    const quotas = { ...limits, concurrent: 2 };
    const decisions = await Promise.all([
      gateChatRequest(usage, inFlight, 'u1', 0, quotas),
      gateChatRequest(usage, inFlight, 'u1', 0, quotas),
    ]);
    expect(decisions).toEqual([err(failure), err(failure)]);
    expect(inFlight.size).toBe(0);
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('releases a slot and admission lock if a repository unexpectedly throws', async () => {
    const usage = repo();
    vi.mocked(usage.record).mockRejectedValueOnce(new Error('unexpected failure'));
    const inFlight = new Map<string, number>();
    await expect(gateChatRequest(usage, inFlight, 'u1', 0, limits)).rejects.toThrow(
      'unexpected failure',
    );
    expect(inFlight.size).toBe(0);
    await expect(gateChatRequest(usage, inFlight, 'u1', 0, limits)).resolves.toEqual(
      ok({ kind: 'admitted' }),
    );
  });
});
