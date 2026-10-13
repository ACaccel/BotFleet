/**
 * `/change_avatar` changes the account-wide, rate-limited avatar first, so
 * a refusal leaves the nickname and colour role untouched; persona images
 * come from local files rather than an external host.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, type ChatInputCommandInteraction } from 'discord.js';

const { readPersonaAvatar, swapColorRole } = vi.hoisted(() => ({
  readPersonaAvatar: vi.fn(),
  swapColorRole: vi.fn(),
}));
vi.mock('../../../../src/handlers/commands/change_avatar/persona', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPersonaAvatar,
  swapColorRole,
}));

import ChangeAvatar from '../../../../src/handlers/commands/change_avatar';
import { PERSONAS } from '../../../../src/handlers/commands/change_avatar/persona';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

const persona = PERSONAS[0] as (typeof PERSONAS)[number];

const build = (setAvatar: () => Promise<unknown>) => {
  const setNickname = vi.fn(async () => undefined);
  const me = { client: { user: { setAvatar: vi.fn(setAvatar) } }, setNickname };
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    deferReply: vi.fn(async () => undefined),
    editReply,
    deferred: true,
    replied: false,
    guildId: 'g1',
    guild: { id: 'g1', members: { me } },
    options: { get: () => ({ value: persona.name }) },
  } as unknown as ChatInputCommandInteraction;
  const { bot } = buildFakeBot({
    getGuildInfo: () => ({ bot_name: 'Old' }),
    updateBotName: vi.fn(),
  });
  return { interaction, bot, me, editReply, setNickname };
};

afterEach(() => vi.clearAllMocks());

describe('/change_avatar', () => {
  it('switches avatar, nickname and colour role, in that order', async () => {
    readPersonaAvatar.mockResolvedValue(Buffer.from('img'));
    const { interaction, bot, me, editReply, setNickname } = build(async () => undefined);

    await new ChangeAvatar().execute(interaction, bot);

    expect(me.client.user.setAvatar).toHaveBeenCalledWith(Buffer.from('img'));
    expect(setNickname).toHaveBeenCalledWith(persona.name);
    expect(swapColorRole).toHaveBeenCalledWith(me, persona);
    expect(editReply).toHaveBeenCalledWith({ content: 'replies:change_avatar.changed' });
  });

  it('changes nothing when the persona image is not installed', async () => {
    readPersonaAvatar.mockResolvedValue(null);
    const { interaction, bot, me, editReply } = build(async () => undefined);

    await new ChangeAvatar().execute(interaction, bot);

    expect(me.client.user.setAvatar).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'replies:change_avatar.avatar_missing' });
  });

  it('reports a rate limit and leaves the nickname alone', async () => {
    readPersonaAvatar.mockResolvedValue(Buffer.from('img'));
    const limited = new DiscordAPIError(
      { code: 50035, message: 'You are changing your avatar too fast' },
      50035,
      400,
      'PATCH',
      '/users/@me',
      {},
    );
    const { interaction, bot, editReply, setNickname } = build(async () => Promise.reject(limited));

    await new ChangeAvatar().execute(interaction, bot);

    expect(setNickname).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'replies:change_avatar.rate_limited' });
  });
});
