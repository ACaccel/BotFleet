import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface ProcessReading {
  cpuTicks: number;
  rssPages: number;
}

export function parseProcessStat(stat: string): ProcessReading {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  const rssPages = Number(fields[21]);
  if ([user, system, rssPages].some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Invalid isolated Mongo process statistics');
  return { cpuTicks: user + system, rssPages };
}

/** Linux statistics for the disposable mongod only; no host-wide attribution. */
export class MongoProcessSampler {
  private readonly ticks = Number(
    execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(),
  );
  private readonly pageBytes = Number(
    execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim(),
  );
  private readonly initial: ProcessReading;
  private peakRssPages: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private sampleError = false;
  private stopped:
    | {
        scope: 'disposable-mongod-process';
        cpuMs: number;
        sampledPeakRssBytes: number;
        sampleIntervalMs: number;
        complete: boolean;
      }
    | undefined;
  constructor(private readonly pid: number) {
    if (!Number.isSafeInteger(pid) || pid < 1 || !(this.ticks > 0) || !(this.pageBytes > 0))
      throw new Error('Invalid isolated Mongo process identity');
    this.initial = this.read();
    this.peakRssPages = this.initial.rssPages;
    this.timer = setInterval(() => {
      try {
        this.peakRssPages = Math.max(this.peakRssPages, this.read().rssPages);
      } catch {
        this.sampleError = true;
      }
    }, 100);
    this.timer.unref();
  }
  stop() {
    if (this.stopped !== undefined) return { ...this.stopped };
    clearInterval(this.timer);
    const final = this.read();
    this.peakRssPages = Math.max(this.peakRssPages, final.rssPages);
    this.stopped = {
      scope: 'disposable-mongod-process' as const,
      cpuMs: ((final.cpuTicks - this.initial.cpuTicks) * 1000) / this.ticks,
      sampledPeakRssBytes: this.peakRssPages * this.pageBytes,
      sampleIntervalMs: 100,
      complete: !this.sampleError,
    };
    return { ...this.stopped };
  }
  private read(): ProcessReading {
    return parseProcessStat(readFileSync(`/proc/${this.pid}/stat`, 'utf8'));
  }
}
