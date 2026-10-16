import { addContinuityBreak, settleContinuityBreaks } from '../../../core/archive/continuity';
import type { ArchiveGatewayContinuity, ArchiveRunOrigin } from '../../../core/archive/types';
import type { ArchiveInboxEvent } from './gateway-event';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/**
 * A guild's Gateway continuity: gaps, session and channel breaks, the lossless
 * capture window and its confirmation, kept in memory and persisted per guild.
 */
export class GatewayContinuity {
  /** Gateway events admitted but not yet durable, per guild; they bound continuity confirmation. */
  public readonly inflight = new Map<string, Set<ArchiveInboxEvent>>();

  public constructor(private readonly ctx: ArchiveWorkerContextFor<'gateway' | 'logger'>) {}

  /**
   * A session whose predecessor is unknown may have replaced one. Without a known
   * replacement no rescan is planned, but capture is proven lossless only from
   * now on, so reaction lists refreshed earlier are reread.
   */
  public recordUncertainSession(state: ArchiveGuildState, observedAt: number): void {
    state.continuity.continuousSince = Math.max(state.continuity.continuousSince, observedAt);
    void this.persistContinuitySafely(state);
  }

  /**
   * Gateway events may have been lost: the next run reconciles fully, evidence read
   * before now is stale, and a new lossless capture window starts. Resolves once the
   * flag is durable.
   */
  public flagGap(state: ArchiveGuildState, observedAt = Date.now()): Promise<void> {
    state.continuity.gapVersion += 1;
    state.continuity.fullRequired = true;
    state.continuity.continuousSince = Math.max(state.continuity.continuousSince, observedAt);
    return this.persistContinuity(state);
  }

  /** The in-memory flag stays authoritative; the heartbeat retries a failed write. */
  public async flagGapSafely(state: ArchiveGuildState, observedAt?: number): Promise<void> {
    await this.flagGap(state, observedAt).catch((error: unknown) => {
      this.ctx.options.logger.warn(
        { guildId: String(state.conn.guildId), err: error },
        'Archive Gateway gap state not yet durable; retrying on the next heartbeat',
      );
    });
  }

  /** Clears the full-reconciliation requirement once a closed run proved it settled. */
  public async clearFullRequired(state: ArchiveGuildState): Promise<void> {
    state.continuity.fullRequired = false;
    await this.persistContinuitySafely(state);
  }

  /**
   * A replaced Gateway session is bounded like restart downtime rather than treated
   * as a full-forcing gap: in both cases no events were delivered for a window that
   * starts at the last confirmation (continuity is never confirmed while a shard is
   * disconnected), and session replacement is frequent enough that a full
   * reconciliation each time would keep periodic backup from staying incremental.
   */
  public recordSessionBreak(state: ArchiveGuildState, observedAt: number): void {
    state.continuity.breakIndex += 1;
    state.continuity.breaks = addContinuityBreak(state.continuity.breaks, {
      index: state.continuity.breakIndex,
      start: state.continuity.confirmedAt,
      channelId: null,
    });
    state.continuity.continuousSince = Math.max(state.continuity.continuousSince, observedAt);
    void this.persistContinuitySafely(state);
  }

  /** The source's next scan in a run created after now is full. */
  public async recordChannelBreak(
    state: ArchiveGuildState,
    channelId: string,
    start: number,
  ): Promise<void> {
    state.continuity.breakIndex += 1;
    state.continuity.breaks = addContinuityBreak(state.continuity.breaks, {
      index: state.continuity.breakIndex,
      start,
      channelId,
    });
    await this.persistContinuitySafely(state);
  }

  private continuitySnapshot(state: ArchiveGuildState): ArchiveGatewayContinuity {
    return {
      bootId: this.ctx.bootId,
      continuousSince: state.continuity.continuousSince,
      confirmedAt: state.continuity.confirmedAt,
      fullRequired: state.continuity.fullRequired,
      gapVersion: state.continuity.gapVersion,
      breakIndex: state.continuity.breakIndex,
      breaks: state.continuity.breaks,
    };
  }

  /**
   * Writes the current in-memory continuity; the snapshot is taken when the write
   * starts. `begin` claims the record for this boot; later writes are conditional on
   * it, so a boot that lost ownership cannot overwrite its successor.
   */
  public persistContinuity(
    state: ArchiveGuildState,
    mode: 'begin' | 'write' = 'write',
  ): Promise<void> {
    const write = state.continuity.write.then(() =>
      state.continuity.repo[mode](this.continuitySnapshot(state)),
    );
    state.continuity.write = write.catch(() => undefined);
    return write;
  }

  public async persistContinuitySafely(state: ArchiveGuildState): Promise<void> {
    await this.persistContinuity(state).catch((error: unknown) => {
      this.ctx.options.logger.warn(
        { guildId: String(state.conn.guildId), err: error },
        'Archive Gateway continuity not persisted',
      );
    });
  }

  /**
   * Continuity is confirmed only through the time every shard was last known
   * connected (see `ArchiveGatewayReadiness`): a dropped connection either resumes,
   * with Discord replaying missed events before RESUMED, or ends in a replaced
   * session, which records a break. Events still being made durable hold the
   * confirmation back to their observation time, and nothing is confirmed after
   * shutdown began, because later events are no longer captured.
   */
  public confirmContinuity(guildId: string, state: ArchiveGuildState): void {
    const now = Date.now();
    const through = this.ctx.options.gateway?.confirmedThrough(now);
    if (through === undefined) return;
    let confirmed = Math.min(through, this.ctx.stoppedAt ?? now);
    for (const event of this.inflight.get(guildId) ?? [])
      confirmed = Math.min(confirmed, event.observedAt);
    state.continuity.confirmedAt = Math.max(state.continuity.confirmedAt, confirmed);
  }

  public async heartbeatContinuity(guildId: string, state: ArchiveGuildState): Promise<void> {
    this.confirmContinuity(guildId, state);
    await this.persistContinuitySafely(state);
  }

  /** No Gateway gap since the run began; durable gap versions also compare across boots. */
  public noGapSince(
    state: ArchiveGuildState,
    run: { readonly origin?: ArchiveRunOrigin },
  ): boolean {
    return run.origin?.gapVersion === state.continuity.gapVersion;
  }

  /**
   * A complete run reconciles what it was created to cover, including the passes of
   * a resumed run. A full run settles every Gateway gap up to its origin version; a
   * later gap keeps the next run full. Every run settles the continuity breaks
   * recorded before it was created: it was planned with their rescan bound and full
   * sources, and all its sources were scanned after them. Later breaks stay pending.
   * A full backup settles like a full periodic run, against the origin of its first
   * start: sources it completed before a restart are not revisited.
   */
  public async settleCoverage(
    state: ArchiveGuildState,
    run: { readonly full: boolean; readonly origin?: ArchiveRunOrigin },
  ): Promise<void> {
    const settlesGaps = state.continuity.fullRequired && run.full && this.noGapSince(state, run);
    // Runs from before breaks were indexed carry no index and settle none.
    const breaks = settleContinuityBreaks(state.continuity.breaks, run.origin?.breakIndex ?? 0);
    const settlesBreaks = breaks.length !== state.continuity.breaks.length;
    if (settlesGaps) state.continuity.fullRequired = false;
    if (settlesBreaks) state.continuity.breaks = breaks;
    if (settlesGaps || settlesBreaks) await this.persistContinuitySafely(state);
  }
}
