/**
 * Filesystem-backed catalog loader.
 *
 * Reads `<localesDir>/<locale>/<namespace>.json` and assembles a
 * {@link CatalogResources} blob that {@link I18NextTranslator.create}
 * accepts.
 *
 * Why filesystem and not bundler import: the bot runs via `ts-node` /
 * compiled JS without a bundler, so static `import xx from "*.json"`
 * paths would need a custom resolver. A sync `readFileSync` at startup is
 * one-off.
 *
 * `localesDir` is REQUIRED: the composition root owns the deployment
 * layout and injects the path, so this loader never resolves it via
 * `__dirname` tricks.
 *
 * Missing namespace files for a locale degrade to an empty object rather
 * than throwing — the catalog-completeness test owns the strict
 * cross-locale parity check; this loader stays lenient at runtime.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { I18NextTranslator, type CatalogResources } from './i18next-translator';
import { DEFAULT_LOCALE, type Locale, type Translator } from './translator';

const NAMESPACES = ['commands', 'errors', 'replies'] as const;
type Namespace = (typeof NAMESPACES)[number];

interface LoadCatalogOptions {
  /**
   * Filesystem path to the locales root. Required: the composition
   * root must inject it so `core` stays ignorant of the deployment
   * layout.
   */
  readonly localesDir: string;
  /** Override the fallback locale; default = {@link DEFAULT_LOCALE}. */
  readonly fallbackLocale?: Locale;
}

/** Read every locale folder under `options.localesDir` into a {@link CatalogResources}. */
export const loadCatalogResources = (options: LoadCatalogOptions): CatalogResources => {
  const dir = options.localesDir;
  if (!fs.existsSync(dir)) {
    // Surface a precise, actionable error here rather than the generic
    // ENOENT readdirSync would throw — this runs at bot startup before
    // any logger context is wired, so the message is the entire signal.
    throw new Error(
      `loadCatalogResources: locales directory not found at "${dir}". ` +
        'Set LoadCatalogOptions.localesDir to the deployed locales root.',
    );
  }
  const resources: Partial<Record<Locale, Record<Namespace, Record<string, unknown>>>> = {};
  for (const localeDir of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!localeDir.isDirectory()) continue;
    const locale = localeDir.name as Locale;
    const namespaces: Record<Namespace, Record<string, unknown>> = {
      commands: {},
      errors: {},
      replies: {},
    };
    for (const ns of NAMESPACES) {
      const filePath = path.join(dir, locale, `${ns}.json`);
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      namespaces[ns] = JSON.parse(raw) as Record<string, unknown>;
    }
    resources[locale] = namespaces;
  }
  return resources as CatalogResources;
};

/** Convenience: load catalogs from disk and build the default Translator. */
export const createDefaultTranslator = async (options: LoadCatalogOptions): Promise<Translator> => {
  const resources = loadCatalogResources(options);
  return I18NextTranslator.create(resources, options.fallbackLocale ?? DEFAULT_LOCALE);
};
