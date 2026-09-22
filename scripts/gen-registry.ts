#!/usr/bin/env ts-node
/**
 * Codegen for handler registries.
 *
 * Replaces the previous runtime `fs.readdirSync + require()` pattern in
 * `HandlerFactory.register()` with statically-imported, type-checked
 * registry files generated from the on-disk handler layout.
 *
 * Usage:
 *   npm run handlers:gen           # write registry.generated.ts files
 *   npm run handlers:gen:check     # CI mode: fail if generated content is stale
 *
 * Determinism contract (so CI `--check` is meaningful):
 *   - Entries sorted by directory name (ASCII).
 *   - LF line endings, trailing newline.
 *   - Fixed AUTO-GENERATED header.
 *   - Single-quote strings, no trailing whitespace.
 *
 * Adding a handler:
 *   1. drop a new `<name>/index.ts` with `export default class … extends X`
 *   2. run `npm run handlers:gen`
 *   3. commit the regenerated registry alongside the new handler file
 *
 * Renaming or moving handler files keeps the registry in sync via the
 * same regeneration step; the CI check (`npm run handlers:gen:check`) ensures
 * a forgotten regeneration fails the build instead of shipping a stale
 * registry.
 */
import * as fs from 'fs';
import * as path from 'path';

interface RegistryTarget {
  /** Directory holding handler subdirectories, relative to repo root. */
  readonly dir: string;
  /** Module path used in the `import` of the abstract handler type. */
  readonly typeImportPath: string;
  /** Name of the abstract handler type. */
  readonly typeName: string;
  /** Name of the exported registry object. */
  readonly exportName: string;
}

const TARGETS: readonly RegistryTarget[] = [
  {
    dir: 'src/handlers/commands',
    typeImportPath: '.',
    typeName: 'Command',
    exportName: 'COMMAND_REGISTRY',
  },
  {
    dir: 'src/handlers/buttons',
    typeImportPath: '.',
    typeName: 'ButtonHandler',
    exportName: 'BUTTON_REGISTRY',
  },
  {
    dir: 'src/handlers/modals',
    typeImportPath: '.',
    typeName: 'ModalHandler',
    exportName: 'MODAL_REGISTRY',
  },
  {
    dir: 'src/handlers/select-menus',
    typeImportPath: '.',
    typeName: 'SSMHandler',
    exportName: 'SSM_REGISTRY',
  },
  {
    dir: 'src/handlers/reactions',
    typeImportPath: '.',
    typeName: 'ReactionHandler',
    exportName: 'REACTION_REGISTRY',
  },
];

interface HandlerEntry {
  /** Subdirectory name == registry key. */
  readonly name: string;
  /** Relative import path from the generated file (e.g. `'./give_score'`). */
  readonly importPath: string;
}

interface CliOptions {
  readonly check: boolean;
}

const parseArgs = (argv: readonly string[]): CliOptions => ({ check: argv.includes('--check') });

const GENERATED_FILE_NAME = 'registry.generated.ts';
const HEADER = `// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run \`npm run handlers:gen\` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// \`npm run handlers:gen:check\`.
`;

const scanHandlers = (absDir: string): HandlerEntry[] => {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const handlers: HandlerEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(absDir, entry.name, 'index.ts');
    if (!fs.existsSync(indexPath)) continue;
    handlers.push({ name: entry.name, importPath: `./${entry.name}` });
  }
  // ASCII sort for deterministic output.
  handlers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return handlers;
};

const renderRegistry = (target: RegistryTarget, handlers: readonly HandlerEntry[]): string => {
  const imports = handlers
    .map((h, i) => `import { default as Handler_${i} } from '${h.importPath}';`)
    .join('\n');

  const ctorType = `new () => ${target.typeName}`;
  const body =
    handlers.length === 0
      ? `export const ${target.exportName} = {} as const satisfies Readonly<Record<string, ${ctorType}>>;`
      : `export const ${target.exportName} = {
${handlers.map((h, i) => `  ${quoteKey(h.name)}: Handler_${i},`).join('\n')}
} as const satisfies Readonly<Record<string, ${ctorType}>>;`;

  const pieces = [HEADER, `import type { ${target.typeName} } from '${target.typeImportPath}';`];
  if (imports.length > 0) pieces.push(imports);
  pieces.push(body, '');
  return pieces.join('\n');
};

/**
 * Quote an object key if it is not a valid bare identifier. Handler
 * directory names are usually simple identifiers (`give_score`,
 * `ai_settings`) so this is rarely needed, but a kebab-case name
 * (`'role-message'`) requires a quoted key and the codegen handles it.
 *
 * Escape order matters: backslashes are escaped first so the second
 * pass's literal `\'` is not re-doubled. Catching both ensures a key
 * containing either character emits a valid TypeScript string literal
 * (CodeQL js/incomplete-sanitization).
 */
export const quoteKey = (key: string): string => {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return key;
  const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
};

const main = async (): Promise<void> => {
  const { check } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');

  let staleCount = 0;
  for (const target of TARGETS) {
    const absDir = path.join(repoRoot, target.dir);
    if (!fs.existsSync(absDir)) {
      process.stderr.write(
        `[gen-registry] ${target.dir} does not exist; skipping ${target.exportName}\n`,
      );
      continue;
    }
    const handlers = scanHandlers(absDir);
    const generated = renderRegistry(target, handlers);
    const outPath = path.join(absDir, GENERATED_FILE_NAME);

    if (check) {
      const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
      if (current !== generated) {
        staleCount += 1;
        process.stderr.write(
          `[gen-registry] STALE: ${target.dir}/${GENERATED_FILE_NAME} — run \`npm run handlers:gen\` and commit.\n`,
        );
      } else {
        process.stdout.write(
          `[gen-registry] OK:    ${target.dir}/${GENERATED_FILE_NAME} (${handlers.length} entries)\n`,
        );
      }
    } else {
      fs.writeFileSync(outPath, generated, 'utf8');
      process.stdout.write(
        `[gen-registry] wrote: ${target.dir}/${GENERATED_FILE_NAME} (${handlers.length} entries)\n`,
      );
    }
  }

  if (check && staleCount > 0) {
    process.stderr.write(`[gen-registry] ${staleCount} registry file(s) are stale.\n`);
    process.exitCode = 1;
    process.exit(1);
  }
};

// Avoid running the CLI when imported by a test runner — the test only
// needs the exported helpers above.
if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gen-registry] ${message}\n`);
    process.exit(1);
  });
}
