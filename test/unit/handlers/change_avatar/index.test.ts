/**
 * `/change_avatar` changes the account-wide, rate-limited avatar first, so
 * a refusal leaves the nickname and colour role untouched; persona images
 * come from local files rather than an external host.
 */
/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';

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
import { buildFakeBot, echoTranslatorWithParams } from '../../../fixtures/discord/bot-fake';
import { buildGuild } from '../../../fixtures/discord/guild-builder';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const persona = PERSONAS[0] as (typeof PERSONAS)[number];

const build = (setAvatar: () => Promise<unknown>) => {
  // Each account change appends here, so the order the handler makes
  // them in is asserted from state instead of from call timestamps.
  const changes: string[] = [];
  swapColorRole.mockImplementation(async () => {
    changes.push('colour role');
  });
  const setNickname = vi.fn(async (nickname: string) => {
    changes.push(`nickname:${nickname}`);
  });
  const setAvatarSpy = vi.fn(async (avatar: Buffer) => {
    await setAvatar();
    changes.push(`avatar:${avatar.toString()}`);
  });
  const me = { id: 'bot', client: { user: { setAvatar: setAvatarSpy } }, setNickname };
  const botNames = new Map([['g1', 'Old']]);
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    guild: buildGuild({ id: 'g1', me }),
    options: { identity: persona.name },
    sink,
  });
  const { bot, logger } = buildFakeBot({
    translator: echoTranslatorWithParams(),
    getGuildInfo: (guildId: string) => ({ bot_name: botNames.get(guildId) }),
    updateBotName: (guildId: string, name: string) => botNames.set(guildId, name),
  });
  return { interaction, bot, logger, me, sink, changes, botNames };
};

afterEach(() => vi.clearAllMocks());

describe('/change_avatar', () => {
  it('switches avatar, nickname and colour role, in that order', async () => {
    readPersonaAvatar.mockResolvedValue(Buffer.from('img'));
    const { interaction, bot, me, sink, changes, botNames } = build(async () => undefined);

    await new ChangeAvatar().execute(interaction, bot);

    expect(changes).toEqual(['avatar:img', `nickname:${persona.name}`, 'colour role']);
    expect(swapColorRole).toHaveBeenCalledWith(me, persona);
    expect(botNames.get('g1')).toBe(persona.name);
    expect(sink.defers).toEqual([{}]);
    expect(sink.editReplies).toEqual([
      {
        content: `replies:change_avatar.changed:${JSON.stringify({ oldName: 'Old', newName: persona.name })}`,
      },
    ]);
  });

  it('changes nothing when the persona image is not installed', async () => {
    readPersonaAvatar.mockResolvedValue(null);
    const { interaction, bot, sink, changes, botNames } = build(async () => undefined);

    await new ChangeAvatar().execute(interaction, bot);

    expect(changes).toEqual([]);
    expect(botNames.get('g1')).toBe('Old');
    expect(sink.editReplies).toEqual([{ content: 'replies:change_avatar.avatar_missing' }]);
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
    const { interaction, bot, logger, sink, changes, botNames } = build(async () =>
      Promise.reject(limited),
    );

    await new ChangeAvatar().execute(interaction, bot);

    expect(changes).toEqual([]);
    expect(botNames.get('g1')).toBe('Old');
    expect(logger.error).toHaveBeenCalled();
    expect(sink.editReplies).toEqual([{ content: 'replies:change_avatar.rate_limited' }]);
  });
});
