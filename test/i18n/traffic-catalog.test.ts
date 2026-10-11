/**
 * Every `replies:traffic.*` string the `/traffic` subcommands render resolves
 * in both locales with every placeholder filled. The handler suites run an
 * echo translator, so a catalog typo or a missing plural form would otherwise
 * reach a member as a raw key.
 */
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadCatalogResources } from '../../src/core/i18n/catalog-loader';
import { I18NextTranslator } from '../../src/core/i18n/i18next-translator';
import Traffic from '../../src/handlers/commands/traffic';
import { fakeBot, fakeInteraction, fakeStatsRepo } from '../unit/handlers/traffic/report-fixtures';

vi.mock('../../src/infra/graphics/image-loader', () => ({
  createImageLoader: () => ({ load: vi.fn(async () => null) }),
}));

const resources = loadCatalogResources({
  localesDir: path.resolve(__dirname, '../../src/i18n/locales'),
});

const CASES = [
  { subcommand: 'overview' },
  { subcommand: 'overview', values: { range: '24h' } },
  { subcommand: 'channel', channel: 'c1' },
  { subcommand: 'channel', channel: 'c2', values: { range: '365d' } },
  { subcommand: 'channel', channel: 'secret' },
  { subcommand: 'me' },
  { subcommand: 'user', values: { range: '90d' } },
  { subcommand: 'apps' },
  { subcommand: 'apps', app: 'bot-a' },
  { subcommand: 'emoji', values: { order: 'least' } },
  { subcommand: 'sticker' },
] as const;

describe.each(['en', 'zh-TW'] as const)('/traffic catalog in %s', (locale) => {
  it('resolves every rendered string', async () => {
    const translator = await I18NextTranslator.create(resources, locale);
    const problems: string[] = [];
    const t = (key: string, params?: Record<string, unknown>): string => {
      const text = translator.t(key, params as never, locale);
      if (text === key || text.includes('{{')) problems.push(`${key} -> ${text}`);
      return text;
    };
    for (const options of CASES) {
      const { interaction, replies } = fakeInteraction(options);
      await new Traffic().execute(interaction, fakeBot(fakeStatsRepo(), t));
      expect(replies, options.subcommand).toHaveLength(1);
    }
    for (const options of [{ subcommand: 'overview' }, { subcommand: 'me' }] as const) {
      const { interaction } = fakeInteraction(options);
      await new Traffic().execute(interaction, fakeBot(fakeStatsRepo({ messages: 0 }), t));
    }
    expect(problems).toEqual([]);
  });
});
