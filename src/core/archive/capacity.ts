interface ArchiveCapacity {
  projectBytes: number;
  freeBytes: number;
  projectedBytes: number;
  reservedBytes: number;
  budgetBytes?: number;
  warningBytes?: number;
  pauseBytes?: number;
  minimumFreeBytes?: number;
}
interface ArchiveCapacityDecision {
  allowed: boolean;
  warning: boolean;
  reason: 'ok' | 'project-budget' | 'backfill-paused' | 'filesystem-space';
  projectedTotal: number;
}
/** Measurements include all project roots and Mongo storage; projections include temporary copies. */
export const checkArchiveCapacity = (
  input: ArchiveCapacity,
  priority: 'live' | 'bulk',
): ArchiveCapacityDecision => {
  for (const value of [
    input.projectBytes,
    input.freeBytes,
    input.projectedBytes,
    input.reservedBytes,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Capacity values must be non-negative safe integers');
  const projectedTotal = input.projectBytes + input.projectedBytes + input.reservedBytes;
  const base = {
    projectedTotal,
    warning: projectedTotal >= (input.warningBytes ?? 70_000_000_000),
  };
  if (projectedTotal >= (input.budgetBytes ?? 100_000_000_000))
    return { ...base, allowed: false, reason: 'project-budget' };
  if (
    input.freeBytes - input.projectedBytes - input.reservedBytes <
    (input.minimumFreeBytes ?? 1_000_000_000)
  )
    return { ...base, allowed: false, reason: 'filesystem-space' };
  if (priority === 'bulk' && projectedTotal >= (input.pauseBytes ?? 85_000_000_000))
    return { ...base, allowed: false, reason: 'backfill-paused' };
  return { ...base, allowed: true, reason: 'ok' };
};
