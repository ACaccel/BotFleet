/**
 * The "get avatar" user menu: a server profile avatar wins over the
 * global one, as Discord shows it in that server, and both links are
 * listed. A target who is not a member falls back to the global profile.
 */
import { describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';

import MenuGetAvatar from '../../../../src/handlers/commands/menu_get_avatar';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import {
  buildUserContextMenuInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const GLOBAL = 'https://cdn.example/global.png';
const SERVER = 'https://cdn.example/server.png';

const open = async (input: Omit<Parameters<typeof buildUserContextMenuInteraction>[0], 'sink'>) => {
  const { bot } = buildFakeBot({ translator: echoTranslatorWithParams() });
  const sink = newInteractionSink();
  await new MenuGetAvatar().execute(buildUserContextMenuInteraction({ ...input, sink }), bot);
  const embeds = (sink.editReplies[0]?.embeds ?? []) as EmbedBuilder[];
  return { sink, embed: embeds[0]?.toJSON() };
};

const targetUser = { id: 't-1', displayName: 'Global Name', avatarUrl: GLOBAL };

describe('menu_get_avatar', () => {
  it('shows the server avatar at full size and lists both links', async () => {
    const { sink, embed } = await open({
      targetUser,
      targetMember: { displayName: 'Server Name', avatarUrl: SERVER },
    });

    // The reply is public: the menu is for showing an avatar to the channel.
    expect(sink.defers).toEqual([{}]);
    expect(embed).toMatchObject({
      title: 'replies:menu_get_avatar.title:{"user":"Server Name"}',
      image: { url: `${SERVER}?size=4096` },
      fields: [
        { name: 'replies:menu_get_avatar.server_avatar_field', value: `${SERVER}?size=4096` },
        { name: 'replies:menu_get_avatar.avatar_url_field', value: `${GLOBAL}?size=4096` },
      ],
    });
  });

  it('shows the global avatar for a member without a server avatar', async () => {
    const { embed } = await open({ targetUser, targetMember: { displayName: 'Server Name' } });

    expect(embed).toMatchObject({
      title: 'replies:menu_get_avatar.title:{"user":"Server Name"}',
      image: { url: `${GLOBAL}?size=4096` },
      fields: [{ name: 'replies:menu_get_avatar.avatar_url_field', value: `${GLOBAL}?size=4096` }],
    });
  });

  it.each([
    ['a target who is not a member', { targetMember: null }],
    ['a menu opened outside a guild', { guildId: null }],
  ])('falls back to the global profile for %s', async (_case, input) => {
    const { embed } = await open({ targetUser, ...input });

    expect(embed?.title).toBe('replies:menu_get_avatar.title:{"user":"Global Name"}');
    expect(embed?.image).toEqual({ url: `${GLOBAL}?size=4096` });
    expect(embed?.fields).toHaveLength(1);
  });
});
