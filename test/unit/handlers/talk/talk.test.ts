/**
 * `/talk` speaks as the bot without a signature, so it is limited to bot
 * admins; both talk commands may ping members and roles but never
 * `@everyone` or `@here`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import Talk from '../../../../src/handlers/commands/talk';
import TalkSigned from '../../../../src/handlers/commands/talk_signed';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const CHANNEL_ID = 'c-target';

const build = (options: Record<string, string>, isAdmin: boolean) => {
  const send = vi.fn(async (_options: unknown) => undefined);
  const channel = { id: CHANNEL_ID, isSendable: () => true, send };
  const reply = vi.fn(async (_options: unknown) => undefined);
  const interaction = {
    deferReply: vi.fn(async () => undefined),
    deleteReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply,
    deferred: false,
    replied: false,
    guild: { id: 'g1', channels: { cache: new Map([[CHANNEL_ID, channel]]) } },
    channel,
    member: { displayName: 'Speaker' },
    user: { id: 'u1', username: 'speaker' },
    options: {
      get: (name: string) => (name in options ? { value: options[name] } : null),
    },
  } as unknown as ChatInputCommandInteraction;
  const { bot } = buildFakeBot({ isAdmin: () => isAdmin });
  return { interaction, bot, send, reply };
};

describe('/talk', () => {
  it('refuses a member who is not a bot admin', async () => {
    const { interaction, bot, send, reply } = build({ channel: CHANNEL_ID, content: 'hi' }, false);

    await new Talk().execute(interaction, bot);

    expect(send).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'errors:permission.admin_only_short' }),
    );
  });

  it('lets an admin ping members and roles but not everyone', async () => {
    const { interaction, bot, send } = build({ channel: CHANNEL_ID, content: '<@1> hi' }, true);

    await new Talk().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: '<@1> hi',
      allowedMentions: { parse: ['users', 'roles'] },
    });
  });

  it('replaces an @everyone message with a warning that pings nobody', async () => {
    const { interaction, bot, send } = build(
      { channel: CHANNEL_ID, content: '@everyone hi' },
      true,
    );

    await new Talk().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: 'replies:talk.tag_warning',
      allowedMentions: { parse: [] },
    });
  });
});

describe('/talk_signed', () => {
  it('signs the message and allows member and role pings', async () => {
    const { interaction, bot, send } = build({ content: '<@&2> hi' }, false);

    await new TalkSigned().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: 'Speaker(speaker): <@&2> hi',
      allowedMentions: { parse: ['users', 'roles'] },
    });
  });

  it('replaces an @here message with a warning that pings nobody', async () => {
    const { interaction, bot, send } = build({ content: '@here hi' }, false);

    await new TalkSigned().execute(interaction, bot);

    expect(send).toHaveBeenCalledWith({
      content: 'replies:talk_signed.tag_warning',
      allowedMentions: { parse: [] },
    });
  });
});
