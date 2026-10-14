import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  type ActionRowBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type StringSelectMenuBuilder,
} from 'discord.js';

import type { BaseBot } from '../../../../src/bot';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { Command } from '../../../../src/handlers/commands/command';
import Help from '../../../../src/handlers/commands/help';
import Thread from '../../../../src/handlers/commands/thread';

interface ReplyPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<StringSelectMenuBuilder>[];
}

let translator: Translator;

beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: 'src/i18n/locales',
    fallbackLocale: 'en',
  });
});

const fixture = (requested?: string, isAdmin = false) => {
  const handler = new Help();
  const commandHandlers = new Map<string, Command>([
    ['help', handler],
    ['thread', new Thread()],
  ]);
  const admin = vi.fn(() => isAdmin);
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async (_payload: ReplyPayload) => undefined);
  const get = vi.fn(() => (requested === undefined ? null : { value: requested }));
  const interaction = {
    user: { id: 'member-1' },
    guildId: null,
    deferred: true,
    replied: false,
    client: {
      user: {
        username: 'Test Bot',
        displayAvatarURL: () => 'https://example.com/avatar.png',
      },
    },
    options: { get },
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  const bot = {
    commandHandlers,
    translator,
    helpMessage: 'Personality introduction',
    isAdmin: admin,
    logger: undefined,
  } as unknown as BaseBot;
  return { handler, bot, interaction, commandHandlers, admin, deferReply, editReply, get };
};

describe('/help execute', () => {
  it('privately sends the overview and category menu in a DM', async () => {
    const { handler, bot, interaction, admin, deferReply, editReply } = fixture();

    await handler.execute(interaction, bot);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(admin).toHaveBeenCalledWith('member-1');
    expect(editReply).toHaveBeenCalledTimes(1);
    const reply = editReply.mock.calls[0]?.[0];
    const embed = reply?.embeds?.[0]?.toJSON();
    expect(embed?.author).toMatchObject({
      name: 'Test Bot · Command Help',
      icon_url: 'https://example.com/avatar.png',
    });
    expect(embed?.description).toContain('Personality introduction');
    expect(embed?.fields?.map((field) => field.value).join('\n')).toContain('`/thread`');
    const menu = reply?.components?.[0]?.toJSON().components[0];
    expect(menu).toMatchObject({ custom_id: 'help_category' });
    expect(menu?.options.map((option) => option.value)).toEqual([
      'overview',
      'community',
      'utility',
    ]);
  });

  it.each([false, true])(
    'filters privileged detail paths with admin status %s',
    async (isAdmin) => {
      const { handler, bot, interaction, deferReply, editReply } = fixture('/thread', isAdmin);

      await handler.execute(interaction, bot);

      expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      const reply = editReply.mock.calls[0]?.[0];
      const embed = reply?.embeds?.[0]?.toJSON();
      expect(embed?.title).toBe('/thread');
      expect(embed?.fields?.find((field) => field.name === '/thread ban')?.value).toContain(
        '`users` (required)',
      );
      const privileged = embed?.fields?.filter((field) => field.name.startsWith('/thread manager'));
      expect(privileged).toHaveLength(isAdmin ? 3 : 0);
      if (isAdmin)
        expect(privileged?.every((field) => field.value.includes('Bot admins only'))).toBe(true);
      expect(reply?.components).toBeUndefined();
    },
  );

  it('explains an unknown command without rendering another command', async () => {
    const { handler, bot, interaction, editReply } = fixture('missing');

    await handler.execute(interaction, bot);

    expect(editReply).toHaveBeenCalledExactlyOnceWith({ content: 'No command named "missing".' });
  });

  it('omits the menu when no commands are loaded', async () => {
    const { handler, bot, interaction, commandHandlers, editReply } = fixture();
    commandHandlers.clear();

    await handler.execute(interaction, bot);

    const reply = editReply.mock.calls[0]?.[0];
    expect(reply?.components).toEqual([]);
    expect(reply?.embeds?.[0]?.toJSON().footer?.text).toBe('0 commands');
  });

  it('reports a failed response through the private error reply', async () => {
    const { handler, bot, interaction, deferReply, editReply } = fixture();
    editReply.mockRejectedValueOnce(new Error('Discord request failed'));

    await handler.execute(interaction, bot);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledTimes(2);
    expect(editReply.mock.calls[1]?.[0].content).toMatch(
      /^Could not get the command list\. \(error code: [0-9a-z]{6}\)$/,
    );
  });
});

describe('/help autocomplete', () => {
  it('suggests loaded slash commands case-insensitively and excludes context menus', async () => {
    const { handler, bot, commandHandlers } = fixture();
    commandHandlers.set('thread_context', {
      config: { name: 'thread_context', type: 2 },
    } as unknown as Command);
    const interaction = {
      options: { getFocused: () => 'THR' },
    } as unknown as AutocompleteInteraction;

    await expect(handler.autocomplete(interaction, bot)).resolves.toEqual([
      { name: '/thread', value: 'thread' },
    ]);
  });

  it('returns no suggestions for an unmatched query', async () => {
    const { handler, bot } = fixture();
    const interaction = {
      options: { getFocused: () => 'missing' },
    } as unknown as AutocompleteInteraction;

    await expect(handler.autocomplete(interaction, bot)).resolves.toEqual([]);
  });
});
