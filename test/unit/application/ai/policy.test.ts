import { describe, expect, it, vi } from 'vitest';

import { ok } from '../../../../src/core/result';
import {
  admitAiRequest,
  allowedModelsFor,
  DEFAULT_RATE_LIMIT,
  effectiveModel,
  isModelAllowed,
  parseAiPolicy,
} from '../../../../src/application/ai/policy';
import type { AiUsageRepo } from '../../../../src/persistence/repositories/ai-usage.repo';

const config = {
  ai: {
    models: {
      default: { provider: 'xai', model: 'grok-mini' },
      allowed: { xai: ['grok-mini'], anthropic: ['claude-small'] },
    },
    rateLimit: { perUserPerHour: 2, perUserPerDay: 3, concurrent: 1 },
  },
};

describe('parseAiPolicy', () => {
  it('defaults to every model and the default limits without an ai block', () => {
    expect(parseAiPolicy({})).toEqual({ rateLimit: DEFAULT_RATE_LIMIT });
  });

  it('rejects a default model outside the allowlist', () => {
    expect(() =>
      parseAiPolicy({
        ai: { models: { default: { provider: 'openai', model: 'x' }, allowed: { xai: ['y'] } } },
      }),
    ).toThrow(/default must be listed/);
  });

  it('rejects unknown keys and providers', () => {
    expect(() => parseAiPolicy({ ai: { typo: 1 } })).toThrow();
    expect(() =>
      parseAiPolicy({
        ai: { models: { default: { provider: 'other', model: 'x' }, allowed: {} } },
      }),
    ).toThrow();
  });

  it("accepts model names up to Discord's 100-character option limit", () => {
    const model = 'm'.repeat(100);
    expect(() =>
      parseAiPolicy({
        ai: { models: { default: { provider: 'xai', model }, allowed: { xai: [model] } } },
      }),
    ).not.toThrow();
  });

  it.each(['default', 'allowed'])('rejects oversized model names in %s at startup', (field) => {
    const model = 'm'.repeat(101);
    const models = {
      default: { provider: 'xai', model: field === 'default' ? model : 'short' },
      allowed: { xai: field === 'allowed' ? ['short', model] : [model] },
    };
    expect(() => parseAiPolicy({ ai: { models } })).toThrow(/100/);
  });
});

describe('model allowlist', () => {
  const policy = parseAiPolicy(config);

  it('lists only allowed models, and none for an unlisted provider', () => {
    expect(allowedModelsFor(policy, 'anthropic')).toEqual(['claude-small']);
    expect(allowedModelsFor(policy, 'openai')).toEqual([]);
    expect(allowedModelsFor(parseAiPolicy({}), 'openai')).toBeUndefined();
  });

  it('falls back to the default for a model that is no longer allowed', () => {
    expect(isModelAllowed(policy, 'anthropic', 'claude-big')).toBe(false);
    expect(effectiveModel(policy, { provider: 'anthropic', model: 'claude-big' })).toEqual({
      provider: 'xai',
      model: 'grok-mini',
      fellBack: true,
    });
    expect(effectiveModel(policy, { provider: 'xai', model: 'grok-mini' }).fellBack).toBe(false);
  });
});

describe('admitAiRequest', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  // A fixed instant shared by the caller and the fake repository, so the
  // window the repository reports never depends on elapsed wall time.
  const NOW = Date.UTC(2026, 0, 15, 12);
  const repoWith = (hour: number, day: number, oldest: number): AiUsageRepo => ({
    record: vi.fn(async () => ok(undefined)),
    windowSince: vi.fn(async (_user: string, since: Date) =>
      ok({
        count: NOW - since.getTime() <= HOUR ? hour : day,
        oldest: new Date(oldest),
      }),
    ),
  });
  const limits = parseAiPolicy(config).rateLimit;

  it('admits and records a request under both limits', async () => {
    const repo = repoWith(1, 1, 0);
    const result = await admitAiRequest(repo, 'u1', NOW, limits);
    expect(result).toEqual(ok({ admitted: true }));
    expect(repo.record).toHaveBeenCalledWith('u1', new Date(NOW));
  });

  it('refuses at the hourly limit until the oldest request ages out', async () => {
    const repo = repoWith(2, 2, NOW - 10 * 60_000);
    const result = await admitAiRequest(repo, 'u1', NOW, limits);
    expect(result).toEqual(ok({ admitted: false, retryAt: NOW - 10 * 60_000 + HOUR }));
    expect(repo.record).not.toHaveBeenCalled();
  });

  it('refuses at the daily limit', async () => {
    const repo = repoWith(1, 3, NOW - 2 * HOUR);
    const result = await admitAiRequest(repo, 'u1', NOW, limits);
    expect(result).toEqual(ok({ admitted: false, retryAt: NOW - 2 * HOUR + DAY }));
    expect(repo.record).not.toHaveBeenCalled();
  });
});
