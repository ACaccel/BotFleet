import { Collection, Status, WebSocketShard, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { clientGatewayReadiness } from '../../../src/plugins/message-backup/runtime/gateway-readiness';

const client = (
  managerStatus: Status,
  shards: { status: Status; lastPingTimestamp: number; sessionId?: string }[],
) =>
  ({
    ws: {
      status: managerStatus,
      shards: new Collection(
        shards.map((shard, id) => [
          id,
          {
            status: shard.status,
            lastPingTimestamp: shard.lastPingTimestamp,
            sessionInfo: shard.sessionId === undefined ? null : { sessionId: shard.sessionId },
          },
        ]),
      ),
    },
  }) as unknown as Client;

describe('client Gateway readiness', () => {
  it('confirms through the oldest acknowledged heartbeat, or now before the first', () => {
    const readiness = clientGatewayReadiness(
      client(Status.Ready, [
        { status: Status.Ready, lastPingTimestamp: 900 },
        { status: Status.Ready, lastPingTimestamp: 700 },
        { status: Status.Ready, lastPingTimestamp: -1 },
      ]),
    );
    expect(readiness.confirmedThrough(1000)).toBe(700);
    expect(
      clientGatewayReadiness(
        client(Status.Ready, [{ status: Status.Ready, lastPingTimestamp: -1 }]),
      ).confirmedThrough(1000),
    ).toBe(1000);
    expect(
      clientGatewayReadiness(
        client(Status.Ready, [{ status: Status.Ready, lastPingTimestamp: 5000 }]),
      ).confirmedThrough(1000),
    ).toBe(1000);
  });

  it.each([
    { name: 'a reconnecting manager', manager: Status.Reconnecting, shard: Status.Ready },
    { name: 'an idle manager', manager: Status.Idle, shard: Status.Ready },
    { name: 'a resuming shard', manager: Status.Ready, shard: Status.Resuming },
    { name: 'a disconnected shard', manager: Status.Ready, shard: Status.Disconnected },
  ])('confirms nothing with $name', ({ manager, shard }) => {
    expect(
      clientGatewayReadiness(
        client(manager, [
          { status: Status.Ready, lastPingTimestamp: 900 },
          { status: shard, lastPingTimestamp: 900 },
        ]),
      ).confirmedThrough(1000),
    ).toBeUndefined();
    expect(clientGatewayReadiness(client(Status.Ready, [])).confirmedThrough(1000)).toBeUndefined();
  });

  it('reports the session of each ready shard and marks unreadable ones', () => {
    expect(
      clientGatewayReadiness(
        client(Status.Ready, [
          { status: Status.Ready, lastPingTimestamp: 1, sessionId: 'a' },
          { status: Status.Ready, lastPingTimestamp: 1 },
          { status: Status.Resuming, lastPingTimestamp: 1, sessionId: 'c' },
        ]),
      ).sessions(),
    ).toEqual(
      new Map([
        [0, 'a'],
        [1, undefined],
      ]),
    );
  });

  // Contract: the SDK's own shard class must keep the private session state that
  // seeding reads. A discord.js rename makes this fail instead of silently skipping.
  it('reads the session the SDK stores on its real WebSocketShard', () => {
    const Shard = WebSocketShard as unknown as new (manager: unknown, id: number) => WebSocketShard;
    const shard = new Shard({ debug: () => undefined }, 0);
    expect(Object.getOwnPropertyDescriptor(shard, 'sessionInfo')).toMatchObject({
      value: null,
      writable: true,
    });
    shard.status = Status.Ready;
    // The SDK's `updateSessionInfo` callback assigns the @discordjs/ws session info.
    Object.assign(shard, {
      sessionInfo: {
        sessionId: 'login',
        sequence: 1,
        resumeURL: 'wss://gateway.discord.gg',
        shardId: 0,
        shardCount: 1,
      },
    });
    const ready = {
      ws: { status: Status.Ready, shards: new Collection([[0, shard]]) },
    } as unknown as Client;
    expect(clientGatewayReadiness(ready).sessions()).toEqual(new Map([[0, 'login']]));
  });
});
