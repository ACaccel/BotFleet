/** The first `/ai settings` after startup waits for the model list instead of failing. */
import { describe, expect, it, vi } from 'vitest';

import { loadModelOptions } from '../../../../src/handlers/commands/ai_settings/model-options';

const catalogWith = (initial: string[], live: () => Promise<string[]>) => {
  let cached = initial;
  return {
    list: vi.fn(() => cached),
    listLive: vi.fn(async () => {
      const models = await live();
      cached = models;
      return models;
    }),
  };
};

describe('loadModelOptions', () => {
  it('uses a warm cache without a live fetch', async () => {
    const catalog = catalogWith(['m1'], async () => ['m2']);

    expect(await loadModelOptions(catalog, 'openai')).toEqual(['m1']);
    expect(catalog.listLive).not.toHaveBeenCalled();
  });

  it('waits for the live list when the cache is cold', async () => {
    const catalog = catalogWith([], async () => ['m1', 'm2']);

    expect(await loadModelOptions(catalog, 'openai')).toEqual(['m1', 'm2']);
  });

  it('gives up after the wait when the provider is slow', async () => {
    const catalog = catalogWith([], () => new Promise<string[]>(() => undefined));

    expect(await loadModelOptions(catalog, 'openai', 10)).toEqual([]);
  });

  it('yields no models when the provider fails or no catalog exists', async () => {
    const catalog = catalogWith([], async () => Promise.reject(new Error('no key')));

    expect(await loadModelOptions(catalog, 'openai')).toEqual([]);
    expect(await loadModelOptions(undefined, 'openai')).toEqual([]);
  });
});
