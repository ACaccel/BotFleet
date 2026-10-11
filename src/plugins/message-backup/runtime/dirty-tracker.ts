/**
 * Tracks which messages the Gateway observed after a REST reader started, so a
 * reader can tell whether its evidence (for example an empty reaction list) is
 * still current.
 *
 * Every Gateway observation of a message takes the next epoch as its version. A
 * reader records the epoch when its read starts (`since`); any later observation
 * of the same message has a version greater than `since`. The table is bounded:
 *
 * - Eviction drops the oldest entry and raises `evictionFloor` to its version.
 *   Versions are assigned in insertion order, so every evicted version is at most
 *   the floor. An absent message therefore may have changed after `since` only
 *   when `evictionFloor > since`. Readers that started after every evicted
 *   version, including a reader of the evicted message itself, stay valid; an
 *   evicted change newer than a reader's start still invalidates that reader.
 * - Settling removes an acknowledged event's entry without raising the floor.
 *   That is safe only when no reader can still compare against the removed
 *   version: no read window that started before it is open and no consumer still
 *   holds a pin on the message. Otherwise removal waits until both are released.
 */
export class ArchiveDirtyTracker {
  private epoch = 0;
  private evictionFloor = 0;
  private readonly versions = new Map<string, number>();
  /** Acknowledged versions whose removal waits for readers. */
  private readonly settled = new Map<string, number>();
  private readonly pins = new Map<string, number>();
  /** Start epochs of open read windows, with their counts. */
  private readonly reads = new Map<number, number>();

  public constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('Invalid archive dirty capacity');
  }

  /** The epoch a reader starting now records as `since`. */
  public get current(): number {
    return this.epoch;
  }

  public get size(): number {
    return this.versions.size;
  }

  /** Open read windows, pinned messages and settlements waiting for them. */
  public get held(): { readonly reads: number; readonly pins: number; readonly settled: number } {
    let reads = 0;
    for (const count of this.reads.values()) reads += count;
    let pins = 0;
    for (const count of this.pins.values()) pins += count;
    return { reads, pins, settled: this.settled.size };
  }

  /** The latest version recorded for a message, if it is still in the table. */
  public versionOf(messageId: string): number | undefined {
    return this.versions.get(messageId);
  }

  /** Records a Gateway observation of a message and returns its version. */
  public observe(messageId: string): number {
    const version = ++this.epoch;
    this.versions.delete(messageId);
    this.settled.delete(messageId);
    this.versions.set(messageId, version);
    if (this.versions.size > this.capacity) {
      const oldest = this.versions.entries().next().value;
      if (oldest !== undefined) {
        this.versions.delete(oldest[0]);
        this.settled.delete(oldest[0]);
        this.evictionFloor = Math.max(this.evictionFloor, oldest[1]);
      }
    }
    return version;
  }

  /** Whether the message may have been observed after epoch `since`. */
  public changedSince(messageId: string, since: number): boolean {
    const version = this.versions.get(messageId);
    return version === undefined ? this.evictionFloor > since : version > since;
  }

  /**
   * Opens a read window at the current epoch. Keep it open until the result's
   * message identities are pinned; `end` is idempotent.
   */
  public beginRead(): { readonly since: number; end(): void } {
    const since = this.epoch;
    this.reads.set(since, (this.reads.get(since) ?? 0) + 1);
    let open = true;
    return {
      since,
      end: () => {
        if (!open) return;
        open = false;
        const count = (this.reads.get(since) ?? 1) - 1;
        if (count > 0) this.reads.set(since, count);
        else this.reads.delete(since);
        for (const [messageId, version] of this.settled) this.removeIfIdle(messageId, version);
      },
    };
  }

  /** Keeps a message's entry until the returned release runs; release is idempotent. */
  public pin(messageId: string): () => void {
    this.pins.set(messageId, (this.pins.get(messageId) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = (this.pins.get(messageId) ?? 1) - 1;
      if (count > 0) {
        this.pins.set(messageId, count);
        return;
      }
      this.pins.delete(messageId);
      const version = this.settled.get(messageId);
      if (version !== undefined) this.removeIfIdle(messageId, version);
    };
  }

  /** Removes an acknowledged observation once no reader can still need it. */
  public settle(messageId: string, version: number): void {
    if (this.versions.get(messageId) !== version) return;
    this.settled.set(messageId, version);
    this.removeIfIdle(messageId, version);
  }

  private removeIfIdle(messageId: string, version: number): void {
    if (this.versions.get(messageId) !== version) {
      this.settled.delete(messageId);
      return;
    }
    if (this.pins.has(messageId)) return;
    for (const since of this.reads.keys()) if (since < version) return;
    this.versions.delete(messageId);
    this.settled.delete(messageId);
  }
}

/**
 * Pins taken by reads in one scan, or one source of it. Releases left when the
 * scope closes (discovery reads, overlap messages, abandoned prefetches) run then;
 * a read that finishes after closing is released at once.
 */
export class ArchiveObservationScope {
  private closed = false;
  private readonly releases = new Set<() => void>();

  public add(release: () => void): void {
    if (this.closed) release();
    else this.releases.add(release);
  }

  public remove(release: () => void): void {
    this.releases.delete(release);
  }

  public close(): void {
    this.closed = true;
    for (const release of [...this.releases]) release();
    this.releases.clear();
  }
}
