/**
 * `BaseBot` stand-ins for handler-layer tests.
 *
 * A handler receives the whole `BaseBot` but reads a handful of fields
 * off it — usually `translator`, `logger`, and one of `config` /
 * `getGuildInfo` / `getRepos`. Building that by hand meant an
 * `as unknown as BaseBot` cast in every handler test file, each with a
 * slightly different logger stub.
 *
 * {@link buildFakeBot} owns the single cast. Call sites pass only the
 * fields their handler actually reads, which doubles as documentation
 * of the handler's real dependency surface.
 */
import type { BaseBot } from '../../../src/bot';
import type { Translator } from '../../../src/core/i18n';
import { echoTranslator, spyLogger, type SpyLogger } from '../runtime';

/**
 * Translator stub that appends the interpolation params, so a test can
 * assert a placeholder was actually supplied a value. `separator`
 * exists because different suites already assert against `:` or `|`.
 */
export const echoTranslatorWithParams = (separator = ':'): Translator => ({
  ...echoTranslator(),
  t: (key, params) => (params === undefined ? key : `${key}${separator}${JSON.stringify(params)}`),
});

/**
 * Build a `BaseBot` stand-in carrying `fields` plus a default echo
 * translator and a spy logger.
 *
 * `fields` is deliberately an open record: the point of the fixture is
 * to satisfy whatever narrow slice of `BaseBot` a handler reads, and
 * pinning it to `Partial<BaseBot>` would demand real `discord.js`
 * values the stubs neither have nor need. Pass `translator` to override
 * the default; the logger is always the returned spy.
 */
export const buildFakeBot = (
  fields: Readonly<Record<string, unknown>> = {},
): { readonly bot: BaseBot; readonly logger: SpyLogger } => {
  const logger = spyLogger();
  return {
    logger,
    bot: {
      translator: echoTranslator(),
      ...fields,
      logger,
      requireLogger: () => logger,
    } as unknown as BaseBot,
  };
};
