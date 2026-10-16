/** Bounded reservations prevent concurrent sends from bypassing a channel cooldown. */
export class ReplyCooldown {
  private readonly entries = new Map<string, { busy: boolean; until: number }>();

  public clear(): void {
    this.entries.clear();
  }

  public reserve(key: string, milliseconds: number): (() => void) | undefined {
    if (milliseconds <= 0) return () => {};
    const now = Date.now();
    for (const [entryKey, entry] of this.entries) {
      if (!entry.busy && entry.until <= now) this.entries.delete(entryKey);
    }
    if (this.entries.has(key) || this.entries.size >= 4096) return undefined;
    const entry = { busy: true, until: now + milliseconds };
    this.entries.set(key, entry);
    return () => {
      entry.busy = false;
      entry.until = Date.now() + milliseconds;
    };
  }
}
