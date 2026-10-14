import type { BaseBot } from '@bot';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Activity from '../../../src/handlers/commands/activity';
import ActivityCreate from '../../../src/handlers/commands/activity_create/action';
import ActivityList from '../../../src/handlers/commands/activity_list/action';
import ActivityCancel from '../../../src/handlers/commands/activity_cancel/action';
import AddReply from '../../../src/handlers/commands/add_reply/action';
import DeleteReply from '../../../src/handlers/commands/delete_reply/action';
import Feed from '../../../src/handlers/commands/feed';
import FeedList from '../../../src/handlers/commands/feed_list/action';
import FeedSubscribe from '../../../src/handlers/commands/feed_subscribe/action';
import FeedUnsubscribe from '../../../src/handlers/commands/feed_unsubscribe/action';
import Giveaway from '../../../src/handlers/commands/giveaway';
import GiveawayCreate from '../../../src/handlers/commands/giveaway_create/action';
import GiveawayDelete from '../../../src/handlers/commands/giveaway_delete/action';
import ListReply from '../../../src/handlers/commands/list_reply/action';
import Reply from '../../../src/handlers/commands/reply';

const families = [
  {
    name: 'feed',
    Root: Feed,
    actions: [
      { name: 'subscribe', Action: FeedSubscribe },
      { name: 'unsubscribe', Action: FeedUnsubscribe },
      { name: 'list', Action: FeedList },
    ],
  },
  {
    name: 'reply',
    Root: Reply,
    actions: [
      { name: 'add', Action: AddReply },
      { name: 'delete', Action: DeleteReply },
      { name: 'list', Action: ListReply },
    ],
  },
  {
    name: 'activity',
    Root: Activity,
    actions: [
      { name: 'create', Action: ActivityCreate },
      { name: 'list', Action: ActivityList },
      { name: 'cancel', Action: ActivityCancel },
    ],
  },
  {
    name: 'giveaway',
    Root: Giveaway,
    actions: [
      { name: 'create', Action: GiveawayCreate },
      { name: 'delete', Action: GiveawayDelete },
    ],
  },
];

const bot = {} as BaseBot;
const interactionFor = (name: string): ChatInputCommandInteraction =>
  ({
    options: {
      getSubcommand: vi.fn().mockReturnValue(name),
      getSubcommandGroup: vi.fn().mockReturnValue(null),
    },
  }) as unknown as ChatInputCommandInteraction;

afterEach(() => vi.restoreAllMocks());

describe.each(families)('/$name subcommands', ({ name, Root, actions }) => {
  it('registers every action with its existing option requirements and public access', () => {
    const root = new Root();
    expect(root.config.name).toBe(name);
    expect(root.config.defaultMemberPermissions).toBeUndefined();
    expect(root.config.options).toBeUndefined();
    expect(root.config.subcommands).toEqual(
      actions.map(({ name: actionName, Action }) => ({
        name: actionName,
        ...(new Action().config.options ? { options: new Action().config.options } : {}),
      })),
    );
  });

  it.each(actions)('dispatches $name to only its existing action', async ({ name: actionName }) => {
    const spies = actions.map(({ Action }) =>
      vi.spyOn(Action.prototype, 'execute').mockResolvedValue(undefined),
    );
    const interaction = interactionFor(actionName);
    await new Root().execute(interaction, bot);
    actions.forEach((action, index) => {
      if (action.name === actionName) {
        expect(spies[index]).toHaveBeenCalledExactlyOnceWith(interaction, bot);
      } else {
        expect(spies[index]).not.toHaveBeenCalled();
      }
    });
  });
});

describe('/feed autocomplete', () => {
  it('keeps unsubscribe account suggestions attached to the nested option', async () => {
    const suggestions = [{ name: '@example', value: 'example' }];
    const suggest = vi
      .spyOn(FeedUnsubscribe.prototype, 'autocomplete')
      .mockResolvedValue(suggestions);
    const interaction = interactionFor('unsubscribe') as unknown as AutocompleteInteraction;
    const root = new Feed();

    expect(
      root.config.subcommands
        ?.find((command) => command.name === 'unsubscribe')
        ?.options?.string?.find((option) => option.name === 'account')?.autocomplete,
    ).toBe(true);
    await expect(root.autocomplete?.(interaction, bot)).resolves.toEqual(suggestions);
    expect(suggest).toHaveBeenCalledExactlyOnceWith(interaction, bot);
  });

  it.each(['subscribe', 'list'])('does not query unsubscribe suggestions for %s', async (name) => {
    const suggest = vi.spyOn(FeedUnsubscribe.prototype, 'autocomplete');
    const interaction = interactionFor(name) as unknown as AutocompleteInteraction;

    await expect(new Feed().autocomplete?.(interaction, bot)).resolves.toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });
});
