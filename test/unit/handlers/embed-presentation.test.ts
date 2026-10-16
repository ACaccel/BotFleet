import { describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';

import MenuGetAvatar from '../../../src/handlers/commands/menu_get_avatar';
import { dashboardReply } from '../../../src/handlers/commands/traffic-shared/reply';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import {
  buildUserContextMenuInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

describe('embed presentation', () => {
  it('uses the information accent for the avatar context menu', async () => {
    const avatarUrl = 'https://cdn.example.test/avatar.png';
    const { bot } = buildFakeBot();
    const sink = newInteractionSink();
    const menu = buildUserContextMenuInteraction({
      targetUser: { id: 'u2', displayName: 'Alice', avatarUrl },
      sink,
    });

    await new MenuGetAvatar().execute(menu, bot);

    const embed = sink.editReplies[0]?.embeds?.[0] as EmbedBuilder;
    // The builder appends the requested size, so the largest one is asked for.
    expect(embed.toJSON()).toMatchObject({
      color: 0x5865f2,
      image: { url: `${avatarUrl}?size=4096` },
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
