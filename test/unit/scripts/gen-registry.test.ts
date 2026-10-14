import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { quoteKey } from '../../../scripts/gen-registry';

/**
 * Handler codegen logic the `handlers:gen:check` gate cannot cover.
 *
 * Drift between the committed registries and the handler layout is the
 * gate's job (CI and pre-push run it as a byte diff against fresh
 * output); this suite covers key quoting and an independent entry-count
 * parity check.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const REGISTRY_FILES = [
  'src/handlers/commands/registry.generated.ts',
  'src/handlers/buttons/registry.generated.ts',
  'src/handlers/modals/registry.generated.ts',
  'src/handlers/select-menus/registry.generated.ts',
] as const;

describe('handlers codegen', () => {
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
