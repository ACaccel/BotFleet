import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config — coverage / shared settings only. The project
 * layout (unit / integration / contract / i18n / tools) lives in
 * `vitest.workspace.ts`. npm scripts pick a project via `--project`.
 *
 * Coverage thresholds:
 *   - `src/core/**` carries a high floor (90% line / func / statement,
 *     89% branch); core is pure infrastructure and is kept
 *     well-covered.
 *   - The overall floors sit a couple of points under the measured
 *     value, so ordinary churn does not trip them but a real
 *     regression does. Every handler entry point is in the
 *     denominator (see `exclude` below); the still-untested query
 *     commands are what holds the line / statement floor below the
 *     branch and function ones.
 *
 * Raise the floors when a batch of tests lifts the measurement — the
 * point of a ratchet is that it only moves one way.
 */
export default defineConfig({
  test: {
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
        lines: 73,
        functions: 82,
        branches: 84,
        statements: 73,
        'src/core/**': {
          lines: 90,
          functions: 90,
          branches: 89,
          statements: 90,
        },
      },
    },
  },
});
