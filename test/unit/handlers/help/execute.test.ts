import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  type ActionRowBuilder,
  type EmbedBuilder,
  type StringSelectMenuBuilder,
} from 'discord.js';

import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { Command } from '../../../../src/handlers/commands/command';
import Help from '../../../../src/handlers/commands/help';
import Thread from '../../../../src/handlers/commands/thread';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildAutocompleteInteraction,
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

let translator: Translator;

beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: 'src/i18n/locales',
    fallbackLocale: 'en',
  });
});

interface Fixture {
  readonly requested?: string;
  readonly isAdmin?: boolean;
  /** Rejects the first `editReply`, as a Discord outage on the response would. */
  readonly failFirstEdit?: boolean;
}

const fixture = ({ requested, isAdmin = false, failFirstEdit = false }: Fixture = {}) => {
  const handler = new Help();
  const commandHandlers = new Map<string, Command>([
    ['help', handler],
    ['thread', new Thread()],
  ]);
  const admin = vi.fn(() => isAdmin);
  const sink = newInteractionSink();
  const interaction = buildChatInputInteraction({
    userId: 'member-1',
    guildId: null,
    options: requested === undefined ? {} : { command: requested },
    sink,
  });
  Object.assign(interaction, {
    client: {
      user: {
        username: 'Test Bot',
        displayAvatarURL: () => 'https://example.com/avatar.png',
      },
    },
  });
  // Every attempt is kept, including the one the "outage" swallows.
  const attempted: unknown[] = [];
  const deliver = interaction.editReply.bind(interaction);
  Object.assign(interaction, {
    editReply: async (payload: unknown) => {
      attempted.push(payload);
      if (failFirstEdit && attempted.length === 1) throw new Error('Discord request failed');
      return deliver(payload as Parameters<typeof deliver>[0]);
    },
  });
  const { bot } = buildFakeBot({
    commandHandlers,
    translator,
    helpMessage: 'Personality introduction',
    isAdmin: admin,
  });
  return { handler, bot, interaction, commandHandlers, admin, sink, attempted };
};

const embedOf = (reply: { embeds?: readonly unknown[] } | undefined) =>
  (reply?.embeds?.[0] as EmbedBuilder | undefined)?.toJSON();

const menuOf = (reply: { components?: readonly unknown[] } | undefined) =>
  (reply?.components?.[0] as ActionRowBuilder<StringSelectMenuBuilder> | undefined)?.toJSON()
    .components[0];

describe('/help execute', () => {
  it('privately sends the overview and category menu in a DM', async () => {
    const { handler, bot, interaction, admin, sink } = fixture();

    await handler.execute(interaction, bot);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(admin).toHaveBeenCalledWith('member-1');
    expect(sink.editReplies).toHaveLength(1);
    const reply = sink.editReplies[0];
    const embed = embedOf(reply);
    expect(embed?.author).toMatchObject({
      name: 'Test Bot · Command Help',
      icon_url: 'https://example.com/avatar.png',
    });
    expect(embed?.description).toContain('Personality introduction');
    expect(embed?.fields?.map((field) => field.value).join('\n')).toContain('`/thread`');
    const menu = menuOf(reply);
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
      const { handler, bot, interaction, sink } = fixture({ requested: '/thread', isAdmin });

      await handler.execute(interaction, bot);

      expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
      const reply = sink.editReplies[0];
      const embed = embedOf(reply);
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
    const { handler, bot, interaction, sink } = fixture({ requested: 'missing' });

    await handler.execute(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'No command named "missing".' }]);
  });

  it('omits the menu when no commands are loaded', async () => {
    const { handler, bot, interaction, commandHandlers, sink } = fixture();
    commandHandlers.clear();

    await handler.execute(interaction, bot);

    const reply = sink.editReplies[0];
    expect(reply?.components).toEqual([]);
    expect(embedOf(reply)?.footer?.text).toBe('0 commands');
  });

  it('reports a failed response through the private error reply', async () => {
    const { handler, bot, interaction, sink, attempted } = fixture({ failFirstEdit: true });

    await handler.execute(interaction, bot);

    expect(sink.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(attempted).toHaveLength(2);
    expect(sink.editReplies).toHaveLength(1);
    expect(sink.editReplies[0]?.content).toMatch(
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
    const interaction = buildAutocompleteInteraction({ focused: 'THR' });

    await expect(handler.autocomplete(interaction, bot)).resolves.toEqual([
      { name: '/thread', value: 'thread' },
    ]);
  });

  it('returns no suggestions for an unmatched query', async () => {
    const { handler, bot } = fixture();
    const interaction = buildAutocompleteInteraction({ focused: 'missing' });

    await expect(handler.autocomplete(interaction, bot)).resolves.toEqual([]);
  });
});
