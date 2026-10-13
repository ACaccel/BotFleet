import type { LLMProviderName, ModelCatalog } from '../../../infra/llm';

/**
 * How long a cold model list may hold up the settings form. Opening a
 * modal must answer the interaction within three seconds, so the wait
 * leaves headroom for the database read before it and the reply after.
 */
const COLD_CACHE_WAIT_MS = 1_500;

/**
 * The provider's selectable models. A cold cache waits briefly for the
 * live list instead of answering "unavailable" on the first request
 * after startup; a slow or failing provider still yields `[]`.
 */
export const loadModelOptions = async (
  catalog: Pick<ModelCatalog, 'list' | 'listLive'> | undefined,
  provider: LLMProviderName,
  waitMs: number = COLD_CACHE_WAIT_MS,
): Promise<readonly string[]> => {
  if (catalog === undefined) return [];
  const cached = catalog.list(provider);
  if (cached.length > 0) return cached;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    catalog.listLive(provider).catch(() => []),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return catalog.list(provider);
};
