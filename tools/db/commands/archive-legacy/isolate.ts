/**
 * `db archive-legacy-isolate` — move the legacy message archive aside
 * before the from-scratch rebuild.
 *
 * Per guild database it renames the legacy data collections to
 * `legacy_<timestamp>_<name>` (an in-database `renameCollection`, which
 * is instant regardless of size), drops the legacy control metadata, and
 * forces the periodic schedule to disabled. `archive_leases` is kept.
 *
 * Preconditions, each refusing the guild rather than proceeding:
 * - msg-archive is stopped. A real run claims the owner lease in
 *   `archive_leases` atomically (the same document msg-archive inserts),
 *   so msg-archive cannot start while isolation runs; the lease is
 *   released afterwards. A dry run only checks that no lease is held.
 *   The lease has no expiry, so a crashed process leaves it behind; the
 *   operator removes it only after confirming the process is gone.
 * - `messages` holds no new-format (`schemaVersion: 3`) document, so a
 *   repeated run can never move a rebuilt archive aside.
 * - No other legacy set exists, unless `legacy_timestamp` names that set
 *   to resume an interrupted isolation.
 *
 * Order: disable the schedule, rename (`messages` last), then drop, so a
 * failure never leaves data dropped but not moved. A failure part-way
 * reports `partial` with per-collection `done` flags and the
 * `legacy_timestamp` to resume with.
 *
 * Safety: `dry_run` defaults to `true` and reports each collection's
 * document count, size, and planned action without writing anything.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Connection, mongo } from 'mongoose';
import { z } from 'zod';

import { defineCommand, type DbCommandResult } from '../../framework/command';
import { runPerGuild, type GuildOutcome } from '../../framework/guild-runner';

import {
  collectionStats,
  isolationActionFor,
  LEASES_COLLECTION,
  legacyCollectionName,
  legacyTimestampSchema,
  legacyTimestampsIn,
  listCollectionNames,
  requireDb,
  SCHEDULE_COLLECTION,
  type CollectionStats,
  type IsolationAction,
} from './collections';

export const isolateOptionsSchema = z.object({
  dry_run: z.boolean().default(true),
  /** Resume an interrupted isolation into this existing legacy set instead of starting a new one. */
  legacy_timestamp: legacyTimestampSchema.nullable().default(null),
});

type IsolateOptions = z.infer<typeof isolateOptionsSchema>;

/** The schema version the rebuilt archive writes; its presence means isolation already happened. */
const NEW_SCHEMA_VERSION = 3;
/** The owner lease document key msg-archive uses (`ArchiveRepository.acquireOwner`). */
const OWNER_LEASE_ID = 'owner';
const DUPLICATE_KEY = 11000;

interface CollectionPlan extends CollectionStats {
  readonly name: string;
  readonly action: IsolationAction;
  /** Rename target; set only for `rename`. */
  readonly target?: string;
  /** Whether a real run completed this collection's step; absent in a dry run and for kept collections. */
  readonly done?: boolean;
}

type IsolateSuccess =
  | { readonly status: 'would-isolate' | 'isolated'; readonly collections: CollectionPlan[] }
  | {
      readonly status: 'partial';
      readonly error: string;
      readonly collections: CollectionPlan[];
      readonly resumeWith: { readonly legacy_timestamp: string };
    }
  | { readonly status: 'refused'; readonly reason: string };

type FlatOutcome = { readonly guildId: string } & (
  | IsolateSuccess
  | { readonly status: 'error'; readonly error: string }
);

interface LeaseDocument {
  _id: string;
  key?: unknown;
  ownerId?: unknown;
  acquiredAt?: unknown;
}

const leases = (db: mongo.Db) => db.collection<LeaseDocument>(LEASES_COLLECTION);

/** The current owner lease holder, `<unknown owner>` for a malformed lease, or `null` when free. */
const findOwnerLease = async (db: mongo.Db): Promise<string | null> => {
  const lease = await leases(db).findOne({
    $or: [{ _id: OWNER_LEASE_ID }, { key: OWNER_LEASE_ID }],
  });
  if (lease === null) return null;
  return typeof lease.ownerId === 'string' ? lease.ownerId : '<unknown owner>';
};

const leaseRefusal = (owner: string): string =>
  `msg-archive still holds the owner lease (${owner}); stop msg-archive first, or remove the stale lease after confirming the process is gone`;

/**
 * Claim the owner lease the way msg-archive does. The owner ID uses
 * msg-archive's `host:pid:uuid` form, so its startup recovery can release
 * a lease this tool leaves behind if it is killed.
 */
const claimOwnerLease = async (
  db: mongo.Db,
  ownerId: string,
  now: number,
): Promise<string | null> => {
  const owner = await findOwnerLease(db);
  if (owner !== null) return leaseRefusal(owner);
  try {
    await leases(db).insertOne({
      _id: OWNER_LEASE_ID,
      key: OWNER_LEASE_ID,
      ownerId,
      acquiredAt: now,
    });
    return null;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === DUPLICATE_KEY
    ) {
      return leaseRefusal((await findOwnerLease(db)) ?? '<unknown owner>');
    }
    throw error;
  }
};

const stateRefusal = async (
  db: mongo.Db,
  names: readonly string[],
  timestamp: string,
  resuming: boolean,
): Promise<string | null> => {
  const existing = legacyTimestampsIn(names);
  const foreign = existing.filter((t) => t !== timestamp);
  if (foreign.length > 0 || (existing.length > 0 && !resuming)) {
    return `legacy set(s) already present (${existing.join(', ')}); export and drop them first, or set legacy_timestamp to resume an interrupted isolation`;
  }
  if (names.includes('messages')) {
    const rebuilt = await db
      .collection('messages')
      .findOne({ schemaVersion: NEW_SCHEMA_VERSION }, { projection: { _id: 1 } });
    if (rebuilt !== null) {
      return 'messages already holds new-format documents; refusing to move a rebuilt archive aside';
    }
  }
  return null;
};

const planCollections = async (
  db: mongo.Db,
  names: readonly string[],
  timestamp: string,
): Promise<CollectionPlan[]> => {
  const plans: CollectionPlan[] = [];
  for (const name of names) {
    const action = isolationActionFor(name);
    if (action === null) continue;
    const stats = await collectionStats(db, name);
    plans.push({
      name,
      action,
      ...stats,
      ...(action === 'rename' ? { target: legacyCollectionName(timestamp, name) } : {}),
    });
  }
  return plans;
};

/** Disable the periodic schedule the same way `/archive schedule enabled:false` does. */
const disableSchedule = async (db: mongo.Db): Promise<void> => {
  await db.collection<{ _id: string }>(SCHEDULE_COLLECTION).updateOne(
    { _id: 'current' },
    {
      $set: { enabled: false, nextRunAt: null, running: false },
      $inc: { revision: 1, pauseVersion: 1 },
    },
  );
};

/** The apply order: schedule, renames with `messages` last, then drops. */
const orderedSteps = (plans: readonly CollectionPlan[]): CollectionPlan[] => [
  ...plans.filter((p) => p.action === 'disable-schedule'),
  ...plans.filter((p) => p.action === 'rename' && p.name !== 'messages'),
  ...plans.filter((p) => p.action === 'rename' && p.name === 'messages'),
  ...plans.filter((p) => p.action === 'drop'),
];

const applyPlan = async (
  db: mongo.Db,
  plans: readonly CollectionPlan[],
  timestamp: string,
): Promise<IsolateSuccess> => {
  const done = new Set<string>();
  // Kept collections have no step, so only actionable entries carry a `done` flag.
  const withFlags = () =>
    plans.map((plan) =>
      plan.action === 'keep' || plan.action === 'keep-unclassified'
        ? plan
        : { ...plan, done: done.has(plan.name) },
    );
  try {
    for (const step of orderedSteps(plans)) {
      if (step.action === 'disable-schedule') await disableSchedule(db);
      if (step.action === 'rename' && step.target !== undefined) {
        await db.renameCollection(step.name, step.target, { dropTarget: false });
      }
      if (step.action === 'drop') await db.dropCollection(step.name);
      done.add(step.name);
    }
  } catch (error: unknown) {
    return {
      status: 'partial',
      error: error instanceof Error ? error.message : String(error),
      collections: withFlags(),
      resumeWith: { legacy_timestamp: timestamp },
    };
  }
  return { status: 'isolated', collections: withFlags() };
};

const isolateGuild = async (
  db: mongo.Db,
  options: IsolateOptions,
  timestamp: string,
): Promise<IsolateSuccess> => {
  const names = await listCollectionNames(db);
  const reason = await stateRefusal(db, names, timestamp, options.legacy_timestamp !== null);
  if (reason !== null) return { status: 'refused', reason };
  const plans = await planCollections(db, names, timestamp);
  if (options.dry_run) return { status: 'would-isolate', collections: plans };
  return applyPlan(db, plans, timestamp);
};

const processGuild = async (
  connection: Connection,
  guildId: string,
  options: IsolateOptions,
  timestamp: string,
  ownerId: string,
  now: () => number,
): Promise<IsolateSuccess> => {
  const db = requireDb(connection.db, guildId);
  if (options.dry_run) {
    const owner = await findOwnerLease(db);
    return owner === null
      ? isolateGuild(db, options, timestamp)
      : { status: 'refused', reason: leaseRefusal(owner) };
  }
  const refused = await claimOwnerLease(db, ownerId, now());
  if (refused !== null) return { status: 'refused', reason: refused };
  try {
    return await isolateGuild(db, options, timestamp);
  } finally {
    await leases(db).deleteOne({ _id: OWNER_LEASE_ID, ownerId });
  }
};

const toFlatOutcome = (o: GuildOutcome<IsolateSuccess>): FlatOutcome =>
  o.ok && o.result !== null
    ? { guildId: o.guildId, ...o.result }
    : { guildId: o.guildId, status: 'error', error: o.error ?? 'unknown error' };

export const createIsolateCommand = (now: () => number = Date.now) =>
  defineCommand<IsolateOptions>({
    name: 'archive-legacy-isolate',
    description: 'Rename legacy message-archive collections aside and drop their control metadata.',
    optionsSchema: isolateOptionsSchema,
    run: async ({ shared, options, logger, withGuildConnection }): Promise<DbCommandResult> => {
      // One timestamp for the whole fleet, so export and drop take a single legacy_timestamp.
      const timestamp = options.legacy_timestamp ?? String(now());
      const ownerId = `${hostname()}:${String(process.pid)}:${randomUUID()}`;
      logger.info(
        { guildCount: shared.guilds.length, dryRun: options.dry_run, legacyTimestamp: timestamp },
        options.dry_run
          ? 'db archive-legacy-isolate: DRY RUN — reporting only, nothing is renamed or dropped.'
          : 'db archive-legacy-isolate: isolating the legacy archive in every configured guild.',
      );
      const outcomes = await runPerGuild<IsolateSuccess>(
        shared.guilds,
        (guildId) =>
          withGuildConnection(guildId, (connection) =>
            processGuild(connection, guildId, options, timestamp, ownerId, now),
          ),
        logger,
        'db archive-legacy-isolate',
      );
      const guilds = outcomes.map(toFlatOutcome);
      const failed = guilds.filter(
        (g) => g.status !== 'isolated' && g.status !== 'would-isolate',
      ).length;
      return {
        report: { dryRun: options.dry_run, legacyTimestamp: timestamp, guilds },
        summaryLine:
          failed === 0
            ? `PASS (legacy_timestamp ${timestamp})`
            : `FAIL (${String(failed)} guild(s) refused, partial, or errored; legacy_timestamp ${timestamp})`,
        exitCode: failed === 0 ? 0 : 1,
      };
    },
  });

export const isolateCommand = createIsolateCommand();
