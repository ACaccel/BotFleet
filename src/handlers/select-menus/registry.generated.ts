// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { SSMHandler } from '.';
import { default as Handler_0 } from './delete_reply';
import { default as Handler_1 } from './giveaway_delete';
import { default as Handler_2 } from './help_category';
export const SSM_REGISTRY = {
  delete_reply: Handler_0,
  giveaway_delete: Handler_1,
  help_category: Handler_2,
} as const satisfies Readonly<Record<string, new () => SSMHandler>>;
