// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ReactionHandler } from '.';
export const REACTION_REGISTRY = {} as const satisfies Readonly<Record<string, new () => ReactionHandler>>;
