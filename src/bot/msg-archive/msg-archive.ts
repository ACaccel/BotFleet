import type { Client } from 'discord.js';

import type { Config } from '@bot';
import { BaseBot } from '@bot';
import type { ClientEventBridgeSuppression } from '../client-event-bridge';
import { TOKENS } from '../tokens';
import { archiveControlFactory } from '../../application/archive/control';
import { buildArchiveRepos } from '../../persistence/repositories/archive-repos';
import { createMessageBackupPlugin } from '@plugins';

interface MsgArchiveConfig extends Config {
  backup_server: string[];
  /**
   * Initial interval for guilds without a persisted archive schedule.
   * Optional — defaults to one hour. New schedules start disabled.
   */
  backup_interval_minutes?: number;
  /**
   * Whether each backup pass writes its per-guild transcript to
   * `logs/backup/`. Optional — defaults to `false`. This only controls
   * transcripts, independently of whether a guild's schedule is enabled.
   */
  backup_log_enabled?: boolean;
  archive_policy?: unknown;
  archive_runtime?: unknown;
}

const MINUTE_MS = 60 * 1000;

/**
 * MsgArchive composition root. The periodic-backup lifecycle (channel
 * collection, resumable pagination, live capture and full-backup jobs) lives in {@link createMessageBackupPlugin}. This class
 * registers that plugin, binds the archive control factory and accepts the
 * archive administration command.
 * Reactions and guildCreate onboarding remain suppressed through the
 * `eventBridgeSuppression` hook.
 */
export class MsgArchive extends BaseBot<MsgArchiveConfig> {
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: MsgArchiveConfig,
  ) {
    super(client, token, mongoURI, clientId, {
      ...config,
      commands: ['archive'],
    });
    const intervalMinutes = this.config.backup_interval_minutes;
    // Archive control is meaningful only where archive ownership lives.
    this.container.registerSingleton(TOKENS.ArchiveControlFactory, () =>
      archiveControlFactory(buildArchiveRepos),
    );
    this.use(
      createMessageBackupPlugin({
        backupServers: this.config.backup_server,
        backupLogEnabled: this.config.backup_log_enabled ?? false,
        adminIds: this.config.admin ?? [],
        policy: this.config.archive_policy,
        runtime: this.config.archive_runtime,
        ...(intervalMinutes !== undefined ? { backupIntervalMs: intervalMinutes * MINUTE_MS } : {}),
      }),
    );
  }

  protected override archiveOwner(): 'msg-archive' {
    return 'msg-archive';
  }

  protected override eventBridgeSuppression(): ClientEventBridgeSuppression {
    return { reaction: true, guildCreate: true };
  }
}
