import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** A startup attestation; deployment also checks systemd state and the current process PID. */
export class ServiceReadiness {
  private readonly startedAt = Date.now();
  private published = false;
  private stopped = false;

  public constructor(private readonly file: string) {
    // A prior crash must not leave an attestation for the new process.
    rmSync(file, { force: true });
  }

  public publish(): void {
    if (this.published || this.stopped) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ pid: process.pid, startedAt: this.startedAt, readyAt: Date.now() }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temporary, this.file);
      this.published = true;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  public stop(): void {
    this.stopped = true;
    rmSync(this.file, { force: true });
  }
}
