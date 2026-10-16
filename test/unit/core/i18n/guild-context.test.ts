import { describe, expect, it } from 'vitest';
import {
  GuildLocaleContext,
  I18NextTranslator,
  bindGuildContext,
  withGuildContext,
  type GuildLocaleSettings,
} from '../../../../src/core/i18n';
import { parseStartTime } from '../../../../src/handlers/commands/activity-shared/parse-input';

const build = async () => {
  const preferences = new Map<string, GuildLocaleSettings>([
    ['a', { language: 'en', timeZone: 'Asia/Taipei' }],
    ['b', { language: 'zh-TW', timeZone: 'America/New_York' }],
  ]);
  const defaults: GuildLocaleSettings = { language: 'zh-TW', timeZone: 'UTC' };
  const scope = new GuildLocaleContext((id) => (id ? (preferences.get(id) ?? defaults) : defaults));
  const base = await I18NextTranslator.create({
    en: { commands: {}, errors: {}, replies: { greeting: 'Hello' } },
    'zh-TW': { commands: {}, errors: {}, replies: { greeting: 'Welcome' } },
  });
  return { preferences, scope, base, translator: scope.translator(base) };
};

describe('guild execution locale', () => {
  it('isolates concurrent guilds across awaits without mutating the base translator', async () => {
    const { scope, translator, base } = await build();
    let resume: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const a = scope.run('a', async () => {
      await barrier;
      return [translator.t('replies:greeting'), scope.current.timeZone];
    });
    const b = scope.run('b', async () => {
      await Promise.resolve();
      resume();
      return [translator.tStrict('replies:greeting'), scope.current.timeZone];
    });
    expect(await a).toEqual(['Hello', 'Asia/Taipei']);
    expect(await b).toEqual(['Welcome', 'America/New_York']);
    expect(base.t('replies:greeting')).toBe('Welcome');
    expect(scope.current.timeZone).toBe('UTC');
  });

  it('honors explicit private UI locale and isolates a second bot in nested execution', async () => {
    const { scope, translator, base } = await build();
    const other = new GuildLocaleContext(() => ({ language: 'zh-TW', timeZone: 'UTC' }));
    const second = other.translator(base);
    scope.run('a', () => {
      expect(translator.t('replies:greeting')).toBe('Hello');
      expect(translator.t('replies:greeting', {}, 'zh-TW')).toBe('Welcome');
      expect(second.t('replies:greeting')).toBe('Welcome');
      other.run('b', () => expect(translator.t('replies:greeting')).toBe('Welcome'));
      expect(translator.t('replies:greeting')).toBe('Hello');
    });
  });

  it('binds scheduled work to guild identity and refreshes preferences at execution', async () => {
    const { preferences, scope, translator } = await build();
    const callback = scope.run('a', () =>
      bindGuildContext(() => [translator.t('replies:greeting'), scope.current.timeZone]),
    );
    preferences.set('a', { language: 'zh-TW', timeZone: 'Europe/London' });
    scope.run('b', () => {
      expect(callback()).toEqual(['Welcome', 'Europe/London']);
      expect(scope.current.timeZone).toBe('America/New_York');
    });
    expect(scope.active).toBe(false);
  });

  it('applies each guild zone to activity local-date parsing', async () => {
    const { scope } = await build();
    const now = Date.UTC(2030, 0, 1);
    const parse = () => parseStartTime('2030-02-01 12:00', now, scope.current.timeZone);
    expect(scope.run('a', parse)).toBe(Date.UTC(2030, 1, 1, 4));
    expect(scope.run('b', parse)).toBe(Date.UTC(2030, 1, 1, 17));
  });

  it('keeps a single operation snapshot stable and falls back for unknown guilds and legacy translators', async () => {
    const { scope, preferences, translator } = await build();
    scope.run('a', () => {
      preferences.set('a', { language: 'zh-TW', timeZone: 'UTC' });
      expect(translator.t('replies:greeting')).toBe('Hello');
      expect(scope.current.timeZone).toBe('Asia/Taipei');
    });
    expect(scope.run('missing', () => translator.t('replies:greeting'))).toBe('Welcome');
    expect(withGuildContext(undefined, 'a', () => 42)).toBe(42);
    const plain = () => 7;
    expect(bindGuildContext(plain)).toBe(plain);
  });
});
