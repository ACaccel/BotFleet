/**
 * Injectable wall-clock abstraction.
 *
 * Domain and use-case code holds an injected `Clock` instead of calling
 * `Date.now()` / `new Date()` directly, so tests substitute a deterministic
 * fake while production uses {@link systemClock}. The plugin lifecycle
 * context (`PluginInitContext.clock`) carries it to every plugin.
 *
 * Convention: business code receives `Clock` via constructor; modules that
 * legitimately need wall-clock time at module load (rare, mostly
 * `core/logger` for timestamps) keep calling `Date` directly.
 */
export interface Clock {
  /** Current time as a Unix epoch milliseconds value. */
  now(): number;
  /** Current time as a `Date` instance. */
  nowDate(): Date;
}

/**
 * Default {@link Clock} backed by the system wall clock. Stateless;
 * safe to share a single instance across the process.
 */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  nowDate: () => new Date(),
});

/**
 * Build a deterministic fake clock for tests. The returned clock
 * starts at `initial` ms and advances only via {@link FakeClock.advance};
 * `now()` calls are pure reads.
 */
interface FakeClock extends Clock {
  /** Move the clock forward by `ms` milliseconds. */
  advance(ms: number): void;
  /** Hard-set the clock to `ms` milliseconds since epoch. */
  set(ms: number): void;
}

export const createFakeClock = (initial = 0): FakeClock => {
  let current = initial;
  return {
    now: () => current,
    nowDate: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
};
