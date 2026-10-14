import { describe, expect, it } from 'vitest';

import type { Command, CommandConfig } from '../../../../src/handlers/commands/command';
import {
  buildCategoryEmbed,
  buildCommandDetail,
  buildHelpOverview,
} from '../../../../src/handlers/commands/help/build-help-embed';
import { echoTranslator } from '../../../fixtures/runtime';

/** Echoes keys, so assertions read which catalog entry each part used. */
const echo = echoTranslator();

const command = (config: CommandConfig): Command => ({ config }) as unknown as Command;

const handlers = new Map<string, Command>([
  [
    'thread',
    command({
      name: 'thread',
      category: 'admin',
      subcommands: [{ name: 'ban', options: { string: [{ name: 'users', required: true }] } }],
      subcommandGroups: [{ name: 'manager', subcommands: [{ name: 'add', adminOnly: true }] }],
    }),
  ],
  ['give_score', command({ name: 'give_score', category: 'fun' })],
  ['menu_get_avatar', command({ name: 'menu_get_avatar', category: 'utility', type: 2 })],
]);

const fieldsOf = (embed: { data: { fields?: { name: string; value: string }[] } }) =>
  embed.data.fields ?? [];

describe('/help overview', () => {
  it('lists one line per command by category and offers a category menu', () => {
    const { embed, menu } = buildHelpOverview(handlers, echo, {
      isAdmin: false,
      botName: 'Bot',
      intro: '',
    });

    const fields = fieldsOf(embed);
    expect(fields.map((field) => field.name)).toEqual([
      'replies:help.category.fun',
      'replies:help.category.utility',
      'replies:help.category.admin',
    ]);
    expect(fields[0]?.value).toBe('`/give_score` commands:give_score.description');
    expect(fields[1]?.value).toContain('`commands:menu_get_avatar.name`');
    const options = menu?.components[0]?.options.map((option) => option.data.value);
    // The overview entry leads, so a category page can always return to it.
    expect(options).toEqual(['overview', 'fun', 'utility', 'admin']);
  });
});

describe('/help category page', () => {
  it('shows every path with its own description', () => {
    const embed = buildCategoryEmbed(handlers, echo, 'admin', { isAdmin: true });

    expect(embed.data.description).toContain(
      '**`/thread ban`** commands:thread.subcommands.ban.description',
    );
    expect(embed.data.description).toContain('/thread manager add');
  });

  it('hides admin-only paths from other members', () => {
    const embed = buildCategoryEmbed(handlers, echo, 'admin', { isAdmin: false });

    expect(embed.data.description).not.toContain('/thread manager add');
  });
});

describe('/help command page', () => {
  it('shows the notes and each path with its options', () => {
    const embed = buildCommandDetail(handlers.get('thread') as Command, echo, { isAdmin: true });

    expect(embed.data.description).toContain('replies:help.details.thread');
    const ban = fieldsOf(embed).find((field) => field.name === '/thread ban');
    expect(ban?.value).toContain(
      '`users` (replies:help.required) commands:thread.subcommands.ban.options.users.description',
    );
    const add = fieldsOf(embed).find((field) => field.name === '/thread manager add');
    expect(add?.value).toContain('replies:help.admin_only');
  });
});
