/**
 * Shared builders for the `/db` handler suites: a fake `DbInspectService`,
 * a `client` for interactions, plain-data panel inputs and embed readers.
 */
import { DiscordAPIError, type Client, type EmbedBuilder } from 'discord.js';
import { vi, type Mock } from 'vitest';

import type {
  CollectionDescription,
  DbInspectService,
  DocumentView,
  QueryPage,
} from '../../../../src/application/db-inspect/service';
import { echoTranslator } from '../../../fixtures/runtime';
import type { Translator } from '../../../../src/core/i18n';
import type { InspectField } from '../../../../src/persistence/inspect/catalog';

export const ADMIN_ID = 'admin-1';
export const GUILD_ID = '100000000000000001';

const SERVICE_METHODS = [
  'stats',
  'describe',
  'query',
  'get',
  'page',
  'documentAt',
  'assertSession',
  'suggestGuilds',
  'suggestCollections',
  'suggestFields',
  'suggestOperators',
  'suggestValues',
  'suggestSorts',
  'suggestIds',
] as const;

type ServiceMethod = (typeof SERVICE_METHODS)[number];

export interface FakeService {
  readonly service: DbInspectService;
  readonly mocks: Readonly<Record<ServiceMethod, Mock>>;
}

/** A `DbInspectService` whose every method is a bare spy returning `undefined`. */
export const fakeService = (): FakeService => {
  const mocks = Object.fromEntries(SERVICE_METHODS.map((name) => [name, vi.fn()])) as Record<
    ServiceMethod,
    Mock
  >;
  return { service: mocks as unknown as DbInspectService, mocks };
};

/**
 * Translator whose output always differs from the key, as a real catalog
 * does, so a DomainError's own message is told apart from the fallback.
 */
export const markedTranslator = (): Translator => ({
  ...echoTranslator(),
  t: (key, params) => (params === undefined ? `[${key}]` : `[${key}]${JSON.stringify(params)}`),
});

/** The part of a `Client` the handlers read: the guild cache, as ID to name. */
export const fakeClient = (guilds: Readonly<Record<string, string>> = {}): Client =>
  ({
    guilds: { cache: new Map(Object.entries(guilds).map(([id, name]) => [id, { name }])) },
  }) as unknown as Client;

/**
 * Give `interaction` the `client` the handlers read guild names from;
 * the shared builders leave it out.
 */
export const withClient = <T extends object>(
  interaction: T,
  guilds: Readonly<Record<string, string>> = {},
): T => Object.defineProperty(interaction, 'client', { value: fakeClient(guilds) });

/** An embed as the JSON Discord would receive. */
export const embedJson = (embed: unknown) => (embed as EmbedBuilder).toJSON();

/** A component row as the JSON Discord would receive. */
export const rowJson = (row: unknown) =>
  (row as { toJSON(): unknown }).toJSON() as {
    type: number;
    components: Array<{
      custom_id: string;
      disabled?: boolean;
      label?: string;
      placeholder?: string;
      options?: Array<{ label: string; value: string; description?: string }>;
    }>;
  };

export const expiredInteractionError = (): DiscordAPIError =>
  new DiscordAPIError(
    { code: 10062, message: 'Unknown interaction' },
    10062,
    404,
    'POST',
    'https://discord.test/interactions',
    {},
  );

export const rejectedReplyError = (): DiscordAPIError =>
  new DiscordAPIError(
    { code: 50035, message: 'Invalid form body' },
    50035,
    400,
    'POST',
    'https://discord.test/interactions',
    {},
  );

export const field = (path: string, overrides: Partial<InspectField> = {}): InspectField => ({
  path,
  type: 'string',
  indexed: false,
  ...overrides,
});

export const queryPage = (overrides: Partial<QueryPage> = {}): QueryPage => ({
  token: 'tok1',
  database: GUILD_ID,
  collection: 'bugtickets',
  page: 0,
  pageCount: 1,
  total: { count: 2, capped: false },
  sort: { field: '_id', direction: -1 },
  unindexedFilter: false,
  documents: [
    { _id: 'aaa', title: 'First bug', status: 'open' },
    { _id: 'bbb', title: 'Second bug', status: 'closed' },
  ],
  fields: [field('title'), field('status', { enumValues: ['open', 'closed'] })],
  summaryFields: ['title', 'status'],
  names: new Map(),
  ...overrides,
});

export const documentView = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  database: GUILD_ID,
  collection: 'bugtickets',
  document: { _id: 'aaa', title: 'First bug' },
  fields: [field('title')],
  names: new Map(),
  ...overrides,
});

export const description = (
  overrides: Partial<CollectionDescription> = {},
): CollectionDescription => ({
  database: GUILD_ID,
  name: 'bugtickets',
  registered: true,
  inferred: false,
  fields: [field('title'), field('number', { type: 'number', indexed: true })],
  indexes: [{ name: 'number_1', keys: ['number'] }],
  estimatedCount: 1234,
  sample: { _id: 'aaa', title: 'First bug' },
  ...overrides,
});
