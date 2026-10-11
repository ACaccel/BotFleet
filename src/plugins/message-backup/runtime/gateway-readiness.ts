import { Status, type Client } from 'discord.js';

/** Gateway connection facts the archive worker needs, independent of the SDK client. */
export interface ArchiveGatewayReadiness {
  /**
   * Latest time through which every shard is known to have been connected, or
   * `undefined` while the client or any shard is not ready. A shard's last
   * acknowledged heartbeat bounds it, so a silently dead socket stops confirmation;
   * before a shard's first acknowledgement, `now` is used.
   */
  confirmedThrough(now: number): number | undefined;
  /**
   * Current session ID of each ready shard; `undefined` when a ready shard exposes
   * none, which means the SDK's session state could not be read.
   */
  sessions(): ReadonlyMap<number, string | undefined>;
}

/** The SDK keeps resumable session state on the shard without a public accessor. */
interface ShardSessionState {
  readonly sessionInfo?: { readonly sessionId?: unknown } | null;
}

export const clientGatewayReadiness = (client: Client): ArchiveGatewayReadiness => ({
  confirmedThrough(now) {
    const { ws } = client;
    if (ws.status !== Status.Ready || ws.shards.size === 0) return undefined;
    let confirmed = now;
    for (const shard of ws.shards.values()) {
      if (shard.status !== Status.Ready) return undefined;
      if (shard.lastPingTimestamp >= 0) confirmed = Math.min(confirmed, shard.lastPingTimestamp);
    }
    return confirmed;
  },
  sessions() {
    const sessions = new Map<number, string | undefined>();
    for (const [shardId, shard] of client.ws.shards) {
      if (shard.status !== Status.Ready) continue;
      const sessionId = (shard as unknown as ShardSessionState).sessionInfo?.sessionId;
      sessions.set(shardId, typeof sessionId === 'string' ? sessionId : undefined);
    }
    return sessions;
  },
});
