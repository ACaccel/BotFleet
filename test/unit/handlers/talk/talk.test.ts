/**
 * `/talk` posts signed by default; only bot admins may post anonymously,
 * and a member can only post where they could post themselves. Members
 * and roles may be pinged, `@everyone` and `@here` never.
 */
import { describe, expect, it, vi } from 'vitest';

import Talk from '../../../../src/handlers/commands/talk';
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildGuildMember } from '../../../fixtures/discord/member-builder';

const HERE = 'c-here';
const ELSEWHERE = 'c-elsewhere';

/** A channel whose posts are collected, so a test reads what was said where. */
const channel = (id: string, canPost: boolean) => {
  const sent: unknown[] = [];
  return {
    id,
    sent,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => canPost }),
    send: vi.fn(async (message: unknown) => {
      sent.push(message);
    }),
  };
};

interface Options {
  readonly content: string;
  readonly channel?: string;
  readonly anonymous?: boolean;
}

const build = (options: Options, { isAdmin = false, canPostElsewhere = true } = {}) => {
  const here = channel(HERE, true);
  const elsewhere = channel(ELSEWHERE, canPostElsewhere);
  const sink = newInteractionSink();
  const member = buildGuildMember({ id: 'u1', username: 'speaker', displayName: 'Speaker' });
  const guild = buildGuild({ id: 'g1' });
  Object.assign(guild.channels.cache, {
    get: (id: string) => (id === ELSEWHERE ? elsewhere : undefined),
  });
  const interaction = buildChatInputInteraction({
    userId: member.id,
    username: member.user.username,
    member,
    guild,
    channel: here,
    channels: options.channel === undefined ? {} : { channel: { id: options.channel } },
    options: {
      content: options.content,
      ...(options.anonymous === undefined ? {} : { anonymous: options.anonymous }),
    },
    sink,
  });
  const { bot, logger } = buildFakeBot({
    isAdmin: () => isAdmin,
    translator: echoTranslatorWithParams(),
  });
  return { interaction, bot, logger, here, elsewhere, sink };
};

describe('/talk', () => {
  it('signs the message in the current channel and allows member and role pings', async () => {
    const { interaction, bot, here, sink } = build({ content: '<@&2> hi' });

    await new Talk().execute(interaction, bot);

    expect(here.sent).toEqual([
      {
        content: 'Speaker(speaker): <@&2> hi',
        allowedMentions: { parse: ['users', 'roles'] },
      },
    ]);
    expect(sink.deletes).toEqual(['@original']);
    expect(sink.editReplies).toEqual([]);
  });

  it('refuses anonymous posting to a member who is not a bot admin', async () => {
    const { interaction, bot, here, sink } = build({
      content: 'hi',
      anonymous: true,
    });

    await new Talk().execute(interaction, bot);

    expect(here.sent).toEqual([]);
    expect(sink.editReplies).toEqual([{ content: 'errors:permission.admin_only_short' }]);
    expect(sink.deletes).toEqual([]);
  });

  it('lets an admin post anonymously and logs it', async () => {
    const { interaction, bot, logger, here } = build(
      { content: 'hi', anonymous: true },
      { isAdmin: true },
    );

    await new Talk().execute(interaction, bot);

    expect(here.sent).toEqual([{ content: 'hi', allowedMentions: { parse: ['users', 'roles'] } }]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi', userId: 'u1' }),
      expect.any(String),
    );
  });

  it('posts to another channel only where the member may post', async () => {
    const allowed = build({ content: 'hi', channel: ELSEWHERE });
    await new Talk().execute(allowed.interaction, allowed.bot);
    expect(allowed.elsewhere.sent).toEqual([
      { content: 'Speaker(speaker): hi', allowedMentions: { parse: ['users', 'roles'] } },
    ]);
    expect(allowed.here.sent).toEqual([]);

    const refused = build({ content: 'hi', channel: ELSEWHERE }, { canPostElsewhere: false });
    await new Talk().execute(refused.interaction, refused.bot);
    expect(refused.elsewhere.sent).toEqual([]);
    expect(refused.sink.editReplies).toEqual([{ content: 'replies:talk.channel_not_allowed' }]);
  });

  it('replaces an @everyone message with a warning that pings nobody', async () => {
    const { interaction, bot, here } = build({ content: '@everyone hi' });

    await new Talk().execute(interaction, bot);

    expect(here.sent).toEqual([
      {
        content: 'replies:talk.tag_warning:{"displayName":"Speaker","username":"speaker"}',
        allowedMentions: { parse: [] },
      },
    ]);
  });
});
