export interface UnitState {
  content: string | null;
  enabled: boolean;
  active: boolean;
}
export interface Transaction {
  before: Record<string, UnitState>;
  after: Record<string, string | null>;
}
export interface ServiceOps {
  inspect(name: string, restoring?: boolean): UnitState;
  write(name: string, content: string | null): void;
  system(action: 'stop' | 'start' | 'enable' | 'disable' | 'reload', name?: string): void;
  ready(name: string, restoring?: boolean): Promise<void>;
  journal(transaction: Transaction | null): void;
}
export async function restore(transaction: Transaction, ops: ServiceOps): Promise<void> {
  const failures: unknown[] = [];
  const attempt = (run: () => void): void => {
    try {
      run();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const [name, state] of Object.entries(transaction.before)) {
    attempt(() => {
      const current = ops.inspect(name, true);
      if (current.active || current.content !== null) ops.system('stop', name);
      if (current.enabled) ops.system('disable', name);
      if (current.content !== state.content) ops.write(name, state.content);
    });
  }
  attempt(() => ops.system('reload'));
  for (const [name, state] of Object.entries(transaction.before)) {
    if (state.enabled) attempt(() => ops.system('enable', name));
    if (state.active) {
      try {
        ops.system('start', name);
        await ops.ready(name, true);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Rollback incomplete; run yarn deploy:recover after inspecting the journal',
    );
}
export async function applyUnits(
  after: Record<string, string | null>,
  ops: ServiceOps,
  commit: () => void,
): Promise<void> {
  const before = Object.fromEntries(Object.keys(after).map((name) => [name, ops.inspect(name)]));
  const transaction: Transaction = { before, after };
  ops.journal(transaction);
  try {
    for (const name of Object.keys(after)) if (before[name]?.active) ops.system('stop', name);
    for (const [name, content] of Object.entries(after)) {
      if (before[name]?.content !== null) ops.system('disable', name);
      ops.write(name, content);
    }
    ops.system('reload');
    for (const [name, content] of Object.entries(after))
      if (content !== null) {
        ops.system('enable', name);
        ops.system('start', name);
        await ops.ready(name);
      }
    commit();
  } catch (error) {
    try {
      await restore(transaction, ops);
      ops.journal(null);
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        'Deployment failed; rollback requires yarn deploy:recover',
      );
    }
    throw error;
  }
  ops.journal(null);
}
