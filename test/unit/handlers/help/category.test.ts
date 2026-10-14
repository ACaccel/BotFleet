import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder, StringSelectMenuInteraction } from 'discord.js';

import type { BaseBot } from '../../../../src/bot';
import { createDefaultTranslator, type Translator } from '../../../../src/core/i18n';
import type { Command } from '../../../../src/handlers/commands/command';
import Thread from '../../../../src/handlers/commands/thread';
import HelpCategory from '../../../../src/handlers/select-menus/help_category';

let translator: Translator;

beforeAll(async () => {
  translator = await createDefaultTranslator({
    localesDir: 'src/i18n/locales',
    fallbackLocale: 'en',
  });
});

const fixture = (values: string[] = ['community'], isAdmin = false) => {
  const admin = vi.fn(() => isAdmin);
  const update = vi.fn(async (_payload: { embeds: EmbedBuilder[] }) => undefined);
  const interaction = {
    user: { id: 'member-1' },
    values,
    update,
  } as unknown as StringSelectMenuInteraction;
  const bot = {
    commandHandlers: new Map<string, Command>([['thread', new Thread()]]),
    translator,
    isAdmin: admin,
  } as unknown as BaseBot;
  return { handler: new HelpCategory(), bot, interaction, admin, update };
};

describe('/help category menu', () => {
  it('updates the category with public executable paths for a member', async () => {
    const { handler, bot, interaction, admin, update } = fixture();

    await handler.execute(interaction, bot);

    expect(update).toHaveBeenCalledTimes(1);
    expect(admin).toHaveBeenCalledWith('member-1');
    const embed = update.mock.calls[0]?.[0].embeds[0]?.toJSON();
    expect(embed?.title).toContain('Community');
    expect(embed?.description).toContain('**`/thread ban`**');
    expect(embed?.description).not.toContain('/thread manager');
  });

  it('rechecks admin status on each selection after permissions change', async () => {
    const { handler, bot, interaction, admin, update } = fixture(['community'], true);

    await handler.execute(interaction, bot);
    admin.mockReturnValue(false);
    await handler.execute(interaction, bot);

    expect(admin).toHaveBeenNthCalledWith(1, 'member-1');
    expect(admin).toHaveBeenNthCalledWith(2, 'member-1');
    expect(update.mock.calls[0]?.[0].embeds[0]?.toJSON().description).toContain(
      '/thread manager add',
    );
    expect(update.mock.calls[1]?.[0].embeds[0]?.toJSON().description).not.toContain(
      '/thread manager',
    );
  });

  it('shows an empty-state message for a valid category with no loaded commands', async () => {
    const { handler, bot, interaction, update } = fixture(['fun']);

    await handler.execute(interaction, bot);

    expect(update.mock.calls[0]?.[0].embeds[0]?.toJSON().description).toBe(
      'No commands in this category are available to you.',
    );
  });

  it.each([{ values: ['invalid'] }, { values: [] }])(
    'ignores an invalid or absent category $values',
    async ({ values }) => {
      const { handler, bot, interaction, admin, update } = fixture(values);

      await handler.execute(interaction, bot);

      expect(admin).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
});
