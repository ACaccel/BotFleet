import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat config (ESLint v9). Lints the whole `src/`, `scripts/`, `test/`
 * and `tools/` trees (see the `lint` script). Stylistic rules are
 * `warn`; correctness and architecture rules — raw `process.env`
 * access, explicit `any`, import cycles, and the IoC service-locator
 * guard — are `error`.
 */

/**
 * Shared message for a plugin-layer import that reaches into a
 * personality composition root.
 */
const PERSONALITY_IMPORT_MESSAGE =
  'Plugins must not import a personality composition root (src/bot/<name>/**). The contracts a plugin may consume are src/bot/tokens and src/bot/guild-registry.';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '**/*.generated.ts',
      'src/bot/**/config.json',
      // Private operational backups may contain retired source files.
      'tools/db/backups/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      // All `import` statements must form a single contiguous block at
      // the top of the file — no module-level code wedged between import
      // groups.
      'import/first': 'error',
      // `console.*` is banned outside the test / scripts override
      // below. `console.error` is permitted as a last-resort fallback
      // for the deploy CLI's top-level catch and any future site where
      // the structured logger itself is unavailable; every such call
      // site must carry a `// last-resort` comment.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  // Every exported function in `src/` names its return type.
  //
  // `tsconfig.build.json` emits declarations, but tsc only complains
  // when an inferred type is unnameable — a wrong-but-nameable inferred
  // return still ships. This rule is what actually holds the public
  // surface: a signature change becomes a compile error at the call
  // site instead of silently widening. Tests and scripts are exempt;
  // their exports are not a contract.
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  // Hard rule: only src/core/config may read process.env directly.
  // Everywhere else must import the typed Env from `core/config`.
  // `tools/` is in scope too: an ops CLI reaching for a raw env var is
  // the same defect, and the two legitimate writes (forcing `LOG_DIR`
  // empty to keep a one-shot tool out of the bot's log tree) carry an
  // explanatory inline disable.
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'tools/**/*.ts'],
    ignores: ['src/core/config/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Direct process.env access is banned. Import the typed Env from "@core/config" / "src/core/config" instead.',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Direct process.env access is banned. Import the typed Env from "@core/config" / "src/core/config" instead.',
        },
      ],
    },
  },
  // Service-locator guard: the IoC container is a composition tool, not
  // an ambient lookup. Only composition roots (`src/bot/**`) and tests
  // may import it. Application / domain / interface / persistence / infra
  // layers receive dependencies via constructor parameters from their
  // composition root.
  {
    files: [
      'src/application/**/*.ts',
      'src/domain/**/*.ts',
      'src/i18n/**/*.ts',
      'src/persistence/**/*.ts',
      'src/infra/**/*.ts',
      'src/handlers/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/ioc', '**/core/ioc/*', '@core/ioc', '@core/ioc/*'],
              message:
                'IoC container imports are restricted to composition roots (src/bot/**) and tests. Receive dependencies via constructor parameters instead.',
            },
          ],
        },
      ],
    },
  },
  // Plugin layer: the IoC container's write side is a composition-root
  // privilege, so `core/ioc` is unreachable from here. Plugins take
  // `TOKENS` from `src/bot/tokens` and the per-guild lookup port from
  // `src/bot/guild-registry` — both live with the composition root
  // because they name concrete `infra` / `persistence` types, which
  // `core/` may not depend on.
  //
  // A personality composition root (`src/bot/<name>/**`) is off-limits:
  // it assembles plugins, so a plugin importing one would close the
  // loop. Kept as a separate block (rather than merged with the layered
  // service-locator guard above) so the error messages can point plugin
  // authors at the correct alternative path.
  {
    files: ['src/plugins/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/ioc', '**/core/ioc/*', '@core/ioc', '@core/ioc/*'],
              message:
                'Plugins must import TOKENS from src/bot/tokens, not core/ioc; the container itself is composition-root-only.',
            },
            {
              group: ['**/bot/*/*'],
              message: PERSONALITY_IMPORT_MESSAGE,
            },
            {
              // `handlers` and `plugins` are sibling layers (see
              // docs/architecture.md §1); neither may depend on the
              // other. Shared Discord-boundary utilities — option
              // reading, error-to-reply mapping, the bounded HTTP
              // client — live in `infra/`, which both may import.
              //
              // The `../` depths are spelled out so a plugin's own
              // sibling `./handlers.ts` (the interaction bodies a
              // plugin legitimately owns) is not caught.
              group: [
                '../handlers',
                '../handlers/**',
                '../../handlers',
                '../../handlers/**',
                '../../../handlers',
                '../../../handlers/**',
                '../../../../handlers',
                '../../../../handlers/**',
                '@cmd',
                '@button',
                '@modal',
                '@select-menu',
                '@reaction',
              ],
              message:
                'Plugins must not import from the handler layer; use the shared utilities in src/infra/ instead.',
            },
          ],
        },
      ],
    },
  },
  // Handler index files must stay readable. Cap any file under
  // src/handlers/**/*.ts at 150 visible lines (imports + JSDoc + blanks
  // included) to enforce the rule that pure helpers be split into
  // sibling kebab-case files. Discord I/O, permission checks, Translator
  // calls, and reply assembly stay in index.ts; everything else moves out.
  {
    files: ['src/handlers/**/*.ts'],
    ignores: [
      // Codegen artifact — one import per handler, naturally long.
      'src/handlers/**/registry.generated.ts',
      // Handler-framework base class + localizer (single function file);
      // revisit only when functional changes land.
      'src/handlers/commands/command.ts',
      // Shared Discord helpers used by many handlers. Follow-up: keep
      // until a refactor extracts cohesive sub-modules.
      'src/handlers/commands/discord-helpers.ts',
    ],
    rules: {
      'max-lines': ['error', { max: 150, skipBlankLines: false, skipComments: false }],
    },
  },
  // Test files: relax some rules.
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
  prettier,
);
