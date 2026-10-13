import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, UserContextMenuCommandInteraction } from 'discord.js';

import GetAvatar from '../../../src/handlers/commands/get_avatar';
import MenuGetAvatar from '../../../src/handlers/commands/menu_get_avatar';
import SearchAnimeScene from '../../../src/handlers/commands/search_anime_scene';
import { dashboardReply } from '../../../src/handlers/commands/traffic-shared/reply';
import { postJson } from '../../../src/infra/http';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

vi.mock('../../../src/infra/http', () => ({ postJson: vi.fn() }));

describe('embed presentation', () => {
  it.each(['#ED4245', '#000000'])(
    'uses the same information accent for both avatar entry points despite role color %s',
    async (displayHexColor) => {
      const avatarUrl = 'https://cdn.example.test/avatar.png';
      const { bot } = buildFakeBot();
      const editReply = vi.fn();
      const member = {
        displayHexColor,
        displayAvatarURL: () => avatarUrl,
        user: { tag: 'Alice' },
      };
      const slash = {
        deferReply: vi.fn(),
        editReply,
        options: { get: () => ({ value: 'alice' }) },
        guild: { members: { cache: new Map([['alice', member]]) } },
      } as unknown as ChatInputCommandInteraction;
      const menu = {
        deferReply: vi.fn(),
        editReply,
        targetUser: { username: 'Alice', displayAvatarURL: () => avatarUrl },
      } as unknown as UserContextMenuCommandInteraction;

      await new GetAvatar().execute(slash, bot);
      await new MenuGetAvatar().execute(menu, bot);

      expect(editReply).toHaveBeenCalledTimes(2);
      for (const [reply] of editReply.mock.calls) {
        expect(reply.embeds[0].toJSON()).toMatchObject({
          color: 0x5865f2,
          image: { url: avatarUrl },
        });
      }
    },
  );

  it('adds the information accent to anime matches without changing their media', async () => {
    const { bot } = buildFakeBot();
    const editReply = vi.fn();
    vi.mocked(postJson).mockResolvedValueOnce({
      error: '',
      result: [
        {
          filename: 'Episode 1',
          similarity: 0.99,
          from: 60,
          to: 65,
          video: 'https://example.test/scene.mp4',
          image: 'https://example.test/scene.jpg',
        },
      ],
    });
    const interaction = {
      deferReply: vi.fn(),
      editReply,
      options: {
        get: (name: string) =>
          name === 'image' ? { attachment: { url: 'https://example.test/input.jpg' } } : null,
      },
    } as unknown as ChatInputCommandInteraction;

    await new SearchAnimeScene().execute(interaction, bot);

    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply.mock.calls[0]?.[0].embeds[0].toJSON()).toMatchObject({
      color: 0x5865f2,
      title: 'Episode 1',
      url: 'https://example.test/scene.mp4',
      image: { url: 'https://example.test/scene.jpg' },
    });
  });

  it('uses the same information accent on both traffic dashboard pages', () => {
    const reply = dashboardReply({
      title: 'Server activity',
      image: Buffer.from('overview'),
      details: Buffer.from('details'),
    });
    expect(reply.kind).toBe('reply');
    if (reply.kind !== 'reply') throw new Error('Expected dashboard reply');
    expect(reply.embeds.map((embed) => embed.toJSON().color)).toEqual([0x5865f2, 0x5865f2]);
    expect(reply.embeds.map((embed) => embed.toJSON().image?.url)).toEqual([
      'attachment://traffic-dashboard.png',
      'attachment://traffic-details.png',
    ]);
  });
});
