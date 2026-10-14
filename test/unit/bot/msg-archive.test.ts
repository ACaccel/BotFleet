import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Client } from 'discord.js';

import { MsgArchive } from '../../../src/bot/msg-archive/msg-archive';
import { TOKENS } from '../../../src/bot/tokens';
import { ArchiveControlService } from '../../../src/application/archive/control';
import type { GuildConnection } from '../../../src/persistence/connection';

const wiring = vi.hoisted(() => ({
  use: vi.fn(),
  register: vi.fn(),
  createPlugin: vi.fn(() => ({ name: 'archive' })),
}));
vi.mock('../../../src/bot/index', () => ({
  BaseBot: class {
    config: unknown;
    use = wiring.use;
    container = { registerSingleton: wiring.register };
    constructor(
      _client: unknown,
      _token: string,
      _mongoURI: string,
      _clientId: string,
      config: unknown,
    ) {
      this.config = config;
    }
  },
}));
vi.mock('../../../src/plugins', () => ({ createMessageBackupPlugin: wiring.createPlugin }));

class InspectableMsgArchive extends MsgArchive {
  public suppression() {
    return this.eventBridgeSuppression();
  }
}

beforeEach(() => vi.clearAllMocks());

describe('MsgArchive command wiring', () => {
  it('exposes only archive administration and enables interactions', () => {
    const config = { backup_server: ['guild'], commands: ['talk'] };
    const bot = new InspectableMsgArchive(
      new Client({ intents: [] }),
      'token',
      'mongo',
      'client',
      config,
    );
    expect(bot.config.commands).toEqual(['archive']);
    expect(config.commands).toEqual(['talk']);
    expect(bot.suppression()).toEqual({ guildCreate: true });
    expect(wiring.use).toHaveBeenCalledOnce();
    expect(wiring.createPlugin).toHaveBeenCalledWith({
      backupServers: ['guild'],
      backupLogEnabled: false,
      adminIds: [],
      policy: undefined,
      runtime: undefined,
    });
  });

  it('passes the configured admins to the plugin for its notice mentions', () => {
    new InspectableMsgArchive(new Client({ intents: [] }), 'token', 'mongo', 'client', {
      backup_server: [],
      admin: ['42'],
    });
    expect(wiring.createPlugin).toHaveBeenCalledWith(expect.objectContaining({ adminIds: ['42'] }));
  });

  it('binds the archive control factory that the /archive handlers resolve', () => {
    new InspectableMsgArchive(new Client({ intents: [] }), 'token', 'mongo', 'client', {
      backup_server: [],
    });
    expect(wiring.register).toHaveBeenCalledWith(
      TOKENS.ArchiveControlFactory,
      expect.any(Function),
    );
    const bind = wiring.register.mock.calls[0]?.[1] as () => (target: unknown) => unknown;
    // The bound factory builds the Mongo repositories over the guild database.
    const guild = { guildId: '1', connection: { db: {} } } as unknown as GuildConnection;
    expect(bind()({ guild, defaultIntervalMs: 60_000 })).toBeInstanceOf(ArchiveControlService);
  });

  it('passes the initial schedule interval to the plugin', () => {
    new InspectableMsgArchive(new Client({ intents: [] }), 'token', 'mongo', 'client', {
      backup_server: [],
      backup_interval_minutes: 90,
    });
    expect(wiring.createPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ backupIntervalMs: 5_400_000 }),
    );
  });
});
