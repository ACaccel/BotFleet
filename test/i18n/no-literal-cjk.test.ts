/**
 * CJK-literal scanner — enforces that every user-facing string in the
 * handler / plugin / bot layers flows through the translator
 * (`Translator.t`) rather than living as an inline literal. The scanner
 * is strict: any CJK literal in a scoped directory fails the suite.
 *
 * Whitelist mechanism: prefix the offending line with
 * `// i18n-ignore: <reason>` to silence the scanner. The reason is
 * required so future readers see WHY a literal stayed inline
 * (e.g. a command-builder default that Discord ignores anyway, or a
 * raw fragment that happens to contain CJK).
 *
 * Scope rationale:
 *   - `src/handlers/**` (commands / buttons / modals / SSMs / reactions),
 *     `src/plugins/**` and the feature services in `src/application/**`
 *     (panels, announcements) reach Discord users directly.
 *   - `src/infra/**` reaches users indirectly: an adapter that formats
 *     a string for a Discord reply (the LLM usage footer) must take the
 *     already-translated text from its caller rather than inline it.
 *   - `src/bot/**` (composition roots + bot subclasses) is scanned too:
 *     personalities route their help / presence text through translator
 *     keys (e.g. Nijika's `helpMessageKey`, Konata's
 *     `replies:konata.presence_text`). `src/bot/index.ts` BaseBot only
 *     emits ops-log lines that are deliberately English; if a future
 *     change reintroduces CJK there, the scanner catches it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Directories the scanner walks. Each entry is a path relative to
 * the repo root. Adding a directory here without a corresponding
 * catalog sweep WILL fail in strict mode — coordinate with the
 * migration PR.
 */
const SCOPED_DIRECTORIES: readonly string[] = [
  'src/handlers',
  'src/plugins',
  'src/application',
  'src/bot',
  'src/infra',
];

/**
 * Per-file allowlist. Use sparingly — every entry should carry a
 * comment explaining why the file genuinely cannot reach a translator
 * (e.g. data fixtures, or command-builder defaults Discord overrides
 * with `name_localizations`). Empty by default; reserved for
 * exceptional cases.
 */
const FILE_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Directory-level skip list. Entries here are subdirectories excluded
 * from the strict scanner. Empty by default; reserved for the rare
 * case where a subtree genuinely cannot route through the translator.
 */
const SKIP_PATH_PATTERNS: readonly RegExp[] = [];

// Ideographs, kana and hangul, plus the blocks a Taiwan-facing bot can
// realistically reach for: Bopomofo (U+3100–312F), Hangul Jamo
// (U+3130–318F), CJK Ext-A (U+3400–4DBF), compatibility ideographs
// (U+F900–FAFF), and the two punctuation blocks that carry CJK-only
// forms — U+3000–U+303F (、。「」) and U+FF00–U+FFEF (fullwidth ：！（）).
// Fullwidth punctuation reads as CJK copy to a user even when the
// surrounding words are Latin, so `Bug Report from X：${content}`
// belongs in the catalog too.
const CJK_REGEX =
  /[぀-ゟ゠-ヿ一-鿿가-힯\u3000-\u303f\u3100-\u318f\u3400-\u4dbf\uf900-\ufaff\uff00-\uffef]/;
// Require a non-empty reason after the colon so reviewers see WHY a
// literal stayed inline. The reason-less form `// i18n-ignore` is
// rejected on purpose — it defeats the audit trail this whitelist
// exists to preserve.
const IGNORE_LINE_PATTERN = /\/\/\s*i18n-ignore:\s*\S/;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const walk = (dir: string): readonly string[] => {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Skip lines that are pure comments. The scanner targets user-facing
 * string literals; CJK inside JSDoc / line comments is documentation
 * (e.g. an inline example of a reply's text) and is not part of the
 * translation contract. Tracking is line-based with a small
 * block-comment cursor so unbalanced `/* … *\/` does not leak.
 */
const isCommentLine = (line: string, inBlockComment: boolean): boolean => {
  const trimmed = line.trim();
  if (inBlockComment) return true; // already inside /* ... */
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
};

const scanFile = (filePath: string): readonly Violation[] => {
  const rel = path.relative(ROOT, filePath);
  if (FILE_ALLOWLIST.has(rel)) return [];
  // Normalise to forward-slash so the patterns match on Windows too;
  // the runtime separator does not affect the audit-intent regex.
  const normalised = rel.split(path.sep).join('/');
  if (SKIP_PATH_PATTERNS.some((re) => re.test(normalised))) return [];
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const violations: Violation[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    // Track block-comment state. A line that contains `/*` opens
    // (unless it also closes with `*/` on the same line); a line that
    // contains `*/` closes. This is heuristic — strings containing
    // `/*` would confuse it — but real-world callsites do not embed
    // those tokens in user-facing strings, and the cost of a false
    // skip is one extra `// i18n-ignore` annotation.
    const opensBlock = /\/\*/.test(line) && !/\*\//.test(line);
    const closesBlock = /\*\//.test(line);
    const wasInBlockComment = inBlockComment;
    if (opensBlock) inBlockComment = true;
    if (closesBlock) inBlockComment = false;

    if (!CJK_REGEX.test(line)) continue;
    if (IGNORE_LINE_PATTERN.test(line)) continue;
    if (isCommentLine(line, wasInBlockComment)) continue;
    // The previous-line ignore form: `// i18n-ignore: ...\n<violation>`.
    const prev = i > 0 ? (lines[i - 1] as string) : '';
    if (IGNORE_LINE_PATTERN.test(prev)) continue;
    violations.push({ file: rel, line: i + 1, text: line.trim() });
  }
  return violations;
};

const collectAllViolations = (): readonly Violation[] => {
  const out: Violation[] = [];
  for (const dir of SCOPED_DIRECTORIES) {
    for (const file of walk(path.join(ROOT, dir))) {
      out.push(...scanFile(file));
    }
  }
  return out;
};

describe('CJK-literal scanner', () => {
  it('reports zero CJK literals across the scoped directories', () => {
    const violations = collectAllViolations();
    expect(
      violations,
      `Expected zero CJK literals in ${SCOPED_DIRECTORIES.join(', ')}. ` +
        'Migrate each to a translator key in src/i18n/locales/zh-TW/ or ' +
        'annotate the line with "// i18n-ignore: <reason>".',
    ).toEqual([]);
  });
});
