/**
 * Unit tests for {@link BaseBotGuildOnboardingPort}.
 *
 * The port is the typed seam through which the `guild-events` plugin
 * onboards a newly joined guild. These tests drive it against a
 * minimal `BaseBot` test double and assert:
 *   - a `guildInfo` slot is created for the new guild;
 *   - the per-guild database connection is opened via `connectOneGuild`;
 *   - slash commands are registered against the new guild;
 *   - a failed database connection is surfaced to the caller;
 *   - a failed command registration does not abort onboarding.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BaseBot } from '../../../src/bot/index';
import { BaseBotGuildOnboardingPort } from '../../../src/bot/guild-onboarding';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

// Stub the `@cmd` barrel: the real one eagerly loads the generated
// handler registry (every command module), which in a unit test
// triggers a `Command` base-class circular-import hazard. The port
// only needs `getCommandJsonBody` to produce *some* array. `vi.mock`
// is hoisted above the import above, so the stub is in place before
// `guild-onboarding.ts` resolves `@cmd`.
vi.mock('@cmd', () => ({
  getCommandJsonBody: (): unknown[] => [],
}));

const GUILD_ID = '123456789012345678';

/** Build a minimal `BaseBot` test double exposing only what the port reads. */
const makeBot = (
  overrides: {
    mongoURI?: string;
    connectOneGuild?: (guildId: string) => Promise<void>;
    commandsSet?: (...args: unknown[]) => Promise<unknown>;
    applicationPresent?: boolean;
  } = {},
): { bot: BaseBot; commandsSet: ReturnType<typeof vi.fn> } => {
  const commandsSet =
    overrides.commandsSet !== undefined ? vi.fn(overrides.commandsSet) : vi.fn(async () => []);
  const guildInfo = new Map<string, { bot_name: string; repos?: unknown }>();
  const guild = {
    id: GUILD_ID,
    name: 'Test Guild',
    members: { cache: new Map([['bot-client', { displayName: 'Bot' }]]) },
  };
  const application =
    overrides.applicationPresent === false ? null : { commands: { set: commandsSet } };
  const connectOneGuild =
    overrides.connectOneGuild ??
    (async (id: string): Promise<void> => {
      // Default: simulate a successful connect by populating `repos`.
      const existing = guildInfo.get(id);
      if (existing !== undefined) {
        guildInfo.set(id, { ...existing, repos: {} });
      }
    });
  const { bot } = buildFakeBot({
    clientId: 'bot-client',
    commandHandlers: new Map(),
    client: {
      guilds: { cache: new Map([[GUILD_ID, guild]]) },
      application,
    },
    getMongoURI: () => overrides.mongoURI ?? 'mongodb://localhost:27017',
    connectOneGuild,
    registerGuildSlotInternal: (id: string, info: { bot_name: string }): void => {
      guildInfo.set(id, info);
    },
    getGuildInfo: (id: string) => guildInfo.get(id),
    getAllGuildInfo: () => guildInfo,
    getRepos: (id: string) => guildInfo.get(id)?.repos,
  });
  return { bot, commandsSet };
};

describe('BaseBotGuildOnboardingPort', () => {
  it('creates a guildInfo slot, connects the database and registers commands', async () => {
    const { bot, commandsSet } = makeBot();
    const port = new BaseBotGuildOnboardingPort(bot);

    const result = await port.onboardGuild(GUILD_ID);

    expect(result).toEqual({
      guildId: GUILD_ID,
      databaseConnected: true,
      commandsRegistered: true,
    });
    expect(bot.getGuildInfo(GUILD_ID)).toBeDefined();
    expect(bot.getGuildInfo(GUILD_ID)?.bot_name).toBe('Bot');
    expect(commandsSet).toHaveBeenCalledWith(expect.any(Array), GUILD_ID);
  });

  it('throws a TypeError when the guild is not in the client cache', async () => {
    const { bot } = makeBot();
    const port = new BaseBotGuildOnboardingPort(bot);

    await expect(port.onboardGuild('999999999999999999')).rejects.toBeInstanceOf(TypeError);
  });

  it('re-throws when the per-guild database connection fails', async () => {
    const { bot } = makeBot({
      connectOneGuild: async () => {
        throw new Error('mongo down');
      },
    });
    const port = new BaseBotGuildOnboardingPort(bot);

    await expect(port.onboardGuild(GUILD_ID)).rejects.toThrow('mongo down');
  });

  it('reports databaseConnected=false when the bot has no Mongo URI', async () => {
    const { bot, commandsSet } = makeBot({ mongoURI: '' });
    const port = new BaseBotGuildOnboardingPort(bot);

    const result = await port.onboardGuild(GUILD_ID);

    expect(result.databaseConnected).toBe(false);
    // Commands still register even without a database.
    expect(commandsSet).toHaveBeenCalled();
  });

  it('reports commandsRegistered=false when the Discord call rejects', async () => {
    const { bot } = makeBot({
      commandsSet: async () => {
        throw new Error('discord 503');
      },
    });
    const port = new BaseBotGuildOnboardingPort(bot);

    // The rejection is caught, so onboarding still resolves — but the
    // result must report what actually happened. The fire-and-forget
    // form this replaces always claimed success.
    const result = await port.onboardGuild(GUILD_ID);
    expect(result.commandsRegistered).toBe(false);
    expect(result.databaseConnected).toBe(true);
  });

  it('reports commandsRegistered=false when the client application is not ready', async () => {
    const { bot } = makeBot({ applicationPresent: false });
    const port = new BaseBotGuildOnboardingPort(bot);

    const result = await port.onboardGuild(GUILD_ID);
    expect(result.commandsRegistered).toBe(false);
  });
});
