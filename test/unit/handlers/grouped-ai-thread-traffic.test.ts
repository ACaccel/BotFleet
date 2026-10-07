import type { ChatInputCommandInteraction } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ai from '../../../src/handlers/commands/ai';
import AiSettings from '../../../src/handlers/commands/ai_settings/action';
import AiStatus from '../../../src/handlers/commands/ai_status/action';
import AiWhitelistAdd from '../../../src/handlers/commands/ai_whitelist_add/action';
import AiWhitelistRemove from '../../../src/handlers/commands/ai_whitelist_remove/action';
import AiWhitelistList from '../../../src/handlers/commands/ai_whitelist_list/action';
import Thread from '../../../src/handlers/commands/thread';
import ThreadBan from '../../../src/handlers/commands/thread_ban/action';
import ThreadAllow from '../../../src/handlers/commands/thread_allow/action';
import ThreadList from '../../../src/handlers/commands/thread_list/action';
import ThreadClaim from '../../../src/handlers/commands/thread_claim/action';
import ThreadManager from '../../../src/handlers/commands/thread_manager/action';
import Traffic from '../../../src/handlers/commands/traffic';
import TrafficOverview from '../../../src/handlers/commands/traffic/action';
import TrafficMe from '../../../src/handlers/commands/traffic_me/action';
import TrafficUser from '../../../src/handlers/commands/traffic_user/action';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

const interactionFor = (name: string, group: string | null = null) =>
  ({
    user: { id: 'member' },
    options: {
      getSubcommand: () => name,
      getSubcommandGroup: () => group,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ChatInputCommandInteraction;

afterEach(() => vi.restoreAllMocks());

describe('AI, thread, and traffic command groups', () => {
  it.each([
    [Ai, 'settings', null, AiSettings],
    [Ai, 'status', null, AiStatus],
    [Ai, 'add', 'whitelist', AiWhitelistAdd],
    [Ai, 'remove', 'whitelist', AiWhitelistRemove],
    [Ai, 'list', 'whitelist', AiWhitelistList],
    [Thread, 'ban', null, ThreadBan],
    [Thread, 'allow', null, ThreadAllow],
    [Thread, 'list', null, ThreadList],
    [Thread, 'claim', null, ThreadClaim],
    [Thread, 'add', 'manager', ThreadManager],
    [Thread, 'remove', 'manager', ThreadManager],
    [Thread, 'list', 'manager', ThreadManager],
    [Traffic, 'overview', null, TrafficOverview],
    [Traffic, 'me', null, TrafficMe],
    [Traffic, 'user', null, TrafficUser],
  ] as const)('routes %p %s in group %s to its action', async (Root, name, group, Action) => {
    const execute = vi.spyOn(Action.prototype, 'execute').mockResolvedValue(undefined);
    const interaction = interactionFor(name, group);
    const { bot } = buildFakeBot();
    await new Root().execute(interaction, bot);
    expect(execute).toHaveBeenCalledExactlyOnceWith(interaction, bot);
  });

  it.each(['add', 'remove'])('retains admin authorization for AI whitelist %s', async (name) => {
    const interaction = interactionFor(name, 'whitelist');
    const getRepos = vi.fn();
    const { bot } = buildFakeBot({ isAdmin: () => false, getRepos });
    await new Ai().execute(interaction, bot);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'errors:permission.admin_only_short',
    });
    expect(getRepos).not.toHaveBeenCalled();
  });

  it('preserves manager options under the nested group without restricting the entire root', () => {
    const root = new Thread();
    const manager = root.config.subcommandGroups?.find((group) => group.name === 'manager');
    expect(root.config.guildOnly).toBe(true);
    expect(root.config.defaultMemberPermissions).toBeUndefined();
    expect(manager?.subcommands).toEqual(new ThreadManager().config.subcommands);
    expect(new Ai().config.defaultMemberPermissions).toBeUndefined();
  });
});
