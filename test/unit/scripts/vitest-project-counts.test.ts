import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestModule, Vitest } from 'vitest/node';

import ProjectCountsReporter, {
  countTestsByProject,
  OUTPUT_KEY,
} from '../../../scripts/vitest-project-counts';

const moduleOf = (project: string, tests: number): TestModule =>
  ({
    project: { name: project },
    children: {
      *allTests() {
        for (let index = 0; index < tests; index += 1) yield {};
      },
    },
  }) as unknown as TestModule;

const vitestWith = (root: string, outputFile: unknown): Vitest =>
  ({ config: { root, outputFile } }) as unknown as Vitest;

describe('vitest project counts reporter', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('sums collected tests per project, keeping empty modules visible', () => {
    expect(
      countTestsByProject([moduleOf('unit', 2), moduleOf('i18n', 0), moduleOf('unit', 3)]),
    ).toEqual({ unit: 5, i18n: 0 });
  });

  it('writes the counts to its named output file, relative to the root', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'project-counts-'));
    const reporter = new ProjectCountsReporter();
    reporter.onInit(vitestWith(dir, { [OUTPUT_KEY]: 'nested/counts.json' }));
    reporter.onTestRunEnd([moduleOf('tools', 1)]);
    expect(JSON.parse(readFileSync(path.join(dir, 'nested/counts.json'), 'utf8'))).toEqual({
      tools: 1,
    });
  });

  it('writes nothing without its own output file', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'project-counts-'));
    for (const outputFile of [undefined, 'report.json', { json: 'report.json' }]) {
      const reporter = new ProjectCountsReporter();
      reporter.onInit(vitestWith(dir, outputFile));
      reporter.onTestRunEnd([moduleOf('unit', 1)]);
    }
    expect(() => readFileSync(path.join(dir ?? '', 'report.json'))).toThrow();
  });
});
