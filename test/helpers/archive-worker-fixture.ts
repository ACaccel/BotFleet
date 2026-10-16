/**
 * Shared harness for the msg-archive worker integration suites: the channel
 * inventory, the Discord client stub and an `ArchiveWorker` over a test database.
 *
 * Each suite keeps its own REST behaviour (what `rest.get` answers) and its own
 * `vi.mock` of `collect-channels` and `storage-usage`; `vi.mock` is hoisted per test
 * file, so it cannot move here. The helpers below drive the mocked
 * `collectChannels` the suite registered.
 */
import { ChannelType, type Client, type Guild } from 'discord.js';
import { onTestFinished, vi, type Mock } from 'vitest';

import { ArchivePolicySchema } from '../../src/core/archive/policy';
import type { Translator } from '../../src/core/i18n';
import type { Logger } from '../../src/core/logger';
import type { ConnectionManager } from '../../src/infra/mongo/connection-manager';
import { MongoArchiveInboxRepo } from '../../src/persistence/repositories/archive-inbox.repo';
import {
  buildArchiveRepos,
  buildArchiveWriterRepos,
  type ArchiveWriterReposFactory,
} from '../../src/persistence/repositories/archive-repos';
import { archiveRuntimeSchema } from '../../src/plugins/message-backup/config';
import { collectChannels } from '../../src/plugins/message-backup/internal/collect-channels';
import { archiveBackupNotifiers } from '../../src/plugins/message-backup/runtime/backup-notifier';
import { ArchiveWorker } from '../../src/plugins/message-backup/runtime/worker';
import type { ArchiveWorkerOptions } from '../../src/plugins/message-backup/runtime/worker-context';
import { echoTranslator, silentLogger } from '../fixtures/runtime';

/**
 * Writer repositories whose inbox does not cache empty claims. Suites edit inbox
 * documents directly, behind the repository's back, and expect the next drain to
 * see the edit; the cache itself is covered in `archive-repo.int.test.ts`.
 */
const uncachedInboxWriterRepos: ArchiveWriterReposFactory = (guild) => ({
  ...buildArchiveWriterRepos(guild),
  inbox: new MongoArchiveInboxRepo(guild, 'msg-archive', { emptyClaimCacheMs: 0 }),
});

/** A raw `messages` document, keyed by the Discord message ID. */
export type StoredMessage = { _id: string } & Record<string, any>;

/** The archived guild every suite uses. */
const ARCHIVE_GUILD_ID = '1';

interface InventoryChannel {
  readonly id: string;
  readonly name: string;
}

/** The one readable text channel most tests archive. */
const ARCHIVE_ROOM: InventoryChannel = { id: '10', name: 'room' };

interface InventoryOptions {
  /** Channels the bot can read (default: the room). */
  readonly readable?: readonly InventoryChannel[];
  /** Channels that exist but the bot cannot read. */
  readonly hidden?: readonly InventoryChannel[];
  readonly gaps?: readonly { pass: string; channelId?: string; reason: string }[];
  /** Whether discovery finished (default: no gaps). */
  readonly complete?: boolean;
  /** Whether discovery reports where it saw each channel (default: yes). */
  readonly located?: boolean;
}

/** Answers the suite's mocked `collectChannels` with the given guild inventory. */
export const stubArchiveInventory = (options: InventoryOptions = {}): void => {
  const readable = options.readable ?? [ARCHIVE_ROOM];
  const hidden = options.hidden ?? [];
  const gaps = options.gaps ?? [];
  const all = [...readable, ...hidden];
  vi.mocked(collectChannels).mockResolvedValue({
    channels: readable.map((channel) => ({
      ...channel,
      type: ChannelType.GuildText,
      parentId: null,
    })),
    liveChannelIds: new Set(all.map((channel) => channel.id)),
    gaps,
    complete: options.complete ?? gaps.length === 0,
    locations:
      options.located === false
        ? []
        : all.map((channel) => ({ ...channel, type: ChannelType.GuildText, passes: ['channels'] })),
  } as unknown as Awaited<ReturnType<typeof collectChannels>>);
};

type RestRead = (
  route: string,
  options?: { query?: URLSearchParams; signal?: AbortSignal },
) => Promise<unknown>;

/** The Discord REST calls the worker makes; each is a spy the test can re-program. */
interface ArchiveRestStub {
  readonly get: Mock<RestRead>;
  readonly patch?: Mock;
  readonly delete?: Mock;
}

interface ArchiveWorkerFixtureOptions {
  readonly connections: ConnectionManager;
  /** Answers `client.rest.get`. */
  readonly get: RestRead;
  readonly patch?: Mock;
  readonly delete?: Mock;
  /** The channel the registry hands out for panels and debug notices (default: none). */
  readonly channel?: unknown;
  /** Default: `echoTranslator`. */
  readonly translator?: Translator;
  /** Raw `archive` runtime config, parsed like the plugin does. */
  readonly config?: Record<string, unknown>;
  /** Worker options the suite overrides. */
  readonly worker?: Partial<ArchiveWorkerOptions>;
}

export interface ArchiveWorkerFixture {
  readonly worker: ArchiveWorker;
  readonly client: Client;
  readonly rest: ArchiveRestStub;
  readonly logger: Logger;
}

/**
 * Builds an `ArchiveWorker` for guild 1 over `connections`, with a silent logger
 * and the real archive repositories. The inbox loop is off: tests drain the inbox
 * explicitly, and the loop has its own tests.
 */
export const buildArchiveWorker = (options: ArchiveWorkerFixtureOptions): ArchiveWorkerFixture => {
  const rest: ArchiveRestStub = {
    get: vi.fn(options.get),
    ...(options.patch === undefined ? {} : { patch: options.patch }),
    ...(options.delete === undefined ? {} : { delete: options.delete }),
  };
  const client = {
    channels: { cache: new Map() },
    guilds: {
      fetch: async () =>
        ({ id: ARCHIVE_GUILD_ID, channels: { cache: new Map() } }) as unknown as Guild,
    },
    rest,
  } as unknown as Client;
  const logger = silentLogger();
  const translator = options.translator ?? echoTranslator();
  const worker = new ArchiveWorker({
    client,
    connections: options.connections,
    registry: {
      getRepos: () => undefined,
      getChannel: () => options.channel as never,
      getRole: () => undefined,
      listGuildIds: () => [ARCHIVE_GUILD_ID],
    },
    config: archiveRuntimeSchema.parse(options.config ?? {}),
    policy: ArchivePolicySchema.parse({ guildIds: [ARCHIVE_GUILD_ID] }),
    guildIds: [ARCHIVE_GUILD_ID],
    logger,
    translator,
    backupNotifiers: archiveBackupNotifiers(client, translator),
    archiveRepos: buildArchiveRepos,
    writerRepos: uncachedInboxWriterRepos,
    inboxLoop: false,
    ...options.worker,
  });
  return { worker, client, rest, logger };
};

/**
 * Translator that appends the interpolation values to the key, so a test can tell
 * which values a rendered panel or notice carried.
 */
export const keyWithParamsTranslator = (): Translator => ({
  ...echoTranslator(),
  t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
});

/**
 * Stops `Date.now()` at its current reading for the rest of the test and returns
 * that reading, so time-derived fields can be asserted exactly. Timers and Mongo
 * I/O stay real, unlike fake timers; `new Date()` without arguments keeps reading
 * the real clock.
 */
export const freezeWallClock = (): number => {
  const frozenAt = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(frozenAt);
  onTestFinished(() => spy.mockRestore());
  return frozenAt;
};
