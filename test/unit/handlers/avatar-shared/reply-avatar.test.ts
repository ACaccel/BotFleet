/**
 * Both avatar menus share one reply: a server profile avatar wins over
 * the global one, as Discord shows it in that server, and both links are
 * listed. The message menu shows the message author's avatar.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  EmbedBuilder,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';

import MenuAuthorAvatar from '../../../../src/handlers/commands/menu_author_avatar';
import MenuGetAvatar from '../../../../src/handlers/commands/menu_get_avatar';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';

const GLOBAL = 'https://cdn.example/global.png';
const SERVER = 'https://cdn.example/server.png';

interface Target {
  readonly member?: { readonly displayName: string; readonly avatar: string | null } | null;
  readonly inGuild?: boolean;
}

const user = {
  id: 'u-1',
  displayName: 'Global Name',
  displayAvatarURL: ({ size }: { size: number }) => `${GLOBAL}?size=${size}`,
};

const base = ({ member = null, inGuild = true }: Target) => {
  const editReply = vi.fn(async (_payload: { embeds: EmbedBuilder[] }) => undefined);
  const fetch = vi.fn(async () => {
    if (member === null) throw new Error('Unknown Member');
    return {
      ...member,
      displayAvatarURL: ({ size }: { size: number }) => `${SERVER}?size=${size}`,
    };
  });
  const interaction = {
    guildId: inGuild ? 'g-1' : null,
    guild: inGuild ? { members: { fetch } } : null,
    deferReply: vi.fn(async () => undefined),
    editReply,
  };
  return { interaction, editReply, fetch };
};

const embedOf = (editReply: ReturnType<typeof base>['editReply']) =>
  editReply.mock.calls[0]?.[0].embeds[0]?.toJSON();

const bot = () => buildFakeBot({ translator: echoTranslatorWithParams() }).bot;

describe('avatar menus', () => {
  it('shows the server avatar at full size and lists both links', async () => {
    const { interaction, editReply } = base({
      member: { displayName: 'Server Name', avatar: 'hash' },
    });

    await new MenuGetAvatar().execute(
      { ...interaction, targetUser: user } as unknown as UserContextMenuCommandInteraction,
      bot(),
    );

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(embedOf(editReply)).toMatchObject({
      title: 'replies:menu_get_avatar.title:{"user":"Server Name"}',
      image: { url: `${SERVER}?size=4096` },
      fields: [
        { name: 'replies:menu_get_avatar.server_avatar_field', value: `${SERVER}?size=4096` },
        { name: 'replies:menu_get_avatar.avatar_url_field', value: `${GLOBAL}?size=4096` },
      ],
    });
  });

  it.each([
    ['a member without a server avatar', { member: { displayName: 'Global Name', avatar: null } }],
    ['a target who is not a member', { member: null }],
    ['a menu opened outside a guild', { inGuild: false }],
  ] as const)('shows the global avatar for %s', async (_case, target) => {
    const { interaction, editReply } = base(target);

    await new MenuGetAvatar().execute(
      { ...interaction, targetUser: user } as unknown as UserContextMenuCommandInteraction,
      bot(),
    );

    expect(embedOf(editReply)).toMatchObject({
      title: 'replies:menu_get_avatar.title:{"user":"Global Name"}',
      image: { url: `${GLOBAL}?size=4096` },
      fields: [{ name: 'replies:menu_get_avatar.avatar_url_field', value: `${GLOBAL}?size=4096` }],
    });
  });

  it('shows the message author avatar from the message menu', async () => {
    const { interaction, editReply, fetch } = base({
      member: { displayName: 'Server Name', avatar: 'hash' },
    });

    await new MenuAuthorAvatar().execute(
      {
        ...interaction,
        targetMessage: { author: user },
      } as unknown as MessageContextMenuCommandInteraction,
      bot(),
    );

    expect(fetch).toHaveBeenCalledWith('u-1');
    expect(embedOf(editReply)).toMatchObject({
      title: 'replies:menu_get_avatar.title:{"user":"Server Name"}',
      image: { url: `${SERVER}?size=4096` },
    });
  });
});
