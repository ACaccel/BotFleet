import type { DatabaseError } from '../../../core/errors/external-service-error';
import { ok, type Result } from '../../../core/result';
import type { AiUsageRepo } from '../../../persistence/repositories/ai-usage.repo';
import { admitAiRequest, type RateLimit } from '../../../application/ai/policy';

export type GateDecision =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'limited'; readonly retryAt: number };

const admissions = new WeakMap<AiUsageRepo, Map<string, Promise<void>>>();

/** Release the slot reserved by an admitted request, including provider failures. */
export const releaseChatRequest = (inFlight: Map<string, number>, userId: string): void => {
  const remaining = (inFlight.get(userId) ?? 1) - 1;
  if (remaining > 0) inFlight.set(userId, remaining);
  else inFlight.delete(userId);
};

/** Serialize read-and-record admission without holding the lock during an LLM call. */
const admitSerially = async (repo: AiUsageRepo, userId: string, now: number, limits: RateLimit) => {
  let pending = admissions.get(repo);
  if (pending === undefined) {
    pending = new Map();
    admissions.set(repo, pending);
  }
  const previous = pending.get(userId);
  let unlock!: () => void;
  const lock = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  pending.set(userId, lock);
  try {
    await previous;
    return await admitAiRequest(repo, userId, now, limits);
  } finally {
    unlock();
    if (pending.get(userId) === lock) pending.delete(userId);
  }
};

/**
 * Decide whether a member's chat request may run now: refuse while they
 * already have `concurrent` requests in flight, then apply the persisted
 * hourly and daily limits, recording the request when admitted. Reserve
 * before awaiting storage so simultaneous requests cannot pass together.
 * The caller releases an admitted slot after delivery finishes.
 */
export const gateChatRequest = async (
  repo: AiUsageRepo,
  inFlight: Map<string, number>,
  userId: string,
  now: number,
  limits: RateLimit,
): Promise<Result<GateDecision, DatabaseError>> => {
  if ((inFlight.get(userId) ?? 0) >= limits.concurrent) return ok({ kind: 'busy' });
  inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
  let admitted = false;
  try {
    const admission = await admitSerially(repo, userId, now, limits);
    if (!admission.ok) return admission;
    admitted = admission.value.admitted;
    return ok(
      admission.value.admitted
        ? { kind: 'admitted' }
        : { kind: 'limited', retryAt: admission.value.retryAt },
    );
  } finally {
    if (!admitted) releaseChatRequest(inFlight, userId);
  }
};
