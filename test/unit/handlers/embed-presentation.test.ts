import { describe, expect, it, vi } from 'vitest';
import type { UserContextMenuCommandInteraction } from 'discord.js';

import MenuGetAvatar from '../../../src/handlers/commands/menu_get_avatar';
import { dashboardReply } from '../../../src/handlers/commands/traffic-shared/reply';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';

describe('embed presentation', () => {
  it('uses the information accent for the avatar context menu', async () => {
    const avatarUrl = 'https://cdn.example.test/avatar.png';
    const { bot } = buildFakeBot();
    const editReply = vi.fn();
    const menu = {
      deferReply: vi.fn(),
      editReply,
      targetUser: { username: 'Alice', displayAvatarURL: () => avatarUrl },
    } as unknown as UserContextMenuCommandInteraction;

    await new MenuGetAvatar().execute(menu, bot);

    expect(editReply.mock.calls[0]?.[0].embeds[0].toJSON()).toMatchObject({
      color: 0x5865f2,
      image: { url: avatarUrl },
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
