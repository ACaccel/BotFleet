import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat config (ESLint v9). Lints the whole `src/`, `scripts/`, `test/`
 * and `tools/` trees (see the `lint` script). Stylistic rules are
 * `warn`; correctness and architecture rules — raw `process.env`
 * access, explicit `any`, import cycles, the IoC service-locator
 * guard, layer boundaries and raw MongoDB access — are `error`.
 */

/** The only `src/bot` modules a plugin may import; see the plugin block below. */
const BOT_IMPORT_MESSAGE =
  'Plugins may import only src/bot/tokens and src/bot/guild-registry from src/bot: not BaseBot, a personality composition root (src/bot/<name>/**) or another composition-root module. Resolve dependencies through the plugin context.';

/** IoC container imports; see the service-locator guard below. */
const IOC_IMPORTS = ['**/core/ioc', '**/core/ioc/*', '@core/ioc', '@core/ioc/*'];
const IOC_IMPORT_PATTERN = {
  group: IOC_IMPORTS,
  message:
    'IoC container imports are restricted to composition roots (src/bot/**) and tests. Receive dependencies via constructor parameters instead.',
};

/**
 * Import groups naming each application layer, for the layer-boundary rules
 * (docs/architecture.md, "Layers and boundaries"). Path aliases are listed
 * with the relative forms so neither spelling slips through.
 */
const LAYER_IMPORTS = {
  persistence: ['**/persistence', '**/persistence/**'],
  application: ['**/application', '**/application/**'],
  infra: ['**/infra', '**/infra/**'],
  handlers: ['**/handlers', '**/handlers/**', '@cmd', '@button', '@modal', '@select-menu'],
  plugins: ['**/plugins', '**/plugins/**', '@plugins'],
  bot: ['**/bot', '**/bot/**', '@bot'],
};
const layerImportPattern = (layers, message) => ({
  group: layers.flatMap((layer) => LAYER_IMPORTS[layer]),
  message,
});

/** `no-restricted-syntax` selectors that keep raw `process.env` reads in core/config. */
const PROCESS_ENV_SELECTORS = [
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
];
const RAW_COLLECTION_MESSAGE =
  'Raw MongoDB access belongs in a src/persistence repository; add a repository method instead.';
/** Driver collections by name (`connection.collection('archive_jobs')`, `db.collection(name)`). */
const RAW_COLLECTION_SELECTOR = {
  selector: "CallExpression[callee.property.name='collection']",
  message: RAW_COLLECTION_MESSAGE,
};
/** Mongoose models of a guild connection (`conn.models.ArchiveJob`). */
const GUILD_MODELS_SELECTOR = {
  selector:
    "MemberExpression[object.property.name='models'], MemberExpression[object.name='models']",
  message: RAW_COLLECTION_MESSAGE,
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '**/*.generated.ts',
      'src/bot/**/config.json',
      // Private operational backups may contain retired source files.
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
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SELECTORS],
    },
  },
  // Raw MongoDB access lives in `src/persistence/` repositories: no other
  // layer opens a collection by name.
  // `infra/mongo` owns connection setup and builds the typed model map.
  // ESLint replaces a rule's options per matching block, so these blocks
  // repeat the process.env selectors above.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/config/**', 'src/persistence/**', 'src/infra/mongo/**'],
    rules: {
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SELECTORS, RAW_COLLECTION_SELECTOR],
    },
  },
  // Handlers, plugins and application services do not reach guild models
  // either; `infra/llm` has unrelated SDK `models` members, so this
  // narrower selector applies to those layers only.
  {
    files: ['src/handlers/**/*.ts', 'src/plugins/**/*.ts', 'src/application/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...PROCESS_ENV_SELECTORS,
        RAW_COLLECTION_SELECTOR,
        GUILD_MODELS_SELECTOR,
      ],
    },
  },
  // Service-locator guard: the IoC container is a composition tool, not
  // an ambient lookup. Only composition roots (`src/bot/**`) and tests
  // may import it. Application / domain / interface / persistence / infra
  // layers receive dependencies via constructor parameters from their
  // composition root.
  //
  // Layer boundaries (docs/architecture.md, "Layers and boundaries") ride
  // in the same rule, because ESLint replaces a rule's options per
  // matching block rather than merging them:
  //   - core depends on nothing above it;
  //   - persistence depends only on core;
  //   - infra (adapters) depends only on core and persistence;
  //   - application (feature services shared by handlers and plugins)
  //     depends on core, persistence and infra, never on an entry layer or
  //     a composition root;
  //   - handlers may not import plugins (the reverse is the plugin block
  //     below), and take `BaseBot` as a type only.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            layerImportPattern(
              ['persistence', 'infra', 'application', 'handlers', 'plugins', 'bot'],
              'core is the innermost layer and may not import persistence, infra, application, handlers, plugins or bot.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/i18n/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [IOC_IMPORT_PATTERN] }],
    },
  },
  {
    files: ['src/persistence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            IOC_IMPORT_PATTERN,
            layerImportPattern(
              ['infra', 'application', 'handlers', 'plugins', 'bot'],
              'persistence depends only on core: connection contracts live in src/persistence/connection.ts, and infra builds them.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/infra/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            IOC_IMPORT_PATTERN,
            layerImportPattern(
              ['application', 'handlers', 'plugins', 'bot'],
              'infra holds adapters and depends only on core and persistence; feature services belong in src/application/.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            IOC_IMPORT_PATTERN,
            layerImportPattern(
              ['handlers', 'plugins', 'bot'],
              'application services may not import handlers, plugins or a composition root; declare a narrow port (see src/application/guild-lookup.ts) and let the caller pass its implementation.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/handlers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            IOC_IMPORT_PATTERN,
            layerImportPattern(
              ['plugins'],
              'Handlers must not import from the plugin layer; move code both need to src/application/.',
            ),
          ],
        },
      ],
      // Handlers receive `BaseBot` at dispatch; a value import would let a
      // handler reach into the composition root.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:@bot|(?:\\.\\./)+bot(?:/.*)?)$',
              allowTypeImports: true,
              message: 'Handlers may import BaseBot and other src/bot contracts as types only.',
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
  // Everything else in `src/bot` is off-limits: a personality root
  // assembles plugins, so a plugin importing one would close the loop, and
  // `BaseBot` is the handlers' host object. Kept as a separate block
  // (rather than merged with the layered service-locator guard above) so
  // the error messages can point plugin authors at the correct path.
  {
    files: ['src/plugins/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: IOC_IMPORTS,
              message:
                'Plugins must import TOKENS from src/bot/tokens, not core/ioc; the container itself is composition-root-only.',
            },
            {
              // Allow-list: `BaseBot`, a personality root and every other
              // composition-root module are off-limits. A gitignore negation
              // cannot re-admit a file under an excluded directory, so the two
              // contract modules are carved out by regex.
              regex: '^(?:@bot|(?:\\.\\./)+bot(?:/(?!(?:tokens|guild-registry)$).*)?)$',
              message: BOT_IMPORT_MESSAGE,
            },
            {
              // `handlers` and `plugins` are sibling layers (see
              // docs/architecture.md, "Layers and boundaries"); neither may
              // depend on the other. Shared adapters live in `infra/` and
              // shared feature services in `application/`; both layers may
              // import either.
              //
              // The `../` depths are spelled out so only the handler layer
              // matches, not a module named `handlers` inside a plugin.
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
              ],
              message:
                'Plugins must not import from the handler layer; move shared code to src/application/ or src/infra/.',
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
