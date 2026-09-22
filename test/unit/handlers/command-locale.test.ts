/**
 * Guards that command-registration JSON is localised to the translator's
 * locale — the behaviour `src/register.ts` relies on so a bot registered with
 * `config.language: "en"` registers English slash-command descriptions.
 *
 * The translator register builds carries the bot's `fallbackLocale`;
 * without it every bot would register `zh-TW` text regardless of its
 * configured language.
 *
 * Imports `command` / `command-builder` directly (not the `@cmd` barrel)
 * to stay out of the generated-registry import; reads the real catalog
 * via `resolveLocalesDir`, like the i18n catalog-runtime suite.
 */
import { describe, expect, it } from 'vitest';

import { resolveLocalesDir } from '../../../src/bot/locales-dir';
import { createDefaultTranslator, type Locale } from '../../../src/core/i18n';
import { buildCommandJsonBody } from '../../../src/handlers/commands/command-builder';
import { localizeCommandConfig } from '../../../src/handlers/commands/command';

const descriptionFor = async (locale: Locale): Promise<string | undefined> => {
  const translator = await createDefaultTranslator({
    localesDir: resolveLocalesDir(),
    fallbackLocale: locale,
  });
  const json = buildCommandJsonBody(localizeCommandConfig({ name: 'talk' }, translator)) as {
    description?: string;
  };
  return json.description;
};

describe('register command localization honors the configured locale', () => {
  it('resolves a command description in the translator locale, differing per locale', async () => {
    const en = await descriptionFor('en');
    const zh = await descriptionFor('zh-TW');
    expect(en).toBeTruthy();
    expect(zh).toBeTruthy();
    expect(en).not.toBe(zh);
  });
});
