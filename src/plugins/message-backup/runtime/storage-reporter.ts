import {
  ArchiveStorageSampler,
  resolveArchiveStorageRoots,
} from '../../../infra/archive/storage-usage';
import type { GuildConnection } from '../../../persistence/connection';
import { ArchiveStorageMonitor } from './storage-monitor';
import type { ArchiveGuildState, ArchiveWorkerContextFor } from './worker-context';

/**
 * Samples host storage for admission, shared by every guild, and saves the latest
 * sample of each opened guild for `/archive status`.
 */
export class ArchiveStorageReporter {
  private monitor: ArchiveStorageMonitor | undefined;
  /** Samples being saved; shutdown waits for them before releasing ownership. */
  private readonly reports = new Set<Promise<void>>();
  /** When each guild's sample was last saved. */
  private readonly reportedAt = new WeakMap<ArchiveGuildState, number>();

  public constructor(private readonly ctx: ArchiveWorkerContextFor<'config' | 'logger'>) {}

  /**
   * The shared storage monitor; the first opened guild's connection discloses the
   * MongoDB data directory.
   */
  public monitorFor(conn: GuildConnection): ArchiveStorageMonitor {
    return (this.monitor ??= this.createMonitor(conn));
  }

  /** Stops sampling and waits for samples being saved. */
  public async stop(): Promise<void> {
    await this.monitor?.stop();
    await Promise.allSettled([...this.reports]);
  }

  private createMonitor(conn: GuildConnection): ArchiveStorageMonitor {
    const budget = this.ctx.options.config.storage;
    const sampler = new ArchiveStorageSampler({
      resolveRoots: () =>
        resolveArchiveStorageRoots(
          conn.connection,
          budget.additional_roots,
          budget.mongo_data_root,
        ),
      // Near the budget the stable roots' growth may decide admission.
      exactAboveBytes: Math.floor(budget.budget_bytes * 0.9),
    });
    return new ArchiveStorageMonitor(
      () => sampler.sample(),
      {
        budgetBytes: budget.budget_bytes,
        backgroundLimitBytes: budget.background_limit_bytes,
        reserveBytes: budget.reserve_bytes,
      },
      {
        onWarning: (usage) => {
          this.ctx.options.logger.warn(
            { usedBytes: usage.usedBytes, availableBytes: usage.availableBytes },
            'Archive project capacity warning',
          );
        },
        onSample: (usage) => {
          this.report(usage);
        },
        onError: (error) => {
          this.ctx.options.logger.warn({ err: error }, 'Archive storage sample failed');
        },
      },
    );
  }

  /** Persists the host sample for `/archive status`, at most once a minute per guild. */
  private report({
    usedBytes,
    measuredAt,
    stableMeasuredAt,
  }: {
    readonly usedBytes: number;
    readonly measuredAt: number;
    readonly stableMeasuredAt?: number;
  }): void {
    // Connections close after shutdown; a sample finishing meanwhile is not saved.
    if (this.ctx.stopped) return;
    for (const state of this.ctx.states.values()) {
      if ((this.reportedAt.get(state) ?? 0) > measuredAt - 60_000) continue;
      this.reportedAt.set(state, measuredAt);
      const write = state.archive.storage
        .write({
          usedBytes,
          budgetBytes: this.ctx.options.config.storage.budget_bytes,
          measuredAt,
          ...(stableMeasuredAt === undefined ? {} : { stableMeasuredAt }),
        })
        .catch((error: unknown) => {
          this.ctx.options.logger.warn(
            { guildId: String(state.conn.guildId), err: error },
            'Archive storage sample not persisted',
          );
        })
        .finally(() => this.reports.delete(write));
      this.reports.add(write);
    }
  }
}
