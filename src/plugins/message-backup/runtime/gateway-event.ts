import 'discord.js';

// discord.js emits this documented runtime event but omits it from ClientEvents.
declare module 'discord.js' {
  interface ClientEvents {
    raw: [packet: unknown, shardId: number];
  }
}

export interface ArchiveGatewayEvent {
  readonly eventId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly observedAt: number;
  readonly kind: 'snapshot' | 'delete' | 'reaction' | 'gap';
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly bulk?: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Raw payloads preserve absent fields that SDK partial defaults would erase. */
export class ArchiveGatewayDecoder {
  private readonly sessions = new Map<number, string>();
  public constructor(private readonly processId: string) {}

  public decode(
    packet: unknown,
    shardId: number,
    observedAt: number,
  ): readonly ArchiveGatewayEvent[] {
    const envelope = record(packet);
    const data = record(envelope?.d);
    if (envelope === undefined || data === undefined || typeof envelope.t !== 'string') return [];
    if (envelope.t === 'READY') {
      if (typeof data.session_id === 'string') this.sessions.set(shardId, data.session_id);
      return [];
    }
    if (typeof data.guild_id !== 'string') return [];
    const session = this.sessions.get(shardId) ?? `${this.processId}:${shardId}`;
    const eventId = `${session}:${String(envelope.s).padStart(20, '0')}:${envelope.t}`;
    const common = {
      eventId,
      guildId: data.guild_id,
      observedAt,
      channelId: typeof data.channel_id === 'string' ? data.channel_id : '',
    };
    if (
      (envelope.t === 'MESSAGE_CREATE' || envelope.t === 'MESSAGE_UPDATE') &&
      typeof data.id === 'string'
    ) {
      return [{ ...common, messageId: data.id, kind: 'snapshot', raw: data }];
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
      return [{ ...common, messageId: data.message_id, kind: 'reaction' }];
    }
    if (
      [
        'CHANNEL_CREATE',
        'CHANNEL_UPDATE',
        'CHANNEL_DELETE',
        'THREAD_CREATE',
        'THREAD_UPDATE',
        'THREAD_DELETE',
      ].includes(envelope.t)
    ) {
      return [{ ...common, kind: 'gap' }];
    }
    return [];
  }
}
