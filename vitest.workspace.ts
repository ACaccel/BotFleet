import { defineWorkspace } from 'vitest/config';
import path from 'path';

/**
 * Vitest workspace — defines six independent projects (unit,
 * integration, integration-nodb, contract, i18n, tools). Each project's
 * include glob is the ground truth for what files it picks up; the
 * corresponding npm run script (`test:unit`, `test:int`, `test:contract`,
 * `test:i18n`, `test:tools`) selects via `--project <name>`.
 *
 * CI runs the integration and contract projects with `--reporter=json`
 * and fails the build if `numTotalTestSuites` is zero, catching a
 * broken project glob that would otherwise pass silently.
 *
 * `globalSetup` for the `integration` project owns the
 * mongodb-memory-server lifecycle. `integration-nodb` holds the
 * integration suites that bind a real TCP port but touch no database:
 * they get their own project so a memory-server failure cannot fail
 * tests that never needed a database, and so they run in parallel
 * instead of paying the Mongo suite's single-fork serialisation.
 */
/**
 * Path aliases mirrored from `tsconfig.json` so handler-layer unit
 * tests can import the handler barrels (which carry `@bot` / `@cmd` /
 * `handlers` imports).
 */
/**
 * Force the bootstrap logger's file sink off for every test process.
 * `createBootstrapLogger` (in `src/core/config/`) reads `LOG_DIR` at
 * call time and disables the file router when the value is empty; this
 * keeps integration tests that spin up `BaseBot` from writing a real
 * `logs/<botId>/<date>.log` tree into the working directory.
 */
const testEnv = { LOG_DIR: '' } as const;

const aliases = {
  '@core': path.resolve(__dirname, 'src/core'),
  '@bot': path.resolve(__dirname, 'src/bot/index'),
  '@cmd': path.resolve(__dirname, 'src/handlers/commands/index'),
  '@button': path.resolve(__dirname, 'src/handlers/buttons/index'),
  '@select-menu': path.resolve(__dirname, 'src/handlers/select-menus/index'),
  '@modal': path.resolve(__dirname, 'src/handlers/modals/index'),
  '@reaction': path.resolve(__dirname, 'src/handlers/reactions/index'),
  '@plugins': path.resolve(__dirname, 'src/plugins/index'),
  handlers: path.resolve(__dirname, 'src/handlers/index'),
};

/**
 * Per-test timeout ceiling. The 5s default is marginal for the heavy
 * unit tests that run ESLint (`plugin-ioc-import-rule`) or the handler
 * codegen (`gen-registry`) inline; under vite 7's cold transform they
 * cross 5s in the full parallel suite (they pass in ~2s in isolation).
 * 20s gives headroom without masking a real hang.
 */
const TEST_TIMEOUT_MS = 20000;

/**
 * Integration suites that need no database. Listed once and used both
 * as the `integration-nodb` include and the `integration` exclude, so
 * the two projects cannot drift into overlapping or dropping a file.
 */
const NO_DB_INTEGRATION = [
  'test/integration/core/http/**/*.test.ts',
  'test/integration/plugins/earthquake-route.int.test.ts',
  'test/integration/plugins/settings-api-route.int.test.ts',
];

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['test/unit/**/*.test.ts'],
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
    },
    resolve: { alias: aliases },
  },
  {
    test: {
      name: 'integration-nodb',
      include: NO_DB_INTEGRATION,
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
    },
    resolve: { alias: aliases },
  },
  {
    test: {
      name: 'integration',
      include: ['test/integration/**/*.test.ts'],
      exclude: NO_DB_INTEGRATION,
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
      globalSetup: ['./test/integration/setup.ts'],
      // The integration project shares one mongodb-memory-server
      // (started by globalSetup). Parallel test files race on the
      // same database — `dropDatabase` collides with concurrent
      // index builds on adjacent files. Single-fork keeps the suite
      // under a few seconds while serialising file execution.
      // **Contract**: every integration `it()` must wrap its body in
      // `withFreshConnection` from `test/integration/helpers/mongo.ts`
      // — that helper is what provides per-test isolation. State
      // leaks silently between cases if you skip it.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
    resolve: { alias: aliases },
  },
  {
    test: {
      name: 'contract',
      include: ['test/contract/**/*.test.ts'],
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
    },
    resolve: { alias: aliases },
  },
  {
    test: {
      name: 'i18n',
      include: ['test/i18n/**/*.test.ts'],
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
    },
    resolve: { alias: aliases },
  },
  // `tools` project covers the unit tests that live next to the ops
  // scripts under `tools/<name>/*.test.ts`. Aliases are mirrored so
  // the helpers can import `@core/*` for shared error types.
  {
    test: {
      name: 'tools',
      include: ['tools/**/*.test.ts'],
      environment: 'node',
      env: testEnv,
      testTimeout: TEST_TIMEOUT_MS,
    },
    resolve: { alias: aliases },
  },
]);
