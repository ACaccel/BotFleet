import { createHash } from 'node:crypto';

import { localSlotOf, type StatsWindow } from '../../../core/archive/stats';
import { zonedTimeToEpoch } from '../../../core/time';
import type { GayReadingRepo } from '../../../persistence/repositories/gay-reading.repo';
import type { GayStatsRepo } from '../../../persistence/repositories/gay-stats.types';
import { pairReading, singleReading, type Reading } from './meter';

interface DailyReadingInput {
  readonly userIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly timeZone: string;
  readonly now: number;
  readonly snapshots: GayReadingRepo;
  readonly stats: GayStatsRepo;
}

/** Last 30 complete local dates; today's traffic cannot change today's reading. */
export const archiveWindow = (now: number, timeZone: string): StatsWindow => {
  const parts = localSlotOf(now, timeZone).dayKey.split('-').map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const midnight = (daysBack: number): number =>
    zonedTimeToEpoch({ year, month, day: day - daysBack, hour: 0, minute: 0 }, timeZone);
  return { startMs: midnight(30), endMs: midnight(0) };
};

export const dailyReading = async (input: DailyReadingInput): Promise<Reading> => {
  // Pair order is significant: `A x B` and `B x A` read differently.
  const userIds = [...new Set(input.userIds)];
  const first = userIds[0];
  if (first === undefined || userIds.length > 2) throw new Error('Expected one or two members');
  const second = userIds[1];
  const base =
    second === undefined
      ? singleReading(first, input.timeZone, input.now)
      : pairReading(first, second, input.timeZone, input.now);
  const channelIds = [...new Set(input.channelIds)].sort();
  if (channelIds.length === 0) return base;

  // Scope is part of the identity: a snapshot may never bypass current permissions.
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'gay-v3',
        input.timeZone,
        localSlotOf(input.now, input.timeZone).dayKey,
        userIds,
        channelIds,
      ]),
    )
    .digest('hex');
  const stored = await input.snapshots.find(key);
  if (!stored.ok) return base;
  if (stored.value !== undefined) return stored.value;

  const summary = await input.stats.summarize({
    userIds,
    channelIds,
    timeZone: input.timeZone,
    window: archiveWindow(input.now, input.timeZone),
  });
  const value = summary.ok ? summary.value : undefined;
  const reading =
    second === undefined
      ? singleReading(first, input.timeZone, input.now, value)
      : pairReading(first, second, input.timeZone, input.now, value);
  const remembered = await input.snapshots.remember(
    key,
    reading,
    new Date(input.now + 3 * 86_400_000),
  );
  // A volatile archive result would change after backfills or a restart.
  return remembered.ok ? remembered.value : base;
};
