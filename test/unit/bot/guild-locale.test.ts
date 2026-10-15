/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import { buildInertClient } from '../../fixtures/discord/client-builder';
import { barrelStubs } from '../../fixtures/handler-barrel-stubs';
vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
import { BaseBot } from '../../../src/bot/index';
import { TOKENS } from '../../../src/bot/tokens';
import type { GuildSettingsService } from '../../../src/application/guild-settings/service';

class LocaleBot extends BaseBot {}
describe('BaseBot scoped language and time zone', () => {
  it('supports constructor defaults and isolates simultaneous guild getter consumers', async () => {
    const bot = new LocaleBot(buildInertClient(), 'token', '', 'bot', {
      language: 'en',
      timeZone: 'Europe/London',
    });
    const values = new Map([
      ['a', { language: 'zh-TW', timeZone: 'Asia/Taipei' }],
      ['b', { language: 'inherit', timeZone: null }],
    ]);
    bot.container.registerSingleton(
      TOKENS.GuildSettings,
      () =>
        ({
          get: (guildId: string) => ({ settings: { general: values.get(guildId) } }),
        }) as unknown as GuildSettingsService,
    );
    expect(bot.language).toBe('en');
    expect(bot.timeZone).toBe('Europe/London');
    const valuesSeen = await Promise.all(
      ['a', 'b'].map((guildId) =>
        bot.withGuildContext(guildId, async () => {
          await Promise.resolve();
          return [bot.language, bot.timeZone];
        }),
      ),
    );
    expect(valuesSeen).toEqual([
      ['zh-TW', 'Asia/Taipei'],
      ['en', 'Europe/London'],
    ]);
    expect(bot.language).toBe('en');
    expect(bot.timeZone).toBe('Europe/London');
  });

  it('falls back to the framework locale and UTC before translator bootstrap', () => {
    const bot = new LocaleBot(buildInertClient(), 'token', '', 'bot', {});
    expect(bot.language).toBe('zh-TW');
    expect(bot.timeZone).toBe('UTC');
    expect(bot.withGuildContext('missing', () => [bot.language, bot.timeZone])).toEqual([
      'zh-TW',
      'UTC',
    ]);
  });
});
