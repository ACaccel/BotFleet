/**
 * Archive admission was refused by storage or in-process capacity. The work itself
 * is valid and should wait, not count as a failure of the item being processed.
 */
export class ArchiveCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArchiveCapacityError';
  }
}

/**
 * An in-process admission queue (REST scheduler, archive writer) is full. Unlike
 * storage pressure it never pauses a scan; the work waits and is retried.
 */
export class ArchiveBackpressureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArchiveBackpressureError';
  }
}

/** One item exceeds a fixed archive document or byte limit and needs a smaller path. */
export class ArchiveLimitExceededError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArchiveLimitExceededError';
  }
}

/** Another worker boot rewrote this guild's continuity record; this boot no longer owns it. */
export class ArchiveContinuityConflictError extends Error {
  public constructor(bootId: string) {
    super(`Archive continuity record is no longer owned by boot ${bootId}`);
    this.name = 'ArchiveContinuityConflictError';
  }
}
