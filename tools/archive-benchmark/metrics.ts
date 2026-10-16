import { mongo } from 'mongoose';

const COMMAND_CLASSES = [
  'find',
  'getMore',
  'insert',
  'update',
  'delete',
  'aggregate',
  'count',
  'listIndexes',
  'createIndexes',
  'killCursors',
] as const;
type CommandClass = (typeof COMMAND_CLASSES)[number] | 'other';

interface CommandMetric {
  count: number;
  failures: number;
  durationMs: number;
  requestBsonBytes: number;
  responseBsonBytes: number;
}

/** Retain only bounded command classes and numerical measurements, never commands or replies. */
export class DatabaseMetrics {
  private readonly pending = new Map<number, CommandClass>();
  private readonly metrics = new Map<CommandClass, CommandMetric>();

  attach(client: mongo.MongoClient): () => ReturnType<DatabaseMetrics['snapshot']> {
    client.on('commandStarted', this.started);
    client.on('commandSucceeded', this.succeeded);
    client.on('commandFailed', this.failed);
    let frozen: ReturnType<DatabaseMetrics['snapshot']> | undefined;
    return () => {
      if (frozen === undefined) {
        client.off('commandStarted', this.started);
        client.off('commandSucceeded', this.succeeded);
        client.off('commandFailed', this.failed);
        frozen = this.snapshot();
      }
      return structuredClone(frozen);
    };
  }

  readonly started = (event: mongo.CommandStartedEvent): void => {
    const commandClass: CommandClass = COMMAND_CLASSES.includes(event.commandName as never)
      ? (event.commandName as CommandClass)
      : 'other';
    const metric = this.metric(commandClass);
    metric.count += 1;
    metric.requestBsonBytes += logicalBytes(event.command);
    this.pending.set(event.requestId, commandClass);
  };

  readonly succeeded = (event: mongo.CommandSucceededEvent): void => {
    const commandClass = this.pending.get(event.requestId);
    if (commandClass === undefined) return;
    const metric = this.metric(commandClass);
    metric.durationMs += event.duration;
    metric.responseBsonBytes += logicalBytes(event.reply);
    this.pending.delete(event.requestId);
  };

  readonly failed = (event: mongo.CommandFailedEvent): void => {
    const commandClass = this.pending.get(event.requestId);
    if (commandClass === undefined) return;
    const metric = this.metric(commandClass);
    metric.durationMs += event.duration;
    metric.failures += 1;
    this.pending.delete(event.requestId);
  };

  private metric(commandClass: CommandClass): CommandMetric {
    let metric = this.metrics.get(commandClass);
    if (metric === undefined) {
      metric = { count: 0, failures: 0, durationMs: 0, requestBsonBytes: 0, responseBsonBytes: 0 };
      this.metrics.set(commandClass, metric);
    }
    return metric;
  }

  snapshot(): Readonly<Record<string, Readonly<CommandMetric>>> {
    return Object.fromEntries(Array.from(this.metrics, ([key, value]) => [key, { ...value }]));
  }
}

function logicalBytes(document: unknown): number {
  if (typeof document !== 'object' || document === null) return 0;
  try {
    return mongo.BSON.calculateObjectSize(document as mongo.Document);
  } catch {
    // Monitoring must never change the outcome of a database operation.
    return 0;
  }
}

export function summarize(values: readonly number[]): { median: number; min: number; max: number } {
  if (values.length < 3 || values.some((value) => !Number.isFinite(value)))
    throw new Error('At least three finite samples are required');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return { median, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
}
