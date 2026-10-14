import type { TestProjectConfiguration } from 'vitest/config';
import path from 'path';

/**
 * Vitest projects — six independent projects (unit,
 * integration, integration-nodb, contract, i18n, tools). Each project's
 * include glob is the ground truth for what files it picks up; the
 * corresponding npm run script (`test:unit`, `test:int`, `test:contract`,
 * `test:i18n`, `test:tools`) selects via `--project <name>`.
 *
 * CI runs `vitest list --json` and fails unless every project lists at
 * least one test, catching a broken project glob that would otherwise
 * pass silently (see `.github/workflows/ci.yml`).
 *
 * `globalSetup` for the `integration` project owns the
 * mongodb-memory-server lifecycle. `integration-nodb` holds the
 * integration suites that bind a real TCP port but touch no database:
 * they get their own project so a memory-server failure cannot fail
 * tests that never needed a database.
 */
/**
 * Path aliases mirrored from `tsconfig.json` so handler-layer unit
 * tests can import the handler barrels (which carry `@bot` / `@cmd` /
 * `handlers` imports).
 */
/**
 * Environment for every test process, read by `createBootstrapLogger`
 * (in `src/core/config/`) at call time.
 *
 * - `LOG_DIR: ''` turns the file sink off, so tests that spin up
 *   `BaseBot` do not write a real `logs/<botId>/<date>.log` tree into
 *   the working directory.
 * - `LOG_LEVEL: 'fatal'` keeps the console logs of bots booted by tests
 *   out of the test output. It is the quietest level the typed Env
 *   schema accepts, so tests that load the Env from `process.env` still
 *   validate. Tests that assert on log lines inject their own logger.
 */
const testEnv = { LOG_DIR: '', LOG_LEVEL: 'fatal' } as const;

const aliases = {
  '@core': path.resolve(__dirname, 'src/core'),
  '@bot': path.resolve(__dirname, 'src/bot/index'),
  '@cmd': path.resolve(__dirname, 'src/handlers/commands/index'),
  '@button': path.resolve(__dirname, 'src/handlers/buttons/index'),
  '@select-menu': path.resolve(__dirname, 'src/handlers/select-menus/index'),
  '@modal': path.resolve(__dirname, 'src/handlers/modals/index'),
  '@plugins': path.resolve(__dirname, 'src/plugins/index'),
  handlers: path.resolve(__dirname, 'src/handlers/index'),
};

/**
 * Per-test timeout ceiling. The 5s default is marginal for the heavy
 * unit tests that run ESLint inline (`test/unit/eslint/`); under vite
 * 7's cold transform they can cross 5s in the full parallel suite
 * (they pass in about 1s in isolation). 20s gives headroom without
 * masking a real hang.
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

export const projects: TestProjectConfiguration[] = [
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
      // Test files run in parallel forks against the one
      // mongodb-memory-server started by globalSetup. **Contract**:
      // every integration `it()` that touches the database must reach
      // it through `test/integration/helpers/mongo.ts` —
      // `withFreshConnection`, or `withClosedConnection` for the
      // closed-connection error path. Each call gets its own uniquely
      // named database, dropped afterwards; that is the only thing
      // keeping parallel files and sequential cases apart. A test that
      // needs another database (the production `MongoConnectionManager`
      // names databases after guild ids) must use unique names and
      // drop what it creates; one that needs server-wide state (fail
      // points) must start its own server.
      pool: 'forks',
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
];
