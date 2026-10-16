/**
 * AI cost controls read from the bot's `config.json` `ai` block: which
 * models whitelisted members may use, and how often they may chat.
 *
 * Shared by the `/ai` handlers (what the settings form offers) and the
 * chat plugin (what each request actually uses), which may not import
 * each other.
 */
import { z } from 'zod';

import type { DatabaseError } from '../../core/errors/external-service-error';
import { ok, type Result } from '../../core/result';
import type { AiUsageRepo } from '../../persistence/repositories/ai-usage.repo';

const PROVIDERS = ['xai', 'openai', 'anthropic', 'gemini'] as const;
type Provider = (typeof PROVIDERS)[number];

const ModelNameSchema = z.string().min(1).max(100);
const ModelRefSchema = z.object({ provider: z.enum(PROVIDERS), model: ModelNameSchema }).strict();

const PolicySchema = z
  .object({
    ai: z
      .object({
        models: z
          .object({
            default: ModelRefSchema,
            allowed: z.record(z.enum(PROVIDERS), z.array(ModelNameSchema).min(1).max(25)),
          })
          .strict()
          .optional(),
        rateLimit: z
          .object({
            perUserPerHour: z.number().int().min(1),
            perUserPerDay: z.number().int().min(1),
            concurrent: z.number().int().min(1).max(5),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

interface ModelRef {
  readonly provider: Provider;
  readonly model: string;
}

export interface RateLimit {
  readonly perUserPerHour: number;
  readonly perUserPerDay: number;
  readonly concurrent: number;
}

export interface AiPolicy {
  /** Absent: every model is allowed. */
  readonly modelPolicy?: {
    readonly default: ModelRef;
    readonly allowed: Partial<Record<Provider, readonly string[]>>;
  };
  readonly rateLimit: RateLimit;
}

export const DEFAULT_RATE_LIMIT: RateLimit = {
  perUserPerHour: 30,
  perUserPerDay: 200,
  concurrent: 1,
};

/** Parse the `ai` block; throws on a malformed block or a default outside the allowlist. */
export const parseAiPolicy = (botConfig: unknown): AiPolicy => {
  const ai = PolicySchema.parse(botConfig ?? {}).ai;
  const { models: modelPolicy } = ai ?? {};
  if (
    modelPolicy !== undefined &&
    !modelPolicy.allowed[modelPolicy.default.provider]?.includes(modelPolicy.default.model)
  ) {
    throw new Error('ai.models.default must be listed in ai.models.allowed');
  }
  return {
    ...(modelPolicy ? { modelPolicy } : {}),
    rateLimit: ai?.rateLimit ?? DEFAULT_RATE_LIMIT,
  };
};

/** The models the settings form may offer for `provider`; `undefined` means no restriction. */
export const allowedModelsFor = (
  policy: AiPolicy,
  provider: string,
): readonly string[] | undefined =>
  policy.modelPolicy === undefined
    ? undefined
    : (policy.modelPolicy.allowed[provider as Provider] ?? []);

export const isModelAllowed = (policy: AiPolicy, provider: string, model: string): boolean =>
  allowedModelsFor(policy, provider)?.includes(model) ?? true;

/** The provider and model a request actually uses: the stored choice, or the default. */
export const effectiveModel = (
  policy: AiPolicy,
  stored: { readonly provider: string; readonly model: string },
): { readonly provider: string; readonly model: string; readonly fellBack: boolean } =>
  policy.modelPolicy === undefined || isModelAllowed(policy, stored.provider, stored.model)
    ? { ...stored, fellBack: false }
    : { ...policy.modelPolicy.default, fellBack: true };

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAt: number };

/**
 * Admit and record one request, or report when the member may try again.
 * The log lives in MongoDB, so limits hold across restarts.
 */
export const admitAiRequest = async (
  repo: AiUsageRepo,
  userId: string,
  now: number,
  limits: RateLimit,
): Promise<Result<Admission, DatabaseError>> => {
  for (const [windowMs, limit] of [
    [HOUR_MS, limits.perUserPerHour],
    [DAY_MS, limits.perUserPerDay],
  ] as const) {
    const window = await repo.windowSince(userId, new Date(now - windowMs));
    if (!window.ok) return window;
    if (window.value.count >= limit) {
      const oldest = window.value.oldest?.getTime() ?? now;
      return ok({ admitted: false, retryAt: oldest + windowMs });
    }
  }
  const recorded = await repo.record(userId, new Date(now));
  if (!recorded.ok) return recorded;
  return ok({ admitted: true });
};
