import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

/**
 * The project ESLint config enforces the layer boundaries in
 * `docs/architecture.md`: core, persistence and infra depend on nothing
 * above them, application services reach no entry layer or composition
 * root, handlers never import plugins and take `BaseBot` as a type only,
 * and raw MongoDB access stays in persistence repositories. Each case
 * lints a virtual file under the real layer path, so the file-glob match
 * fires without a fixture in the source tree.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BOUNDARY_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  '@typescript-eslint/no-restricted-imports',
]);

const CORE = 'src/core/__fixture__/a.ts';
const PERSISTENCE = 'src/persistence/repositories/__fixture__.ts';
const INFRA = 'src/infra/__fixture__/a.ts';
const APPLICATION = 'src/application/__fixture__/a.ts';
const HANDLER = 'src/handlers/commands/__fixture__/a.ts';
const PLUGIN = 'src/plugins/__fixture__/a.ts';

const violations = async (file: string, source: string): Promise<readonly string[]> => {
  const eslint = new ESLint({
    cwd: PROJECT_ROOT,
    overrideConfigFile: path.join(PROJECT_ROOT, 'eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(source, { filePath: path.join(PROJECT_ROOT, file) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${file}`);
  return result.messages
    .filter((message) => message.ruleId !== null && BOUNDARY_RULES.has(message.ruleId))
    .map((message) => message.message);
};
const imports = (specifier: string): string =>
  `import type * as imported from '${specifier}';\nexport type T = typeof imported;\n`;

describe('layer-boundary ESLint rules', () => {
  it.each([
    [CORE, '../../persistence/repositories'],
    [CORE, '../../infra/mongo'],
    [CORE, '../../application/archive/control'],
    [CORE, '../../bot/tokens'],
    [PERSISTENCE, '../../infra/mongo/connection-manager'],
    [PERSISTENCE, '../../application/archive/control'],
    [PERSISTENCE, '../../plugins/activity'],
    [PERSISTENCE, '../../bot/tokens'],
    [INFRA, '../../application/archive/control'],
    [INFRA, '../../handlers/commands/command'],
    [INFRA, '../../plugins/activity'],
    [INFRA, '../../bot'],
    [INFRA, '../../bot/guild-registry'],
    [INFRA, '../../bot/tokens'],
    [APPLICATION, '../../handlers/commands/command'],
    [APPLICATION, '../../plugins/activity'],
    [APPLICATION, '../../bot/guild-registry'],
    [APPLICATION, '@bot'],
    [HANDLER, '../../../plugins/activity'],
    [HANDLER, '@plugins'],
    [PLUGIN, '../../handlers/commands/command'],
    [PLUGIN, '../../bot/msg-archive'],
    [PLUGIN, '../../bot/guild-db-connector'],
    [PLUGIN, '@core/ioc'],
    [APPLICATION, '@cmd'],
    [APPLICATION, '@plugins'],
  ])('flags %s importing %s', async (file, specifier) => {
    expect(await violations(file, imports(specifier))).not.toHaveLength(0);
  });

  it.each([
    [INFRA, '../../persistence/connection'],
    [APPLICATION, '../../infra/mongo'],
    [APPLICATION, '../../persistence/repositories'],
    [APPLICATION, '../../core/errors'],
    [PERSISTENCE, '../connection'],
    [HANDLER, '../../../application/archive/control'],
    [HANDLER, '../../../infra/discord/options'],
    [PLUGIN, '../../application/activity/activity'],
    [PLUGIN, '../../bot/guild-registry'],
  ])('admits %s importing %s', async (file, specifier) => {
    expect(await violations(file, imports(specifier))).toHaveLength(0);
  });

  it.each([PERSISTENCE, INFRA, APPLICATION, HANDLER])(
    'keeps the IoC container out of %s',
    async (file) => {
      const messages = await violations(file, imports('@core/ioc'));
      expect(messages).toEqual([expect.stringMatching(/IoC container/)]);
    },
  );

  it('admits other src/bot contracts in handlers as types only', async () => {
    expect(
      await violations(
        HANDLER,
        "import { TOKENS } from '../../../bot/tokens';\nexport const T = TOKENS;\n",
      ),
    ).toEqual([expect.stringMatching(/as types only/)]);
  });

  it('admits BaseBot in handlers as a type only', async () => {
    expect(
      await violations(HANDLER, "import type { BaseBot } from '@bot';\nexport type B = BaseBot;\n"),
    ).toHaveLength(0);
    expect(
      await violations(HANDLER, "import { BaseBot } from '@bot';\nexport const B = BaseBot;\n"),
    ).toEqual([expect.stringMatching(/as types only/)]);
  });

  it.each([INFRA, APPLICATION, HANDLER, PLUGIN])(
    'keeps named driver collections out of %s',
    async (file) => {
      const source =
        "export const jobs = (c: { collection: (name: string) => unknown }) => c.collection('archive_jobs');\n";
      expect(await violations(file, source)).toEqual([
        expect.stringMatching(/src\/persistence repository/),
      ]);
    },
  );

  it('admits named driver collections in persistence', async () => {
    const source =
      "export const jobs = (c: { collection: (name: string) => unknown }) => c.collection('archive_jobs');\n";
    expect(await violations(PERSISTENCE, source)).toHaveLength(0);
  });

  it.each([APPLICATION, HANDLER, PLUGIN])('keeps guild models out of %s', async (file) => {
    const source =
      'export const jobs = (conn: { models: { ArchiveJob: unknown } }) => conn.models.ArchiveJob;\n';
    expect(await violations(file, source)).not.toHaveLength(0);
  });
});
