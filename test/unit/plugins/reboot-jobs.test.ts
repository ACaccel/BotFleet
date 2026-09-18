/**
 * Boot-time job rebuild for the activity and giveaway plugins.
 *
 * Startup and guild database recovery repopulate the scheduler: rows whose deadline is still ahead become scheduled jobs,
 * rows already past their deadline are reaped, and a guild whose
 * `listAll` fails must not take the remaining guilds' jobs down with
 * it. The registry here holds two guilds with real rows so those three
 * outcomes are observable in the job map and the repos.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from 'node-schedule';

import { createGiveawayPlugin } from '../../../src/plugins/giveaway';
import { createActivityPlugin } from '../../../src/plugins/activity';
import { createLogger } from '../../../src/core/logger';
import { systemClock } from '../../../src/core/time';
import { createContainer } from '../../../src/core/ioc';
import { TOKENS } from '../../../src/bot/tokens';
import { DatabaseError } from '../../../src/core/errors';
import { err, ok, type Result } from '../../../src/core/result';
import type { GuildRegistry } from '../../../src/bot/guild-registry';
import type { Repos } from '../../../src/persistence/repositories';
import type { PluginRuntimeContext } from '../../../src/core/plugin';

const silent = createLogger({ level: 'silent', pretty: false });

const HOUR_MS = 60 * 60 * 1000;
const future = (): number => Date.now() + HOUR_MS;
const past = (): number => Date.now() - HOUR_MS;

interface Row {
  readonly id: string;
  readonly deadline: number;
}

/**
 * Minimal in-memory stand-in for one guild's repos. Only `activity` and
 * `giveaway` are populated — the reboot path touches nothing else, and
 * a full `Repos` bundle would be eight fakes of noise. `listAll` can be
 * made to fail so the per-guild isolation branch is reachable.
 */
class FakeGuildRepos {
  public readonly deleted: string[] = [];
  private rows: Row[];

  constructor(
    rows: readonly Row[],
    private readonly listAllFails = false,
  ) {
    this.rows = [...rows];
  }

  private list(): Result<readonly Row[], DatabaseError> {
    if (this.listAllFails) {
      return err(
        new DatabaseError({
          code: 'DATABASE_UNKNOWN',
          messageKey: 'errors:db.unavailable',
          context: { operation: 'FakeGuildRepos.listAll' },
        }),
      );
    }
    return ok(this.rows);
  }

  private find(id: string): Result<Row | undefined, DatabaseError> {
    return ok(this.rows.find((r) => r.id === id));
  }

  private remove(id: string): Result<boolean, DatabaseError> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    const removed = this.rows.length !== before;
    if (removed) this.deleted.push(id);
    return ok(removed);
  }

  /**
   * Project the rows onto the two repo surfaces the reboot path calls.
   * The cast is confined to this one seam: the reboot code reaches the
   * bundle only through `activity` / `giveaway`, so widening the fake
   * to the full `Repos` interface would add no assertion power.
   */
  public asRepos(): Repos {
    const activity = {
      listAll: async () =>
        this.list().ok
          ? ok(this.rows.map((r) => ({ activity_id: r.id, expired_at: r.deadline })))
          : this.list(),
      findByActivityId: async (id: string) => this.find(id),
      deleteByActivityId: async (id: string) => this.remove(id),
    };
    const giveaway = {
      listAll: async () =>
        this.list().ok
          ? ok(this.rows.map((r) => ({ message_id: r.id, end_time: r.deadline })))
          : this.list(),
      findByMessageId: async (id: string) => this.find(id),
      deleteByMessageId: async (id: string) => this.remove(id),
    };
    return { activity, giveaway } as unknown as Repos;
  }
}

const buildRegistry = (repos: ReadonlyMap<string, FakeGuildRepos>): GuildRegistry => ({
  getRepos: (guildId) => repos.get(guildId)?.asRepos(),
  getChannel: () => undefined,
  getRole: () => undefined,
  listGuildIds: () => [...repos.keys()],
});

/**
 * Build the plugin runtime context. The Discord client's guild cache is
 * seeded from the registry because the reap path (`deleteActivity` /
 * `deleteGiveaway`) short-circuits on a guild the client does not know.
 */
const buildCtx = (registry: GuildRegistry, jobMap: Map<string, Job>): PluginRuntimeContext => {
  const guilds = new Map<string, unknown>(registry.listGuildIds().map((id) => [id, { id }]));
  const container = createContainer();
  container.registerSingleton(TOKENS.GuildRegistry, () => registry);
  container.registerSingleton(
    TOKENS.DiscordClient,
    () => ({ user: { id: 'bot-1' }, guilds: { cache: guilds } }) as never,
  );
  container.registerSingleton(TOKENS.JobMap, () => jobMap);
  return {
    logger: silent,
    translator: { t: (k: string) => k } as PluginRuntimeContext['translator'],
    clock: systemClock,
    resolve: container.resolve.bind(container) as PluginRuntimeContext['resolve'],
  };
};

const jobMap = new Map<string, Job>();

afterEach(() => {
  for (const job of jobMap.values()) job.cancel();
  jobMap.clear();
});

describe.each([
  {
    label: 'giveaway',
    create: createGiveawayPlugin,
    jobKey: (id: string) => `giveaway:${id}`,
  },
  {
    label: 'activity',
    create: createActivityPlugin,
    jobKey: (id: string) => `activity:${id}`,
  },
])('$label plugin onReady — job reboot', ({ create, jobKey }) => {
  it('rebuilds only the recovered guild without replacing healthy jobs', async () => {
    const healthy = new FakeGuildRepos([{ id: 'healthy', deadline: future() }]);
    const recovered = new FakeGuildRepos([{ id: 'recovered', deadline: future() }]);
    const repos = new Map([['healthy-guild', healthy]]);
    const ctx = buildCtx(buildRegistry(repos), jobMap);
    const plugin = create();
    await plugin.onReady?.(ctx);
    const healthyJob = jobMap.get(jobKey('healthy'));
    repos.set('recovered-guild', recovered);

    await plugin.onGuildDatabaseReady?.(ctx, 'recovered-guild');

    expect([...jobMap.keys()].sort()).toEqual([jobKey('healthy'), jobKey('recovered')].sort());
    expect(jobMap.get(jobKey('healthy'))).toBe(healthyJob);
  });

  it('schedules a job for every row whose deadline is still ahead', async () => {
    const repos = new FakeGuildRepos([
      { id: 'row-a', deadline: future() },
      { id: 'row-b', deadline: future() },
    ]);
    const ctx = buildCtx(buildRegistry(new Map([['g1', repos]])), jobMap);

    await create().onReady?.(ctx);

    expect([...jobMap.keys()].sort()).toEqual([jobKey('row-a'), jobKey('row-b')].sort());
    expect(repos.deleted).toEqual([]);
  });

  it('reaps a row whose deadline already passed instead of scheduling it', async () => {
    const repos = new FakeGuildRepos([
      { id: 'stale', deadline: past() },
      { id: 'live', deadline: future() },
    ]);
    const ctx = buildCtx(buildRegistry(new Map([['g1', repos]])), jobMap);

    await create().onReady?.(ctx);

    expect(repos.deleted).toEqual(['stale']);
    expect([...jobMap.keys()]).toEqual([jobKey('live')]);
  });

  it('keeps rebooting the remaining guilds when one guild cannot be read', async () => {
    const broken = new FakeGuildRepos([{ id: 'unreachable', deadline: future() }], true);
    const healthy = new FakeGuildRepos([{ id: 'reachable', deadline: future() }]);
    const ctx = buildCtx(
      buildRegistry(
        new Map([
          ['g-broken', broken],
          ['g-ok', healthy],
        ]),
      ),
      jobMap,
    );

    await expect(create().onReady?.(ctx)).resolves.toBeUndefined();

    expect([...jobMap.keys()]).toEqual([jobKey('reachable')]);
  });

  it('skips a guild that has no database hookup yet', async () => {
    const registry: GuildRegistry = {
      getRepos: () => undefined,
      getChannel: () => undefined,
      getRole: () => undefined,
      listGuildIds: () => ['g-no-db'],
    };
    const ctx = buildCtx(registry, jobMap);

    await expect(create().onReady?.(ctx)).resolves.toBeUndefined();

    expect(jobMap.size).toBe(0);
  });
});
