/**
 * In-process admission for `/traffic` reports. A member runs one report at a
 * time, and a guild runs one long-range (`90d`, `365d`) report at a time, because
 * those scan up to a year of messages and several at once would queue behind each
 * other on the database. A refused request gets a translated "busy" reply.
 */
import type { TrafficRange } from './types';

const LONG_RANGES: ReadonlySet<TrafficRange> = new Set(['90d', '365d']);

const runningMembers = new Set<string>();
const runningLongGuilds = new Set<string>();

export type Admission =
  | { readonly kind: 'admitted'; readonly release: () => void }
  | { readonly kind: 'busy'; readonly key: string };

export const admitReport = (guildId: string, userId: string, range: TrafficRange): Admission => {
  const member = `${guildId}:${userId}`;
  if (runningMembers.has(member)) return { kind: 'busy', key: 'replies:traffic.busy_member' };
  const long = LONG_RANGES.has(range);
  if (long && runningLongGuilds.has(guildId))
    return { kind: 'busy', key: 'replies:traffic.busy_guild' };
  runningMembers.add(member);
  if (long) runningLongGuilds.add(guildId);
  let released = false;
  return {
    kind: 'admitted',
    release: () => {
      if (released) return;
      released = true;
      runningMembers.delete(member);
      if (long) runningLongGuilds.delete(guildId);
    },
  };
};
