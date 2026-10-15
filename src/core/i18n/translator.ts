/**
 * Translator abstraction.
 *
 * The contract for every user-facing string in the codebase. The default
 * i18next-backed implementation lives in `i18next-translator.ts`;
 * application and interface code receives a `Translator` via constructor
 * injection (so tests can substitute a deterministic fake) and never
 * embeds literal user-facing text (lint rules enforce this).
 *
 * Adding a new locale requires only:
 *   1. add a value to the `Locale` union below
 *   2. drop a parallel JSON folder under src/i18n/locales/<locale>/
 *   3. the catalog-completeness test will fail until keys match
 *
 * Placeholder syntax invariant: catalogs use i18next's `{{name}}` form,
 * NOT single-brace ICU. The two formats are incompatible; do not switch
 * without migrating every catalog entry in lockstep.
 */
export type Locale = 'zh-TW' | 'en';

/**
 * The single source of truth for every supported locale. The `Locale`
 * union above is kept in lockstep with this tuple; {@link isLocale}
 * validates untrusted input (e.g. a bot's `config.json` `language`
 * field) against it. Adding a locale means extending both this tuple
 * and the union, then dropping a parallel catalog folder.
 */
export const SUPPORTED_LOCALES = ['zh-TW', 'en'] as const;

export const DEFAULT_LOCALE: Locale = 'zh-TW';

/**
 * Runtime type guard for {@link Locale}. Use at trust boundaries where a
 * value arrives as an unvalidated `string | unknown` (config files,
 * environment, request payloads) before it may be passed to the
 * translator as a locale.
 */
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);

export type TranslationParams = Readonly<Record<string, string | number>>;

/**
 * Type alias for translation keys. Currently `string`. Call sites
 * import this name rather than typing `string` directly so a future
 * narrowing to a catalog-generated union stays a pure compile-time
 * tightening with no callsite churn.
 */
export type TranslationKey = string;

export class MissingTranslationError extends Error {
  public readonly key: TranslationKey;
  public readonly locale: Locale;

  public constructor(key: TranslationKey, locale: Locale) {
    super(`Missing translation: key="${key}" locale="${locale}"`);
    this.name = 'MissingTranslationError';
    this.key = key;
    this.locale = locale;
  }
}

export interface Translator {
  /** Run a guild operation without changing shared translator defaults. */
  withGuildContext?<T>(guildId: string | undefined, callback: () => T): T;
  /**
   * Translate a key for the given (or default) locale.
   * Returns the key string itself when missing — never throws — so a
   * forgotten translation degrades gracefully in production while the
   * catalog-completeness CI gate catches it before merge.
   */
  t(key: TranslationKey, params?: TranslationParams, locale?: Locale): string;

  /**
   * Strict translate — throws {@link MissingTranslationError} when the
   * key is absent in the requested locale (with fallback). Use in tests
   * and in dev-mode assertions; not in production handlers.
   */
  tStrict(key: TranslationKey, params?: TranslationParams, locale?: Locale): string;

  /**
   * Report which keys are missing in each locale compared to `reference`.
   * Used by the catalog-completeness test.
   */
  listMissingKeys(reference: Locale): Record<Locale, readonly string[]>;
}
