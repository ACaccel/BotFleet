/**
 * CI shell-safety scanner.
 *
 * GitHub Actions runs `run:` steps with `bash -e` but **not**
 * `pipefail`, so the exit status of `a | b` is `b`'s. A gate written as
 * `npm run security ... | tee report.json` therefore reports success no
 * matter what `npm run security` found. Every piped `run:` step must set
 * `pipefail` explicitly; this test is the enforcement.
 *
 * Composite actions are scanned too — they run shell on the same
 * runner, and a pipe added there would be just as invisible.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

interface RunStep {
  readonly file: string;
  readonly line: number;
  readonly body: string;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every YAML file under `.github` that can carry a `run:` step.
 */
const collectYamlFiles = (): readonly string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.yml') || full.endsWith('.yaml')) {
        out.push(full);
      }
    }
  };
  walk(WORKFLOW_DIR);
  walk(ACTIONS_DIR);
  return out;
};

/**
 * Extract every `run:` step body from a YAML file. Handles the inline
 * form (`run: cmd`), the block-scalar form (`run: |`), and both again
 * behind a sequence dash (`- run: …`), which is this repo's dominant
 * style.
 */
export const collectRunSteps = (file: string, source: string): readonly RunStep[] => {
  const lines = source.split('\n');
  const steps: RunStep[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(line);
    if (match === null) continue;
    // A dash makes the `run:` key start further right; the block-scalar
    // body is indented relative to the key, not to the dash.
    const keyIndent = (match[1] ?? '').length + (match[2] ?? '').length;
    const inline = (match[3] ?? '').trim();
    if (!inline.startsWith('|') && !inline.startsWith('>')) {
      steps.push({ file, line: i + 1, body: inline });
      continue;
    }
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      if (next.trim().length === 0) {
        bodyLines.push('');
        continue;
      }
      if (indentOf(next) <= keyIndent) break;
      bodyLines.push(next);
    }
    steps.push({ file, line: i + 1, body: bodyLines.join('\n') });
  }
  return steps;
};

/**
 * Drop shell comments. Only a `#` at the start of a line or preceded by
 * whitespace opens one, so a `#fragment` inside a URL survives.
 */
const stripComments = (body: string): string =>
  body
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

/** True when `body` pipes one command into another (`||` does not count). */
export const hasShellPipe = (body: string): boolean =>
  stripComments(body)
    .split('\n')
    .some((l) => /(?<!\|)\|(?!\|)/.test(l));

describe('GitHub Actions shell steps', () => {
  const files = collectYamlFiles();

  it('finds both the workflows and the composite actions', () => {
    const names = files.map((f) => relative(REPO_ROOT, f));
    expect(names.some((n) => n.includes('workflows'))).toBe(true);
    expect(names.some((n) => n.includes('actions'))).toBe(true);
  });

  it('sets pipefail in every piped run step', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      for (const step of collectRunSteps(rel, readFileSync(file, 'utf8'))) {
        if (!hasShellPipe(step.body)) continue;
        // Checked against the comment-stripped body so a comment merely
        // mentioning pipefail does not satisfy the gate.
        if (/pipefail/.test(stripComments(step.body))) continue;
        offenders.push(`${step.file}:${step.line}`);
      }
    }
    expect(
      offenders,
      'A piped `run:` step without `set -o pipefail` reports the exit status of the ' +
        'last command only, so the step passes even when the gate before the pipe failed.',
    ).toEqual([]);
  });
});

describe('the scanner itself', () => {
  it('sees the dash-inline step form this repo mostly uses', () => {
    const steps = collectRunSteps('probe.yml', '      - run: npm run security | tee report.json\n');
    expect(steps).toHaveLength(1);
    expect(hasShellPipe(steps[0]?.body ?? '')).toBe(true);
  });

  it('sees a dash block-scalar body', () => {
    const steps = collectRunSteps(
      'probe.yml',
      ['      - run: |', '          npm run security | tee report.json', '      - uses: foo'].join(
        '\n',
      ),
    );
    expect(steps).toHaveLength(1);
    expect(hasShellPipe(steps[0]?.body ?? '')).toBe(true);
  });

  it('sees the name-plus-run step form', () => {
    const steps = collectRunSteps('probe.yml', '        run: npm run security | tee report.json\n');
    expect(steps).toHaveLength(1);
    expect(hasShellPipe(steps[0]?.body ?? '')).toBe(true);
  });

  it('does not mistake a logical-or or a URL fragment for a pipeline', () => {
    expect(hasShellPipe('command_a || command_b')).toBe(false);
    expect(hasShellPipe("curl 'http://example.test/#frag'")).toBe(false);
  });

  it('still counts a pipeline that follows an inline comment', () => {
    expect(hasShellPipe("curl 'http://a.test/#frag' | tee out")).toBe(true);
  });
});
