import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';

/**
 * Records how many tests each Vitest project collected, so CI can fail
 * on a project whose glob silently matches nothing without a second
 * collection pass. Write the counts by naming an output file:
 * `--reporter=./scripts/vitest-project-counts.ts --outputFile.project-counts=<path>`.
 */
export const OUTPUT_KEY = 'project-counts';

type ModuleLike = Pick<TestModule, 'project' | 'children'>;

export const countTestsByProject = (modules: readonly ModuleLike[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const module of modules) {
    const name = module.project.name;
    counts[name] = (counts[name] ?? 0) + [...module.children.allTests()].length;
  }
  return counts;
};

export default class ProjectCountsReporter implements Reporter {
  private outputFile: string | undefined;

  onInit(vitest: Vitest): void {
    const configured: unknown = vitest.config.outputFile;
    const file =
      configured !== null && typeof configured === 'object'
        ? (configured as Record<string, unknown>)[OUTPUT_KEY]
        : undefined;
    this.outputFile = typeof file === 'string' ? path.resolve(vitest.config.root, file) : undefined;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    if (this.outputFile === undefined) return;
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(countTestsByProject(modules))}\n`);
  }
}
