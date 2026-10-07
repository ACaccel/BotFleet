import { EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';

import type { Translator } from '../../../../src/core/i18n';
import type { Command, CommandCategory } from '../../../../src/handlers/commands/command';
import { buildHelpEmbed } from '../../../../src/handlers/commands/help/build-help-embed';

/**
 * Deterministic stub translator. Category labels echo the bare category
 * key, command descriptions/names echo the command id, and the footer
 * encodes its count params so the assertions can read them back.
 */
const stubTranslator = (): Translator => {
  const t = (key: string, params?: Record<string, string | number>): string => {
    if (key === 'replies:help.title') return 'Help';
    if (key === 'replies:help.intro_fallback') return 'fallback-intro';
    if (key === 'replies:help.footer') return `count:${params?.count}|cats:${params?.categories}`;
    if (key.startsWith('replies:help.category.')) {
      return key.slice('replies:help.category.'.length);
    }
    const id = key.split(':')[1]?.split('.')[0] ?? key;
    if (key.endsWith('.description')) return `desc-${id}`;
    if (key.endsWith('.name')) return `name-${id}`;
    return key;
  };
  return { t } as unknown as Translator;
};

const fakeCommand = (name: string, category?: CommandCategory, contextMenu = false): Command =>
  ({
    config: {
      name,
      ...(category !== undefined ? { category } : {}),
      ...(contextMenu ? { type: 2 } : {}),
    },
  }) as unknown as Command;

// Inserted in a deliberately scrambled order to prove the builder emits
// fields in CATEGORY_ORDER, not insertion order. server_activity and ai
// are left empty so the builder must skip them.
const commandMap = (): Map<string, Command> =>
  new Map<string, Command>([
    ['ban_user', fakeCommand('ban_user', 'admin')],
    ['talk', fakeCommand('talk', 'fun')],
    ['add_reply', fakeCommand('add_reply', 'auto_reply')],
    ['menu_get_avatar', fakeCommand('menu_get_avatar', 'utility', true)],
    ['mystery', fakeCommand('mystery')], // no category -> 'other'
  ]);

interface EmbedData {
  readonly author?: { name: string; icon_url?: string };
  readonly description?: string;
  readonly fields?: ReadonlyArray<{ name: string; value: string }>;
  readonly footer?: { text: string };
  readonly color?: number;
}

const dataOf = (embed: EmbedBuilder): EmbedData => (embed as unknown as { data: EmbedData }).data;

describe('buildHelpEmbed', () => {
  it('returns an EmbedBuilder', () => {
    const embed = buildHelpEmbed(commandMap(), stubTranslator(), {
      botName: 'Tomori',
      intro: 'hi',
    });
    expect(embed).toBeInstanceOf(EmbedBuilder);
  });

  it('emits non-empty category fields in CATEGORY_ORDER, skipping empty ones', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hi' }),
    );
    expect(data.fields?.map((f) => f.name)).toEqual([
      'auto_reply',
      'fun',
      'utility',
      'admin',
      'other',
    ]);
  });

  it('counts commands and categories in the footer', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hi' }),
    );
    expect(data.footer?.text).toBe('count:5|cats:5');
  });

  it('uses the provided intro as the description', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hello there' }),
    );
    expect(data.description).toBe('hello there');
  });

  it('falls back to the generic intro when none is provided', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: '   ' }),
    );
    expect(data.description).toBe('fallback-intro');
  });

  it('renders the bot name and title in the author line', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hi' }),
    );
    expect(data.author?.name).toBe('Tomori · Help');
  });

  it('prefixes chat-input commands with a slash and context-menu commands without one', () => {
    const data = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hi' }),
    );
    const fun = data.fields?.find((f) => f.name === 'fun');
    const utility = data.fields?.find((f) => f.name === 'utility');
    expect(fun?.value).toContain('`/talk`');
    // Context-menu command: localized name, no leading slash.
    expect(utility?.value).toContain('`name-menu_get_avatar`');
    expect(utility?.value).not.toContain('`/name-menu_get_avatar`');
  });

  it('shows complete direct and grouped paths while counting registered roots', () => {
    const command = fakeCommand('ai', 'ai');
    command.config.subcommands = [{ name: 'status' }];
    command.config.subcommandGroups = [
      { name: 'whitelist', subcommands: [{ name: 'add' }, { name: 'list' }] },
    ];
    const data = dataOf(
      buildHelpEmbed(new Map([['ai', command]]), stubTranslator(), {
        botName: 'Konata',
        intro: '',
      }),
    );
    expect(data.fields?.[0]?.value).toContain('`/ai status`');
    expect(data.fields?.[0]?.value).toContain('`/ai whitelist add`');
    expect(data.fields?.[0]?.value).toContain('`/ai whitelist list`');
    expect(data.fields?.[0]?.value).not.toContain('`/ai`');
    expect(data.footer?.text).toBe('count:1|cats:1');
  });

  it('sets the author icon only when an avatar url is supplied', () => {
    const withAvatar = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), {
        botName: 'Tomori',
        botAvatarUrl: 'https://cdn/avatar.png',
        intro: 'hi',
      }),
    );
    const withoutAvatar = dataOf(
      buildHelpEmbed(commandMap(), stubTranslator(), { botName: 'Tomori', intro: 'hi' }),
    );
    expect(withAvatar.author?.icon_url).toBe('https://cdn/avatar.png');
    expect(withoutAvatar.author?.icon_url).toBeUndefined();
  });
});
