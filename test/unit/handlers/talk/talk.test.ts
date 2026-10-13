/**
 * `/talk` posts signed by default; only bot admins may post anonymously,
 * and a member can only post where they could post themselves. Members
 * and roles may be pinged, `@everyone` and `@here` never.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import Talk from '../../../../src/handlers/commands/talk';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const HERE = 'c-here';
const ELSEWHERE = 'c-elsewhere';

const channel = (id: string, canPost: boolean) => ({
  id,
  isSendable: () => true,
  isThread: () => false,
  permissionsFor: () => ({ has: () => canPost }),
  send: vi.fn(async (_options: unknown) => undefined),
});

interface Options {
  readonly content: string;
  readonly channel?: string;
  readonly anonymous?: boolean;
}

const build = (options: Options, { isAdmin = false, canPostElsewhere = true } = {}) => {
  const here = channel(HERE, true);
  const elsewhere = channel(ELSEWHERE, canPostElsewhere);
  const editReply = vi.fn(async (_options: unknown) => undefined);
  const interaction = {
    deferReply: vi.fn(async () => undefined),
    deleteReply: vi.fn(async () => undefined),
    editReply,
    deferred: true,
    replied: false,
    guildId: 'g1',
    guild: { id: 'g1', channels: { cache: new Map([[ELSEWHERE, elsewhere]]) } },
    channel: here,
    member: { displayName: 'Speaker' },
    user: { id: 'u1', username: 'speaker', displayName: 'Speaker' },
    options: {
      get: (name: string) => (name === 'content' ? { value: options.content } : null),
      getBoolean: () => options.anonymous ?? null,
      getChannel: () => (options.channel ? { id: options.channel } : null),
    },
  } as unknown as ChatInputCommandInteraction;
  const { bot, logger } = buildFakeBot({ isAdmin: () => isAdmin });
  return { interaction, bot, logger, here, elsewhere, editReply };
};

describe('/talk', () => {
  it('signs the message in the current channel and allows member and role pings', async () => {
    const { interaction, bot, here } = build({ content: '<@&2> hi' });

    await new Talk().execute(interaction, bot);

    expect(here.send).toHaveBeenCalledWith({
      content: 'Speaker(speaker): <@&2> hi',
      allowedMentions: { parse: ['users', 'roles'] },
    });
  });

  it('refuses anonymous posting to a member who is not a bot admin', async () => {
    const { interaction, bot, here, editReply } = build({ content: 'hi', anonymous: true });

    await new Talk().execute(interaction, bot);

    expect(here.send).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'errors:permission.admin_only_short' });
  });

  it('lets an admin post anonymously and logs it', async () => {
    const { interaction, bot, logger, here } = build(
      { content: 'hi', anonymous: true },
      { isAdmin: true },
    );

    await new Talk().execute(interaction, bot);

    expect(here.send).toHaveBeenCalledWith({
      content: 'hi',
      allowedMentions: { parse: ['users', 'roles'] },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi', userId: 'u1' }),
      expect.any(String),
    );
  });

  it('posts to another channel only where the member may post', async () => {
    const allowed = build({ content: 'hi', channel: ELSEWHERE });
    await new Talk().execute(allowed.interaction, allowed.bot);
    expect(allowed.elsewhere.send).toHaveBeenCalled();

    const refused = build({ content: 'hi', channel: ELSEWHERE }, { canPostElsewhere: false });
    await new Talk().execute(refused.interaction, refused.bot);
    expect(refused.elsewhere.send).not.toHaveBeenCalled();
    expect(refused.editReply).toHaveBeenCalledWith({
      content: 'replies:talk.channel_not_allowed',
    });
  });

  it('replaces an @everyone message with a warning that pings nobody', async () => {
    const { interaction, bot, here } = build({ content: '@everyone hi' });

    await new Talk().execute(interaction, bot);

    expect(here.send).toHaveBeenCalledWith({
      content: 'replies:talk.tag_warning',
      allowedMentions: { parse: [] },
    });
  });
});
