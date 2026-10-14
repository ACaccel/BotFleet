import { defineConfig } from 'vitest/config';

import { projects } from './vitest.projects';

/**
 * Root Vitest config — coverage settings plus the project list. The
 * project layout (unit / integration / contract / i18n / tools) lives
 * in `vitest.projects.ts`. npm scripts pick a project via `--project`.
 *
 * Coverage thresholds:
 *   - `src/core/**` carries a higher floor; core is pure
 *     infrastructure and is kept well-covered.
 *   - Every floor sits about one point under the measured value, so
 *     ordinary churn does not trip it but a real regression does.
 *     Every handler entry point is in the denominator (see `exclude`
 *     below).
 *
 * Raise the floors when a batch of tests lifts the measurement — the
 * point of a ratchet is that it only moves one way.
 */
export default defineConfig({
  test: {
    projects,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Only pure re-export barrels and generated files are outside the
      // denominator. A blanket `src/**/index.ts` also removed every
      // handler entry point — thousands of lines of real branching —
      // from the measurement, which is exactly the code the floors are
      // supposed to hold.
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.generated.ts',
        'src/core/index.ts',
        'src/core/*/index.ts',
        'src/infra/*/index.ts',
        'src/persistence/index.ts',
        'src/plugins/index.ts',
        'src/plugins/*/index.ts',
        'src/plugins/*/internal/index.ts',
      ],
      thresholds: {
        lines: 93,
        functions: 94,
        branches: 90,
        statements: 93,
        'src/core/**': {
          lines: 96,
          functions: 96,
          branches: 92,
          statements: 96,
        },
      },
    },
  },
});
