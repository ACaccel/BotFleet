import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';

import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { Command } from '../../../../src/handlers/commands/command';
import Thread from '../../../../src/handlers/commands/thread';
import HelpCategory from '../../../../src/handlers/select-menus/help_category';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildStringSelectInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

let translator: Translator;

beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: 'src/i18n/locales',
    fallbackLocale: 'en',
  });
});

const fixture = (values: string[] = ['community'], isAdmin = false) => {
  const admin = vi.fn(() => isAdmin);
  const sink = newInteractionSink();
  const interaction = buildStringSelectInteraction({
    customId: 'help_category',
    values,
    userId: 'member-1',
    sink,
  });
  const { bot } = buildFakeBot({
    commandHandlers: new Map<string, Command>([['thread', new Thread()]]),
    translator,
    helpMessage: 'Personality introduction',
    isAdmin: admin,
  });
  return { handler: new HelpCategory(), bot, interaction, admin, sink };
};

/** The embed the select menu swapped in, as the member sees it. */
const shownEmbed = (update: { embeds?: readonly unknown[] } | undefined) =>
  (update?.embeds?.[0] as EmbedBuilder | undefined)?.toJSON();

describe('/help category menu', () => {
  it('updates the category with public executable paths for a member', async () => {
    const { handler, bot, interaction, admin, sink } = fixture();

    await handler.execute(interaction, bot);

    expect(sink.updates).toHaveLength(1);
    expect(admin).toHaveBeenCalledWith('member-1');
    const embed = shownEmbed(sink.updates[0]);
    expect(embed?.title).toContain('Community');
    expect(embed?.description).toContain('**`/thread ban`**');
    expect(embed?.description).not.toContain('/thread manager');
  });

  it('rechecks admin status on each selection after permissions change', async () => {
    const { handler, bot, interaction, admin, sink } = fixture(['community'], true);

    await handler.execute(interaction, bot);
    admin.mockReturnValue(false);
    await handler.execute(interaction, bot);

    expect(admin).toHaveBeenNthCalledWith(1, 'member-1');
    expect(admin).toHaveBeenNthCalledWith(2, 'member-1');
    expect(shownEmbed(sink.updates[0])?.description).toContain('/thread manager add');
    expect(shownEmbed(sink.updates[1])?.description).not.toContain('/thread manager');
  });

  it('returns to the overview with its category menu', async () => {
    const { handler, bot, interaction, admin, sink } = fixture(['overview']);

    await handler.execute(interaction, bot);

    expect(admin).toHaveBeenCalledWith('member-1');
    const embed = shownEmbed(sink.updates[0]);
    expect(embed?.author?.name).toBe('Test Bot · Command Help');
    expect(embed?.description).toContain('Personality introduction');
    const menu = sink.updates[0]?.components?.[0] as
      | ActionRowBuilder<StringSelectMenuBuilder>
      | undefined;
    const options = menu?.components[0]?.options.map((option) => option.data.value);
    expect(options).toEqual(['overview', 'community']);
  });

  it('shows an empty-state message for a valid category with no loaded commands', async () => {
    const { handler, bot, interaction, sink } = fixture(['fun']);

    await handler.execute(interaction, bot);

    expect(shownEmbed(sink.updates[0])?.description).toBe(
      'No commands in this category are available to you.',
    );
  });

  it.each([{ values: ['invalid'] }, { values: [] }])(
    'ignores an invalid or absent category $values',
    async ({ values }) => {
      const { handler, bot, interaction, admin, sink } = fixture(values);

      await handler.execute(interaction, bot);

      expect(admin).not.toHaveBeenCalled();
      expect(sink.updates).toEqual([]);
    },
  );
});
