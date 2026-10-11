import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

/**
 * The project ESLint config must block any `core/ioc` import and any
 * personality-composition-root or `BaseBot` import from inside
 * `src/plugins/**`, while admitting the two composition-root contract modules plugins
 * legitimately consume (`src/bot/tokens`, `src/bot/guild-registry`). We
 * exercise every side via ESLint's programmatic API against virtual
 * files that live under the real `src/plugins/` path (so the file-glob
 * match fires) without writing permanent violation fixtures into the
 * source tree.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'src/plugins/__fixture__/ioc-import-fixture.ts');
const RULE_ID = 'no-restricted-imports';
const IOC_SOURCE = `import { TOKENS } from '../../core/ioc';\nvoid TOKENS;\n`;
const PERSONALITY_SOURCE = `import { Nijika } from '../../bot/nijika/nijika';\nvoid Nijika;\n`;
const TOKENS_SOURCE = `import { TOKENS } from '../../bot/tokens';\nvoid TOKENS;\n`;
const GUILD_REGISTRY_SOURCE = `import type { GuildRegistry } from '../../bot/guild-registry';\nexport type R = GuildRegistry;\n`;
const BASE_BOT_SOURCE = `import type { BaseBot } from '../../bot';\nexport type B = BaseBot;\n`;

const createLinter = (): ESLint =>
  new ESLint({
    cwd: PROJECT_ROOT,
    overrideConfigFile: path.join(PROJECT_ROOT, 'eslint.config.mjs'),
  });

const restrictedMessages = async (source: string): Promise<readonly string[]> => {
  const eslint = createLinter();
  const results = await eslint.lintText(source, { filePath: FIXTURE_PATH });
  const result = results[0];
  if (!result) throw new Error('ESLint returned no result for the fixture');
  return result.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.message);
};

describe('plugin import-boundary ESLint rules', () => {
  it('flags a core/ioc import from inside src/plugins/**', async () => {
    const messages = await restrictedMessages(IOC_SOURCE);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/src\/bot\/tokens/);
    expect(messages[0]).toMatch(/core\/ioc/);
  });

  it('flags a personality composition-root import from inside src/plugins/**', async () => {
    const messages = await restrictedMessages(PERSONALITY_SOURCE);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/personality composition root/);
  });

  it('accepts the TOKENS import routed via src/bot/tokens', async () => {
    expect(await restrictedMessages(TOKENS_SOURCE)).toHaveLength(0);
  });

  it('accepts the GuildRegistry contract import', async () => {
    expect(await restrictedMessages(GUILD_REGISTRY_SOURCE)).toHaveLength(0);
  });

  it.each([
    ['the msg-archive personality root', '../../bot/msg-archive'],
    ['a composition-root module', '../../bot/guild-db-connector'],
    ['BaseBot by path', '../../bot'],
    ['BaseBot by alias', '@bot'],
  ])('flags %s: only tokens and guild-registry are allowed', async (_case, specifier) => {
    const messages = await restrictedMessages(
      `import type * as bot from '${specifier}';\nexport type B = typeof bot;\n`,
    );
    expect(messages).toEqual([expect.stringMatching(/may import only src\/bot\/tokens/)]);
  });

  it('flags a `BaseBot` import: plugins take dependencies from their context', async () => {
    // The interaction bodies that once bridged `BaseBot` into plugin code
    // now live in the handler layer, next to their `deps-from-bot.ts`.
    const messages = await restrictedMessages(BASE_BOT_SOURCE);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/BaseBot/);
  });
});
