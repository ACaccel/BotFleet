import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { I18NextTranslator } from '../../src/core/i18n/i18next-translator';
import { loadCatalogResources } from '../../src/core/i18n/catalog-loader';
import { PERMISSION_LABEL_KEYS } from '../../src/handlers/feed-panel/permission-requirements';
import { FEED_PLATFORM_DISPLAY_NAMES, SUPPORTED_FEED_PLATFORMS } from '../../src/infra/social-feed';
import { FEED_MEDIA_FILTERS } from '../../src/persistence/schemas/feed-subscription.schema';

/**
 * The loader does not reverse-resolve `src/i18n/locales` from its own
 * `__dirname`. This test file is part of the composition surface (it
 * asserts behaviour against the real deployed catalogs), so it owns the
 * path knowledge and injects it explicitly.
 */
const LOCALES_DIR = path.resolve(__dirname, '..', '..', 'src', 'i18n', 'locales');

/**
 * Runtime catalog checks.
 *
 * Unlike `catalog-completeness.test.ts` — which inspects the raw JSON files
 * for cross-locale key/placeholder parity — this suite loads the on-disk
 * catalogs through the real `loadCatalogResources` + `I18NextTranslator`
 * pipeline and asserts:
 *
 * - the `en` locale resolves real keys, and a key missing in `en`
 *   degrades gracefully by falling back to `zh-TW`.
 * - every per-feature `replies:<feature>.failed` fallback string carries
 *   the `{{traceId}}` interpolation slot so `replyForError` can surface a
 *   trace code for non-DomainError failures.
 */
/** Every suffix `feed_subscribe` can render under `replies:feed.permission.`. */
const FEED_PERMISSION_LABEL_SUFFIXES = [
  ...new Set(Object.values(PERMISSION_LABEL_KEYS)),
] as readonly string[];

describe('catalog runtime behaviour', () => {
  it('loads both locales from disk', () => {
    const resources = loadCatalogResources({ localesDir: LOCALES_DIR });
    expect(Object.keys(resources).sort()).toEqual(['en', 'zh-TW']);
  });

  it('resolves command metadata for the en locale', async () => {
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    expect(translator.t('commands:reply.subcommands.add.description', undefined, 'en')).toBe(
      'Add an auto-reply: the bot answers messages that exactly match the keyword',
    );
    expect(translator.t('commands:reply.subcommands.add.description', undefined, 'zh-TW')).toBe(
      '新增自動回覆:有人發出與關鍵字完全相同的訊息時,bot 會回覆',
    );
  });

  it('falls back to zh-TW when a key is absent in the requested locale', async () => {
    // Inject a deliberately en-incomplete catalog: the loader keeps zh-TW
    // intact, so a missing en key must degrade to the fallback locale
    // rather than throwing or returning the bare key.
    const resources = loadCatalogResources({ localesDir: LOCALES_DIR });
    const trimmedEn = {
      ...resources,
      en: {
        ...resources.en,
        replies: { ...resources.en.replies },
      },
    };
    delete (trimmedEn.en.replies as Record<string, unknown>).help;
    const translator = await I18NextTranslator.create(trimmedEn, 'zh-TW');
    expect(translator.t('replies:help.title', undefined, 'en')).toBe('指令說明');
  });

  it('resolves every errors:feed.* FeedError messageKey with its params filled in', async () => {
    // The eight FeedErrorCode sub-codes map to these keys via
    // `infra/social-feed/platforms/error-translator.messageKeyFor`. That
    // mapping and the catalog are joined only by matching string
    // literals, so renaming one side alone would otherwise pass every
    // gate and reach a user as a raw key.
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    const params = { platform: 'X', account: 'someaccount', status: '404' };
    const feedKeys = [
      'errors:feed.fetch_failed',
      'errors:feed.timeout',
      'errors:feed.upstream_failure',
      'errors:feed.rate_limited',
      'errors:feed.not_found',
      'errors:feed.invalid_response',
      'errors:feed.invalid_account',
      'errors:feed.platform_not_configured',
    ] as const;
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const key of feedKeys) {
        const resolved = translator.t(key, params, locale);
        expect(resolved, `${key} (${locale}) must resolve to a real string`).not.toBe(key);
        expect(resolved.length, `${key} (${locale}) must be non-empty`).toBeGreaterThan(0);
        expect(
          /\{\{\s*\w+\s*\}\}/.test(resolved),
          `${key} (${locale}) must not contain an uninterpolated placeholder`,
        ).toBe(false);
      }
    }
  });

  it('resolves every replies:feed.* key the feed commands actually use', async () => {
    // Companion to the `errors:feed.*` block above. These keys are
    // joined to the handlers only by matching string literals, and the
    // handler suites all run an echo translator, so a catalog typo is
    // invisible to every other gate.
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    const params = {
      platform: 'X (Twitter)',
      account: 'someaccount',
      channel: '<#c-1>',
      permissions: 'View Channel',
      keyword: 'live',
      filter: 'photos or videos · keyword: live',
      count: 2,
      total: 3,
      list: '`x @someaccount`',
      max: 20,
      reason: 'the account was not found',
      traceId: 'abc123',
    };
    const replyKeys = [
      'replies:feed.subscribe_header',
      'replies:feed.account_subscribed',
      'replies:feed.account_updated',
      'replies:feed.account_failed',
      'replies:feed.account_skipped',
      'replies:feed.reason_unknown',
      'replies:feed.no_accounts',
      'replies:feed.too_many_accounts',
      'replies:feed.unsubscribed',
      'replies:feed.unsubscribed_more',
      'replies:feed.unsubscribed_none',
      'replies:feed.unsubscribed_none_hint',
      'replies:feed.clear_confirm',
      'replies:feed.clear_confirm_label',
      'replies:feed.clear_cancel_label',
      'replies:feed.clear_cancelled',
      'replies:feed.clear_not_invoker',
      'replies:feed.clear_stale',
      'replies:feed.channel_not_supported',
      'replies:feed.missing_bot_permissions',
      'replies:feed.permissions_unknown',
      'replies:feed.invoker_permissions_unknown',
      'replies:feed.invoker_cannot_view',
      'replies:feed.permission_separator',
      'replies:feed.list_empty',
      'replies:feed.list_header',
      'replies:feed.filter_keyword',
      'replies:feed.never_forwarded',
      'replies:feed.failed',
      'replies:common.pages_failed',
    ] as const;
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const key of replyKeys) {
        const resolved = translator.t(key, params, locale);
        expect(resolved, `${key} (${locale}) must resolve to a real string`).not.toBe(key);
        expect(resolved.length, `${key} (${locale}) must be non-empty`).toBeGreaterThan(0);
        expect(
          /\{\{\s*\w+\s*\}\}/.test(resolved),
          `${key} (${locale}) must not contain an uninterpolated placeholder`,
        ).toBe(false);
      }
    }
    // Passing a param proves nothing on its own: dropping `{{filter}}`
    // from both locales leaves every assertion above green, and the
    // handler suites run an echo translator that cannot see the copy.
    // `/feed subscribe` replaces a stored filter wholesale, so these two
    // lines have to state the one now in force.
    const successKeys = [
      'replies:feed.account_subscribed',
      'replies:feed.account_updated',
    ] as const;
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const key of successKeys) {
        expect(
          translator.t(key, params, locale),
          `${key} (${locale}) must name the filter it was given`,
        ).toContain(params.filter);
      }
    }
  });

  it('renders the feed clear prompt and its button labels at every count', async () => {
    // The prompt is plural-keyed, and the shared block above only ever
    // resolves it at count 2 — which is how a dead `_one` string, or one
    // that reads as "all 1 subscriptions", stays invisible to a green
    // suite. zh-TW has no `one` plural category, so its two forms must
    // both read correctly whichever i18next picks.
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const count of [1, 2, 20]) {
        const resolved = translator.t(
          'replies:feed.clear_confirm',
          { channel: '<#c-1>', count },
          locale,
        );
        expect(resolved, `clear_confirm (${locale}, count=${String(count)})`).not.toBe(
          'replies:feed.clear_confirm',
        );
        expect(resolved).toContain(String(count));
        expect(/\{\{\s*\w+\s*\}\}/.test(resolved)).toBe(false);
      }
      // Discord rejects a button whose label is empty or past 80
      // characters. A translator cannot see that limit, so the catalog
      // is where it has to be held.
      for (const key of ['replies:feed.clear_confirm_label', 'replies:feed.clear_cancel_label']) {
        const label = translator.t(key, undefined, locale);
        expect(label.length, `${key} (${locale}) must be a usable button label`).toBeGreaterThan(0);
        expect(
          label.length,
          `${key} (${locale}) must fit Discord's 80-character limit`,
        ).toBeLessThanOrEqual(80);
      }
    }
  });

  it('has a label for every value the feed constants can produce', async () => {
    // The command choices and the `/feed list` filter label are built by
    // mapping over `SUPPORTED_FEED_PLATFORMS` and `FEED_MEDIA_FILTERS`,
    // so widening either constant without touching the catalog would
    // ship the raw key to a user as a Discord choice label. Deriving the
    // expectation from the constants makes that a test failure instead.
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    const derived = [
      ...SUPPORTED_FEED_PLATFORMS.flatMap((id) => [
        `commands:feed.subcommands.subscribe.options.platform.choices.${id}`,
        `commands:feed.subcommands.unsubscribe.options.platform.choices.${id}`,
      ]),
      ...FEED_MEDIA_FILTERS.flatMap((value) => [
        `commands:feed.subcommands.subscribe.options.media.choices.${value}`,
        `replies:feed.filter_media.${value}`,
      ]),
      ...FEED_PERMISSION_LABEL_SUFFIXES.map((suffix) => `replies:feed.permission.${suffix}`),
    ];
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const key of derived) {
        const resolved = translator.t(key, undefined, locale);
        expect(resolved, `${key} (${locale}) must resolve to a real label`).not.toBe(key);
        expect(resolved.length, `${key} (${locale}) must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every errors:db.* DatabaseError messageKey with no leftover placeholder', async () => {
    // The six DatabaseErrorCode sub-codes map to these keys via
    // `error-translator.i18nKeyFor`. `databaseErrorFrom` passes no
    // `messageParams`, so none of these texts may carry an interpolation
    // slot — otherwise a raw `{{...}}` token would leak into the reply.
    const translator = await I18NextTranslator.create(
      loadCatalogResources({ localesDir: LOCALES_DIR }),
    );
    const dbKeys = [
      'errors:db.duplicate_key',
      'errors:db.timeout',
      'errors:db.query_timeout',
      'errors:db.network',
      'errors:db.validation',
      'errors:db.unavailable',
    ] as const;
    for (const locale of ['zh-TW', 'en'] as const) {
      for (const key of dbKeys) {
        const resolved = translator.t(key, undefined, locale);
        expect(resolved, `${key} (${locale}) must resolve to a real string`).not.toBe(key);
        expect(resolved.length, `${key} (${locale}) must be non-empty`).toBeGreaterThan(0);
        expect(
          /\{\{\s*\w+\s*\}\}/.test(resolved),
          `${key} (${locale}) must not contain an uninterpolated placeholder`,
        ).toBe(false);
      }
    }
  });

  it('spells each feed platform identically in the choice catalog and the shared map', () => {
    // A platform now gets named from two places: the `platform` option's
    // choice label, which is per-locale catalog copy, and
    // `FEED_PLATFORM_DISPLAY_NAMES`, a code constant that labels
    // `/feed unsubscribe`'s account suggestions and the
    // unconfigured-platform refusal. A member reading the choice list
    // and the suggestion dropdown side by side sees both, so the two
    // must agree — and nothing else would notice if a translator
    // changed one of them.
    const resources = loadCatalogResources({ localesDir: LOCALES_DIR });
    for (const locale of ['zh-TW', 'en'] as const) {
      const catalog = resources[locale].commands as {
        feed: { subcommands: Record<string, unknown> };
      };
      const commands = catalog.feed.subcommands;
      for (const command of ['subscribe', 'unsubscribe'] as const) {
        const choices = ((
          (commands[command] as { options?: Record<string, unknown> } | undefined)?.options?.[
            'platform'
          ] as { choices?: Record<string, string> } | undefined
        )?.choices ?? {}) as Record<string, string>;
        for (const id of SUPPORTED_FEED_PLATFORMS) {
          expect(
            choices[id],
            `commands:feed.subcommands.${command}.options.platform.choices.${id} (${locale}) must match ` +
              'FEED_PLATFORM_DISPLAY_NAMES, which names the same platform elsewhere',
          ).toBe(FEED_PLATFORM_DISPLAY_NAMES[id]);
        }
      }
    }
  });

  it('keeps a {{traceId}} slot in every per-feature failed fallback string', () => {
    const resources = loadCatalogResources({ localesDir: LOCALES_DIR });
    for (const locale of ['zh-TW', 'en'] as const) {
      const replies = resources[locale].replies as Record<string, unknown>;
      for (const [feature, value] of Object.entries(replies)) {
        if (value === null || typeof value !== 'object') continue;
        const failed = (value as Record<string, unknown>).failed;
        if (typeof failed !== 'string') continue;
        expect(
          failed.includes('{{traceId}}'),
          `replies:${feature}.failed (${locale}) must carry a {{traceId}} interpolation slot`,
        ).toBe(true);
      }
    }
  });
});
