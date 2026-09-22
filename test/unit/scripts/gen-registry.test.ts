import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { quoteKey } from '../../../scripts/gen-registry';

/**
 * Codegen integrity smoke test.
 *
 * Runs `npm run handlers:gen:check` and asserts exit 0. If a developer adds
 * a handler subdirectory without regenerating the registry, this fails
 * before CI even sees the PR.
 *
 * Also verifies the generated files have the expected shape (header,
 * single registry export per file) so accidental edits to the codegen
 * template are caught.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const REGISTRY_FILES = [
  'src/handlers/commands/registry.generated.ts',
  'src/handlers/buttons/registry.generated.ts',
  'src/handlers/modals/registry.generated.ts',
  'src/handlers/select-menus/registry.generated.ts',
  'src/handlers/reactions/registry.generated.ts',
] as const;

describe('handlers codegen', () => {
  it('every committed registry.generated.ts matches the on-disk handler layout', () => {
    // Exit 0 means no drift; non-zero means a developer added/renamed a
    // handler dir without regenerating. Test surfaces it locally before CI.
    expect(() =>
      execSync('npm run handlers:gen:check', { cwd: REPO_ROOT, stdio: 'pipe' }),
    ).not.toThrow();
  });

  it.each(REGISTRY_FILES)('%s carries the AUTO-GENERATED header', (relPath) => {
    const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    expect(content.startsWith('// AUTO-GENERATED')).toBe(true);
  });

  it.each(REGISTRY_FILES)('%s exports exactly one registry constant', (relPath) => {
    const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    const matches = content.match(/export const \w+_REGISTRY/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  describe('quoteKey', () => {
    it.each([
      ['give_score', 'give_score'],
      ['ai_settings', 'ai_settings'],
      ['_private', '_private'],
      ['$dollar', '$dollar'],
    ])('returns the bare identifier %s unchanged', (input, expected) => {
      expect(quoteKey(input)).toBe(expected);
    });

    it.each([
      ['role-message', `'role-message'`],
      ['kebab-case-name', `'kebab-case-name'`],
      ['has space', `'has space'`],
      ['1leading-digit', `'1leading-digit'`],
    ])('quotes the non-identifier %s', (input, expected) => {
      expect(quoteKey(input)).toBe(expected);
    });

    it('escapes embedded single quotes', () => {
      expect(quoteKey("a'b")).toBe(String.raw`'a\'b'`);
    });

    it('escapes embedded backslashes before single quotes', () => {
      // Regression for CodeQL js/incomplete-sanitization.
      // The emitted literal, when evaluated as TypeScript, must yield
      // back exactly the original key.
      const original = String.raw`a\b'c`;
      const literal = quoteKey(original);
      expect(literal).toBe(String.raw`'a\\b\'c'`);
      // Round-trip sanity check — the literal evaluates back to the input.
      const evaluated = Function(`"use strict"; return (${literal});`)() as string;
      expect(evaluated).toBe(original);
    });
  });

  /**
   * Independent parity check: the number of imported handlers in each
   * generated registry must match the number of subdirectories that have
   * an `index.ts` on disk. This catches a class of bug the
   * `--check` script cannot — both the generator and the committed file
   * omitting the same directory would still pass `--check`.
   */
  it.each(REGISTRY_FILES)(
    '%s entry count matches the on-disk handler subdirectories',
    (relPath) => {
      const handlerDir = path.dirname(path.join(REPO_ROOT, relPath));
      const realCount = fs
        .readdirSync(handlerDir, { withFileTypes: true })
        .filter(
          (e) => e.isDirectory() && fs.existsSync(path.join(handlerDir, e.name, 'index.ts')),
        ).length;
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      const importedCount = (content.match(/^import \{ default as Handler_\d+ \} from /gm) ?? [])
        .length;
      expect(importedCount).toBe(realCount);
    },
  );
});
