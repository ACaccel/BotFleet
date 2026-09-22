// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ReactionHandler } from '.';
import { default as Handler_0 } from './roll_call';
export const REACTION_REGISTRY = {
  roll_call: Handler_0,
} as const satisfies Readonly<Record<string, new () => ReactionHandler>>;
