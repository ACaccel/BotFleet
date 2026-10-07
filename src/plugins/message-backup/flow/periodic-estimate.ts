export interface PeriodicHistory {
  version?: 2;
  policyHash?: string;
  lastCutoff: number;
  windowMs: number;
  scanned: number;
  elapsedMs: number;
  samples: number;
}
interface PeriodicEstimate {
  total?: number;
  rates: number[];
  reason: string;
}

/** Priors are provisional workload estimates, not Discord source counts. A new channel leaves scope unknown. */
export function estimatePeriodicWork(
  channelIds: readonly string[],
  priors: ReadonlyMap<string, PeriodicHistory>,
  cutoff: number,
  scope?: { policyHash: string },
): PeriodicEstimate {
  if (channelIds.length === 0) return { total: 0, rates: [], reason: 'empty-known-scope' };
  let total = 0;
  let predictedMs = 0;
  for (const channelId of channelIds) {
    const prior = priors.get(channelId);
    if (
      prior === undefined ||
      (scope !== undefined && (prior.version !== 2 || prior.policyHash !== scope.policyHash)) ||
      prior.samples < 1 ||
      prior.windowMs <= 0 ||
      prior.elapsedMs <= 0 ||
      cutoff <= prior.lastCutoff
    )
      return { rates: [], reason: 'new-or-uncalibrated-channel' };
    const scale = (cutoff - prior.lastCutoff) / prior.windowMs;
    // A long outage invalidates routine traffic assumptions rather than yielding a spurious finite ETA.
    if (scale > 4) return { rates: [], reason: 'long-outage' };
    const predicted = Math.ceil(prior.scanned * Math.max(0.25, scale));
    total += predicted;
    predictedMs += prior.elapsedMs * Math.max(0.25, scale);
  }
  if (total === 0) return { rates: [], reason: 'no-prior-work-rate' };
  const rate = total / predictedMs;
  return {
    total,
    rates: [rate * 0.75, rate, rate * 1.25],
    reason: 'provisional-recurring-channel-history',
  };
}

export function updatePeriodicHistory(
  previous: PeriodicHistory | undefined,
  input: {
    cutoff: number;
    scanned: number;
    elapsedMs: number;
    windowMs: number;
    policyHash?: string;
  },
): PeriodicHistory {
  if (
    !Number.isFinite(input.cutoff) ||
    !Number.isSafeInteger(input.scanned) ||
    input.scanned < 0 ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs <= 0 ||
    !Number.isFinite(input.windowMs) ||
    input.windowMs <= 0
  )
    throw new Error('invalid-periodic-history');
  return {
    version: 2,
    ...(input.policyHash === undefined ? {} : { policyHash: input.policyHash }),
    lastCutoff: input.cutoff,
    scanned: input.scanned,
    elapsedMs: input.elapsedMs,
    windowMs: input.windowMs,
    samples: Math.min(1000, (previous?.samples ?? 0) + 1),
  };
}
