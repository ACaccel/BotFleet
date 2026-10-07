import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Translator } from '../../src/core/i18n';
import { loadCatalogResources } from '../../src/core/i18n/catalog-loader';
import { I18NextTranslator } from '../../src/core/i18n/i18next-translator';
import {
  createCommand,
  buildCommandJsonBody,
  localizeCommandConfig,
} from '../../src/handlers/commands';

const resources = loadCatalogResources({
  localesDir: path.resolve(__dirname, '../../src/i18n/locales'),
});

describe.each(['en', 'zh-TW'] as const)('grouped command registration in %s', (locale) => {
  it.each(['feed', 'reply', 'activity', 'giveaway', 'ai', 'thread', 'traffic'])(
    'resolves every nested description and choice for %s',
    async (name) => {
      const translator = await I18NextTranslator.create(resources, locale);
      const strict = { t: translator.tStrict.bind(translator) } as Translator;
      const command = createCommand(name);
      expect(command).toBeDefined();
      const localized = localizeCommandConfig(command!.config, strict);
      expect(() => buildCommandJsonBody(localized)).not.toThrow();
    },
  );
});
