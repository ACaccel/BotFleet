const DISCORD_EPOCH = 1420070400000n;

/** Exclusive upper snowflake bound includes every message created in the cutoff millisecond. */
export function historyBefore(cutoff: Date): string {
  const millis = cutoff.getTime();
  if (!Number.isSafeInteger(millis) || BigInt(millis) < DISCORD_EPOCH)
    throw new Error('invalid-history-cutoff');
  return ((BigInt(millis) - DISCORD_EPOCH + 1n) << 22n).toString();
}

export function inHistoryScope(messageId: string, cutoff: Date): boolean {
  return BigInt(messageId) < BigInt(historyBefore(cutoff));
}
