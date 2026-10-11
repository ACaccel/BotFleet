import { BackupLog, NullBackupLog } from '../internal/backup-log';
import { buildBackupLogPath } from '../internal/log-path';
import type { ArchiveScanResult, ScanRequest, ScanRunnerDependencies } from './scan-contract';
import { ScanPass, type ScanPassContext } from './scan-pass';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/**
 * Runs history scans of a guild: discovery, history pages and reaction refresh,
 * with checkpoints per channel. Each scan is one `ScanPass`; its `ScanMode`
 * selects a periodic pass or a full backup, which keep separate checkpoints.
 */
export class ScanRunner {
  public constructor(
    private readonly ctx: ScanPassContext & ArchiveWorkerContextFor<'backupLogEnabled'>,
    private readonly deps: ScanRunnerDependencies,
  ) {}

  public async scan(state: ArchiveGuildState, request: ScanRequest): Promise<ArchiveScanResult> {
    const transcript = this.ctx.options.backupLogEnabled
      ? new BackupLog(buildBackupLogPath(String(state.conn.guildId), new Date()))
      : new NullBackupLog();
    transcript.writeln(
      `Archive run ${request.runId}; cutoff ${new Date(request.cutoff).toISOString()}`,
    );
    try {
      const result = await new ScanPass(this.ctx, this.deps, state, request).run();
      transcript.writeln(JSON.stringify(result));
      return result;
    } finally {
      transcript.close();
    }
  }
}
