import 'discord.js';
import { reactionKey } from '../../../core/archive/normalize';
import type { ArchiveReactionTarget } from '../../../core/archive/types';

// discord.js emits this documented runtime event but omits it from ClientEvents.
declare module 'discord.js' {
  interface ClientEvents {
    raw: [packet: unknown, shardId: number];
  }
}

interface ArchiveGatewayEventBase {
  readonly eventId: string;
  readonly guildId: string;
  readonly observedAt: number;
}
interface ArchiveMessageEventBase extends ArchiveGatewayEventBase {
  readonly channelId: string;
  readonly messageId: string;
}

/**
 * Written to the durable inbox:
 * - `snapshot` / `delete` / `reaction`: a message change to reconcile.
 * - `gap`: Gateway events may have been lost; the next run reconciles fully.
 */
export type ArchiveInboxEvent =
  | (ArchiveMessageEventBase & {
      readonly kind: 'snapshot';
      readonly raw: Readonly<Record<string, unknown>>;
      /** From MESSAGE_CREATE: the complete message as it was created. */
      readonly created?: true;
    })
  | (ArchiveMessageEventBase & { readonly kind: 'delete'; readonly bulk: boolean })
  | (ArchiveMessageEventBase & {
      readonly kind: 'reaction';
      /** What changed; absent when the event does not say. */
      readonly target?: ArchiveReactionTarget;
    })
  | (ArchiveGatewayEventBase & {
      readonly kind: 'gap';
      /** Why the gap was recorded. */
      readonly reason: string;
    });

/** A channel or thread as its Gateway event describes it; `parentId: null` means none. */
interface ArchiveChannelEventDetails {
  readonly name?: string;
  readonly type?: number;
  readonly parentId?: string | null;
}

/**
 * Handled without the inbox:
 * - `session`: Discord replaced the shard's session; events between the two sessions
 *   were not delivered. Bounded like restart downtime.
 * - `discovery`: a channel or thread was created, changed or deleted. Its
 *   `archive_channels` record is updated directly; every pass still inventories
 *   channels completely, and only a visibility change needs a full source scan.
 */
export type ArchiveControlEvent =
  | (ArchiveGatewayEventBase & {
      readonly kind: 'session';
      /**
       * The shard had no known session (seeding was unavailable), so whether Discord
       * replaced one cannot be told: no rescan is planned, but capture is not proven
       * lossless before this time.
       */
      readonly unseeded?: true;
    })
  | (ArchiveGatewayEventBase & {
      readonly kind: 'discovery';
      readonly channelId: string;
      readonly change: 'create' | 'update' | 'delete';
      readonly channel: ArchiveChannelEventDetails;
    });
export type ArchiveDiscoveryEvent = Extract<ArchiveControlEvent, { kind: 'discovery' }>;

export type ArchiveGatewayEvent = ArchiveInboxEvent | ArchiveControlEvent;

const DISCOVERY_EVENTS: ReadonlySet<string> = new Set([
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_DELETE',
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * What a reaction or poll vote packet changed. An add or remove names the emoji and
 * its type (`type`, or `burst` on older payloads); removing an emoji clears both
 * types; removing all, or an emoji without an identity, affects every list.
 */
const reactionTarget = (type: string, data: Record<string, unknown>): ArchiveReactionTarget => {
  if (type.startsWith('MESSAGE_POLL_VOTE_')) return { scope: 'poll' };
  const emoji = record(data.emoji);
  const key =
    emoji === undefined
      ? undefined
      : reactionKey({
          id: typeof emoji.id === 'string' ? emoji.id : null,
          name: typeof emoji.name === 'string' ? emoji.name : null,
        });
  if (type === 'MESSAGE_REACTION_REMOVE_ALL' || key === undefined) return { scope: 'all' };
  if (type === 'MESSAGE_REACTION_REMOVE_EMOJI') return { scope: 'emoji', emojiKey: key };
  const kind =
    data.type === 0 || data.type === 1
      ? data.type
      : typeof data.burst === 'boolean'
        ? data.burst
          ? 1
          : 0
        : undefined;
  return { scope: 'emoji', emojiKey: key, ...(kind === undefined ? {} : { type: kind }) };
};

/** Raw payloads preserve absent fields that SDK partial defaults would erase. */
export class ArchiveGatewayDecoder {
  private readonly sessions = new Map<number, string>();
  public constructor(private readonly processId: string) {}

  /**
   * Records a shard's current session. The raw listener is attached after login, so
   * the first READY of each shard is never decoded; seeding it lets the next READY
   * be recognized as a replacement. An already decoded session is kept.
   */
  public seed(shardId: number, sessionId: string): void {
    if (!this.sessions.has(shardId)) this.sessions.set(shardId, sessionId);
  }

  public decode(
    packet: unknown,
    shardId: number,
    observedAt: number,
  ): readonly ArchiveGatewayEvent[] {
    const envelope = record(packet);
    const data = record(envelope?.d);
    if (envelope === undefined || data === undefined || typeof envelope.t !== 'string') return [];
    if (envelope.t === 'READY') return this.ready(envelope, data, shardId, observedAt);
    if (typeof data.guild_id !== 'string') return [];
    const session = this.sessions.get(shardId) ?? `${this.processId}:${shardId}`;
    const eventId = `${session}:${String(envelope.s).padStart(20, '0')}:${envelope.t}`;
    const base = { eventId, guildId: data.guild_id, observedAt };
    if (DISCOVERY_EVENTS.has(envelope.t)) {
      // A channel event without the channel's ID names nothing to record.
      if (typeof data.id !== 'string') return [];
      return [
        {
          ...base,
          channelId: data.id,
          kind: 'discovery',
          change: envelope.t.endsWith('_DELETE')
            ? 'delete'
            : envelope.t.endsWith('_CREATE')
              ? 'create'
              : 'update',
          channel: {
            ...(typeof data.name === 'string' ? { name: data.name } : {}),
            ...(typeof data.type === 'number' ? { type: data.type } : {}),
            ...(typeof data.parent_id === 'string' || data.parent_id === null
              ? { parentId: data.parent_id }
              : {}),
          },
        },
      ];
    }
    // Message events always name their channel; one without it cannot be reconciled.
    if (typeof data.channel_id !== 'string') return [];
    const common = { ...base, channelId: data.channel_id };
    if (
      (envelope.t === 'MESSAGE_CREATE' || envelope.t === 'MESSAGE_UPDATE') &&
      typeof data.id === 'string'
    ) {
      return [
        {
          ...common,
          messageId: data.id,
          kind: 'snapshot',
          raw: data,
          ...(envelope.t === 'MESSAGE_CREATE' ? { created: true as const } : {}),
        },
      ];
    }
    if (envelope.t === 'MESSAGE_DELETE' && typeof data.id === 'string') {
      return [{ ...common, messageId: data.id, kind: 'delete', bulk: false }];
    }
    if (envelope.t === 'MESSAGE_DELETE_BULK' && Array.isArray(data.ids)) {
      return data.ids
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({
          ...common,
          eventId: `${eventId}:${id}`,
          messageId: id,
          kind: 'delete' as const,
          bulk: true,
        }));
    }
    if (
      (envelope.t.startsWith('MESSAGE_REACTION_') || envelope.t.startsWith('MESSAGE_POLL_VOTE_')) &&
      typeof data.message_id === 'string'
    ) {
      return [
        {
          ...common,
          messageId: data.message_id,
          kind: 'reaction',
          target: reactionTarget(envelope.t, data),
        },
      ];
    }
    return [];
  }

  /**
   * A READY for a shard without a seeded or decoded session cannot be told apart
   * from a replacement; it is reported `unseeded`, and restart downtime stays
   * covered by the worker's persisted continuity. A READY with another session
   * means Discord replaced the session instead of resuming it (RESUMED replays
   * missed events), so events between the two sessions were never delivered to any
   * guild on the shard.
   */
  private ready(
    envelope: Record<string, unknown>,
    data: Record<string, unknown>,
    shardId: number,
    observedAt: number,
  ): readonly ArchiveGatewayEvent[] {
    const session = data.session_id;
    if (typeof session !== 'string') return [];
    const previous = this.sessions.get(shardId);
    this.sessions.set(shardId, session);
    if (previous === session || !Array.isArray(data.guilds)) return [];
    const sequence = String(envelope.s).padStart(20, '0');
    return data.guilds.flatMap((guild: unknown): ArchiveControlEvent[] => {
      const id = record(guild)?.id;
      return typeof id === 'string'
        ? [
            {
              eventId: `${session}:${sequence}:READY:${id}`,
              guildId: id,
              observedAt,
              kind: 'session',
              ...(previous === undefined ? { unseeded: true as const } : {}),
            },
          ]
        : [];
    });
  }
}
