import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import type { ArchiveInboxDraft, ArchiveSnapshot } from '../../../core/archive/types';
import { archiveAuthorKind, normalizeMessage } from '../../../core/archive/normalize';
import { policyIgnoresContent } from '../../../core/archive/policy';
import { ArchiveCapacityError } from '../../../core/archive/errors';
import { everyoneCanView, type ChannelLocator } from './channel-location';
import type { GatewayContinuity } from './continuity';
import type {
  ArchiveControlEvent,
  ArchiveDiscoveryEvent,
  ArchiveGatewayEvent,
  ArchiveInboxEvent,
} from './gateway-event';
import {
  mutateArchive,
  type ArchiveGuildState,
  type ArchiveWorkerContextFor,
} from './worker-context';

/** Message content an excluded source never needs captured (see `policyIgnoresContent`). */
const CONTENT_FIELDS = [
  'content',
  'attachments',
  'reactions',
  'stickers',
  'embeds',
  'mentions',
  'reference',
  'thread',
  'poll',
  'components',
  'messageSnapshots',
] as const satisfies readonly (keyof ArchiveSnapshot)[];

/**
 * Captures Gateway events: inbox events become durable before they are reduced,
 * channel events update `archive_channels`, and sessions and gaps update continuity.
 */
export class GatewayCapture {
  private readonly captures = new Set<Promise<void>>();
  private readonly admissions = new Map<string, number>();
  private readonly dropped = new Set<string>();

  public constructor(
    private readonly ctx: ArchiveWorkerContextFor<
      'client' | 'config' | 'guildIds' | 'logger' | 'policy'
    >,
    private readonly continuity: GatewayContinuity,
    private readonly locator: ChannelLocator,
  ) {}

  /** Whether events were dropped for the guild before it had a state; clears the mark. */
  public takeDropped(guildId: string): boolean {
    return this.dropped.delete(guildId);
  }

  /** Captures and channel events still running; shutdown waits for them. */
  public pending(): Promise<void>[] {
    return [...this.captures];
  }

  public async capture(event: ArchiveGatewayEvent): Promise<void> {
    if (this.ctx.stopped || !this.ctx.options.guildIds.includes(event.guildId)) return;
    switch (event.kind) {
      case 'session':
        return this.captureSession(event);
      case 'discovery':
        return this.track(() => this.observeChannel(event));
      case 'snapshot':
      case 'delete':
      case 'reaction':
      case 'gap':
        return this.captureInbox(event);
      default: {
        const unreachable: never = event;
        throw new TypeError(`Unknown archive Gateway event ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async captureSession(
    event: Extract<ArchiveControlEvent, { kind: 'session' }>,
  ): Promise<void> {
    const record = (state: ArchiveGuildState): void => {
      if (event.unseeded === true) this.continuity.recordUncertainSession(state, event.observedAt);
      else this.continuity.recordSessionBreak(state, event.observedAt);
    };
    const existing = this.ctx.states.get(event.guildId);
    // Recorded before any later event of the new session can be confirmed.
    if (existing !== undefined) {
      record(existing);
      return;
    }
    await this.track(async () => {
      const state = await this.ctx.initialize(event.guildId);
      if (!this.ctx.stopped) record(state);
    });
  }

  private async captureInbox(event: ArchiveInboxEvent): Promise<void> {
    const active = this.admissions.get(event.guildId) ?? 0;
    if (active >= this.ctx.options.config.max_pending_events) {
      const state = this.ctx.states.get(event.guildId);
      // Without a state the gap is flagged when the guild is opened.
      if (state === undefined) this.dropped.add(event.guildId);
      else await this.continuity.flagGapSafely(state);
      throw new Error('Archive capture queue overflow; history reconciliation required');
    }
    this.admissions.set(event.guildId, active + 1);
    let inflight = this.continuity.inflight.get(event.guildId);
    if (inflight === undefined) {
      inflight = new Set();
      this.continuity.inflight.set(event.guildId, inflight);
    }
    inflight.add(event);
    const pending = this.captureEvent(event);
    this.captures.add(pending);
    try {
      await pending;
    } finally {
      inflight.delete(event);
      this.admissions.set(event.guildId, (this.admissions.get(event.guildId) ?? 1) - 1);
      this.captures.delete(pending);
    }
  }

  /** Shutdown waits for tracked work. */
  private async track(work: () => Promise<void>): Promise<void> {
    const pending = work();
    this.captures.add(pending);
    try {
      await pending;
    } finally {
      this.captures.delete(pending);
    }
  }

  private async captureEvent(event: ArchiveInboxEvent): Promise<void> {
    const state = await this.ctx.initialize(event.guildId);
    // Eviction from the bounded table only invalidates readers older than the
    // evicted version; it is not a Gateway loss (see ArchiveDirtyTracker).
    if (event.kind !== 'gap')
      state.captureVersions.set(event.eventId, {
        messageId: event.messageId,
        version: state.dirty.observe(event.messageId),
      });
    try {
      await this.persistEvent(state, event);
    } catch (error) {
      state.captureVersions.delete(event.eventId);
      await this.continuity.flagGapSafely(state);
      throw error;
    }
    state.inbox.loop?.wake();
    // Applying the inbox event repeats this; flagging now invalidates a running scan
    // and the continuity window without waiting for the next drain.
    if (event.kind === 'gap') await this.continuity.flagGapSafely(state, event.observedAt);
  }

  /**
   * A channel or thread event updates its `archive_channels` record: name, type,
   * parent and `everyoneCanView`, or `access: 'deleted'`. The record is kept after
   * deletion so readers can still name the channel. A failed update is only logged:
   * the next discovery pass inventories every channel again.
   */
  private async observeChannel(event: ArchiveDiscoveryEvent): Promise<void> {
    // The SDK applies the channel change to its cache after emitting the raw packet.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.ctx.stopped || event.channelId === '') return;
    const state = await this.ctx.initialize(event.guildId);
    try {
      await this.recordChannelEvent(state, event);
    } catch (error) {
      this.ctx.options.logger.warn(
        { guildId: event.guildId, channelId: event.channelId, err: error },
        'Archive channel event not recorded; the next discovery pass updates it',
      );
    }
    await this.checkVisibility(state, event);
  }

  private async recordChannelEvent(
    state: ArchiveGuildState,
    event: ArchiveDiscoveryEvent,
  ): Promise<void> {
    const observedAt = event.observedAt;
    if (event.change === 'delete') {
      await mutateArchive(state, () =>
        state.repos.channels.recordChannel({
          channelId: event.channelId,
          observedAt,
          ...event.channel,
          access: 'deleted',
        }),
      );
      state.knownChannels?.add(event.channelId);
      return;
    }
    const cached = this.ctx.options.client.channels.cache.get(event.channelId);
    const channel = cached === undefined || cached.isDMBased() ? undefined : cached;
    const visible = everyoneCanView(channel);
    const user = this.ctx.options.client.user;
    const readable =
      channel === undefined || user === null
        ? undefined
        : channel
            .permissionsFor(user)
            ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    await mutateArchive(state, () =>
      state.repos.channels.recordChannel({
        channelId: event.channelId,
        observedAt,
        ...event.channel,
        ...(channel === undefined
          ? {}
          : { name: channel.name, type: channel.type, parentId: channel.parentId }),
        ...(visible === undefined ? {} : { everyoneCanView: visible }),
        // Access of an existing record changes only through discovery.
        ...(readable === undefined ? {} : { initialAccess: readable ? 'readable' : 'denied' }),
      }),
    );
    state.knownChannels?.add(event.channelId);
  }

  /**
   * Every pass inventories channels and threads completely, so a channel change needs
   * no rescan unless the bot lost sight of a source it could read: Discord delivers
   * no events for it meanwhile, so its next scan must be full. Visibility changed
   * through the bot's roles emits no channel event and is not detected here.
   */
  private async checkVisibility(
    state: ArchiveGuildState,
    event: ArchiveDiscoveryEvent,
  ): Promise<void> {
    const channel = this.ctx.options.client.channels.cache.get(event.channelId);
    const user = this.ctx.options.client.user;
    if (this.ctx.stopped || channel === undefined || channel.isDMBased() || user === null) return;
    if (
      channel
        .permissionsFor(user)
        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) === true
    )
      return;
    const stored = await state.repos.channels.channelAccess(event.channelId);
    if (stored?.access === 'readable' && !this.ctx.stopped)
      await this.continuity.recordChannelBreak(state, event.channelId, event.observedAt);
  }

  /** The inbox form of a captured event; snapshots are normalized here. */
  private inboxDraft(event: ArchiveInboxEvent): ArchiveInboxDraft {
    const { eventId, observedAt } = event;
    switch (event.kind) {
      case 'snapshot': {
        const snapshot = normalizeMessage(
          { ...event.raw },
          { channelId: event.channelId, observedAt },
        );
        // Content of a source no rule names, or whose author is unknown, never enters
        // the durable inbox: only the fields a policy decision or interaction record
        // needs are kept, and the REST reconciliation reads the rest if it is kept.
        const partial =
          archiveAuthorKind(snapshot) === 'unknown' ||
          policyIgnoresContent(snapshot, this.ctx.options.policy);
        if (partial) for (const field of CONTENT_FIELDS) delete snapshot[field];
        const channel = this.locator.channelHint(event.channelId);
        return {
          eventId,
          observedAt,
          kind: 'snapshot',
          channelId: event.channelId,
          messageId: event.messageId,
          payload: {
            snapshot,
            ...(channel === undefined ? {} : { channel }),
            // Only a complete creation needs no REST read.
            ...(event.created === true && !partial ? { create: true as const } : {}),
          },
        };
      }
      case 'delete':
        return {
          eventId,
          observedAt,
          kind: 'delete',
          channelId: event.channelId,
          messageId: event.messageId,
          payload: {},
        };
      case 'reaction':
        return {
          eventId,
          observedAt,
          kind: 'reaction',
          channelId: event.channelId,
          messageId: event.messageId,
          payload: event.target === undefined ? {} : { target: event.target },
        };
      case 'gap':
        return { eventId, observedAt, kind: 'gap', payload: { reason: event.reason } };
      default: {
        const unreachable: never = event;
        throw new TypeError(`Unknown archive inbox event ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async persistEvent(state: ArchiveGuildState, event: ArchiveInboxEvent): Promise<void> {
    const draft = this.inboxDraft(event);
    const bytes = Buffer.byteLength(JSON.stringify(draft.payload)) * 3 + 4096;
    // Serialize admission, while reducing events independently. Cache a
    // conservative upper bound so each Gateway event does not scan the inbox.
    await state.inbox.writer.run(async () => {
      if (
        state.inbox.budget === undefined ||
        Date.now() - state.inbox.budget.measuredAt >= 30_000
      ) {
        state.inbox.budget = {
          bytes: await state.repos.inbox.inboxBytes(),
          measuredAt: Date.now(),
        };
      }
      if (state.inbox.budget.bytes + bytes > this.ctx.options.config.max_inbox_bytes)
        throw new ArchiveCapacityError('Archive inbox capacity exhausted');
      await state.storage.withReservation(bytes, false, () => state.repos.inbox.enqueue(draft));
      state.inbox.budget.bytes += bytes;
    });
  }

  /**
   * Records a Gateway gap for every archived guild. A guild that fails does not stop
   * the others; its in-memory gap still forces full reconciliation in this boot.
   */
  public async markGap(reason: string): Promise<void> {
    const failures: unknown[] = [];
    for (const guildId of this.ctx.options.guildIds) {
      try {
        const state = await this.ctx.initialize(guildId);
        const observedAt = Date.now();
        await this.continuity.flagGapSafely(state, observedAt);
        await this.persistEvent(state, {
          eventId: `gap:${randomUUID()}`,
          guildId,
          kind: 'gap',
          observedAt,
          reason,
        });
      } catch (error) {
        failures.push(error);
        this.ctx.options.logger.error(
          { guildId, reason, err: error },
          'Archive Gateway gap could not be recorded',
        );
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Archive Gateway gap not recorded for ${failures.length} guild(s)`,
      );
  }
}
